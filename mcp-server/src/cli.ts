#!/usr/bin/env node
/**
 * Thin CLI wrapper over the same daemon API the MCP server uses.
 *
 * Usage:
 *   research-book health
 *   research-book list-projects
 *   research-book select-project /abs/path
 *   research-book configure-llm --provider openai --model gpt-4o-mini --api-key sk-...
 *   research-book import-documents file1.pdf file2.md [--folder-context "spec drop"]
 *   research-book query "What did we decide about caching?" [--save-to-wiki]
 *   research-book lint [--semantic]
 *   research-book graph [--mode communities|neighbors|insights] [--page foo] [--limit 10]
 *   research-book review
 *   research-book read-page wiki/entities/openai.md
 *   research-book deep-research "GPU benchmarks for inference"
 *   research-book job-status [--id <jobId>]
 *
 * Designed for humans, not programmatic agents — agents should drive the MCP
 * server instead so they get typed tools and progress notifications.
 */

import { resolve } from "node:path"

import { ApiError, DaemonUnreachableError, WikiDaemonClient, type JobEvent } from "./client.js"

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[a.slice(2)] = next
          i++
        } else {
          out.flags[a.slice(2)] = true
        }
      }
    } else {
      out.positional.push(a)
    }
  }
  return out
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
}

async function streamJob(client: WikiDaemonClient, jobId: string): Promise<unknown> {
  process.stderr.write(`[job ${jobId}] starting…\n`)
  let last: JobEvent | null = null
  for await (const ev of client.streamJob(jobId)) {
    last = ev
    if (ev.kind === "comment") continue
    const detail = ev.data.detail ?? ev.data.status ?? ""
    if (detail) process.stderr.write(`[job ${jobId}] ${detail}\n`)
    if (ev.kind === "done") return ev.data.data
    if (ev.kind === "error") throw new Error(ev.data.error ?? detail)
  }
  return last?.data.data ?? null
}

const COMMANDS: Record<string, (client: WikiDaemonClient, args: ParsedArgs) => Promise<void>> = {
  async health(client) {
    printJson(await client.request("GET", "/api/health"))
  },

  async "list-templates"(client) {
    printJson(await client.request("GET", "/api/templates"))
  },

  async "list-projects"(client) {
    printJson(await client.request("GET", "/api/projects"))
  },

  async "create-project"(client, args) {
    const name = args.flags.name ?? args.positional[0]
    const path = args.flags.path ?? args.positional[1]
    const templateId = args.flags.template ?? args.flags["template-id"] ?? "general"
    if (!name || !path) {
      throw new Error("create-project requires --name and --path (or two positional args)")
    }
    printJson(
      await client.request("POST", "/api/projects", {
        body: { name, path: resolve(String(path)), templateId },
      }),
    )
  },

  async "open-project"(client, args) {
    const path = args.flags.path ?? args.positional[0]
    if (!path) throw new Error("open-project requires a path")
    printJson(
      await client.request("POST", "/api/projects/open", {
        body: { path: resolve(String(path)) },
      }),
    )
  },

  async "select-project"(client, args) {
    const path = args.flags.path ?? args.positional[0]
    if (!path) throw new Error("select-project requires a path")
    printJson(
      await client.request("POST", "/api/projects/select", {
        body: { path: resolve(String(path)) },
      }),
    )
  },

  async "configure-llm"(client, args) {
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args.flags)) {
      switch (k) {
        case "provider":
        case "model":
        case "api-key":
        case "ollama-url":
        case "custom-endpoint":
          body[camel(k)] = v
          break
        case "max-context-size":
          body.maxContextSize = Number(v)
          break
      }
    }
    printJson(await client.request("POST", "/api/config/llm", { body }))
  },

  async "configure-embedding"(client, args) {
    const body: Record<string, unknown> = {}
    if (args.flags.endpoint !== undefined) body.endpoint = args.flags.endpoint
    if (args.flags["api-key"] !== undefined) body.apiKey = args.flags["api-key"]
    if (args.flags.model !== undefined) body.model = args.flags.model
    if (args.flags.enabled !== undefined) body.enabled = args.flags.enabled !== "false"
    printJson(await client.request("POST", "/api/config/embedding", { body }))
  },

  async "configure-search"(client, args) {
    const provider = args.flags.provider ?? "tavily"
    const apiKey = args.flags["api-key"]
    const body: Record<string, unknown> = { provider }
    if (apiKey) body.apiKey = apiKey
    printJson(await client.request("POST", "/api/config/search", { body }))
  },

  async "import-documents"(client, args) {
    const paths = args.positional.map((p) => resolve(p))
    if (paths.length === 0) throw new Error("import-documents requires at least one file path")
    const folderContext = args.flags["folder-context"]
    const body: Record<string, unknown> = { paths }
    if (folderContext) body.folderContext = String(folderContext)
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    const initial = await client.request<{ jobId: string }>("POST", "/api/sources/import", {
      body,
    })
    process.stderr.write(`[import] copied ${paths.length} files; job ${initial.jobId}\n`)
    if (args.flags["no-wait"]) {
      printJson(initial)
      return
    }
    const result = await streamJob(client, initial.jobId)
    printJson({ jobId: initial.jobId, result })
  },

  async query(client, args) {
    const question = args.positional.join(" ").trim() || (args.flags.question as string)
    if (!question) throw new Error("query requires a question")
    const body: Record<string, unknown> = { question }
    if (args.flags["save-to-wiki"]) body.saveToWiki = true
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    if (args.flags["conversation-id"]) body.conversationId = args.flags["conversation-id"]
    const initial = await client.request<{ jobId: string }>("POST", "/api/query", { body })
    const result = await streamJob(client, initial.jobId)
    printJson({ jobId: initial.jobId, result })
  },

  async lint(client, args) {
    const body: Record<string, unknown> = {}
    if (args.flags.semantic) body.semantic = true
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    const initial = await client.request<{ jobId: string }>("POST", "/api/lint", { body })
    const result = await streamJob(client, initial.jobId)
    printJson({ jobId: initial.jobId, result })
  },

  async graph(client, args) {
    const query: Record<string, string> = {}
    if (args.flags.mode) query.mode = String(args.flags.mode)
    if (args.flags.page) query.page = String(args.flags.page)
    if (args.flags.limit) query.limit = String(args.flags.limit)
    const body: Record<string, unknown> = {}
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    printJson(await client.request("GET", "/api/graph", { body, query }))
  },

  async review(client, args) {
    const body: Record<string, unknown> = {}
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    printJson(await client.request("GET", "/api/review", { body }))
  },

  async "resolve-review-item"(client, args) {
    const id = args.flags.id ?? args.positional[0]
    const action = args.flags.action ?? args.positional[1]
    if (!id || !action) throw new Error("resolve-review-item requires --id and --action")
    printJson(
      await client.request("POST", "/api/review/resolve", {
        body: { id, action },
      }),
    )
  },

  async "list-pages"(client, args) {
    const body: Record<string, unknown> = {}
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    const query: Record<string, string> = {}
    if (args.flags.type) query.type = String(args.flags.type)
    printJson(await client.request("GET", "/api/wiki/pages", { body, query }))
  },

  async "read-page"(client, args) {
    const path = args.flags.path ?? args.positional[0]
    if (!path) throw new Error("read-page requires a project-relative path")
    const body: Record<string, unknown> = {}
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    const data = await client.request<{ content: string }>("GET", "/api/wiki/page", {
      body,
      query: { path: String(path) },
    })
    process.stdout.write(data.content + "\n")
  },

  async "deep-research"(client, args) {
    const topic = args.positional.join(" ").trim() || (args.flags.topic as string)
    if (!topic) throw new Error("deep-research requires a topic")
    const body: Record<string, unknown> = { topic }
    if (args.flags["project-path"]) body.projectPath = args.flags["project-path"]
    const initial = await client.request<{ jobId: string }>("POST", "/api/research", { body })
    const result = await streamJob(client, initial.jobId)
    printJson({ jobId: initial.jobId, result })
  },

  async "job-status"(client, args) {
    const id = args.flags.id ?? args.positional[0]
    const query: Record<string, string> = {}
    if (id) query.id = String(id)
    printJson(await client.request("GET", "/api/jobs", { query }))
  },

  async "cancel-job"(client, args) {
    const id = args.flags.id ?? args.positional[0]
    if (!id) throw new Error("cancel-job requires an id")
    printJson(await client.request("DELETE", "/api/jobs", { query: { id: String(id) } }))
  },
}

function camel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c) => (c as string).toUpperCase())
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(usage())
    return
  }
  const handler = COMMANDS[cmd]
  if (!handler) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${usage()}`)
    process.exit(2)
  }
  const client = new WikiDaemonClient()
  await handler(client, parseArgs(rest))
}

function usage(): string {
  const cmds = Object.keys(COMMANDS).sort().join("\n  ")
  return `research-book — CLI for the LLM Wiki desktop daemon\n\nUsage: research-book <command> [options]\n\nCommands:\n  ${cmds}\n\nDocs: see mcp-server/README.md\n`
}

main().catch((err) => {
  if (err instanceof DaemonUnreachableError) {
    process.stderr.write(`\n${err.message}\n\n  Is the LLM Wiki desktop app running?\n\n`)
    process.exit(3)
  }
  if (err instanceof ApiError) {
    process.stderr.write(`API ${err.status}: ${err.message}\n`)
    if (err.body) process.stderr.write(JSON.stringify(err.body, null, 2) + "\n")
    process.exit(err.status >= 400 && err.status < 500 ? 4 : 5)
  }
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
