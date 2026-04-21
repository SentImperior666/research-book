/**
 * Unit tests for the MCP server.
 *
 * Strategy: spin up an in-process fake daemon (HTTP + SSE) on an ephemeral
 * port, point the `WikiDaemonClient` at it, wire the resulting tools through
 * an in-memory MCP transport pair, and exercise each tool the way an MCP
 * client would. This covers the full Quick Start workflow without needing the
 * Tauri app running.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"

import { WikiDaemonClient } from "../client.js"
import { registerTools } from "../tools.js"

interface RecordedRequest {
  method: string
  url: string
  body: unknown
  authorization?: string
}

interface FakeDaemon {
  server: Server
  baseUrl: string
  requests: RecordedRequest[]
  /** Push a job event onto the queue keyed by job id. */
  emitJobEvent: (jobId: string, frame: string) => void
}

const TOKEN = "test-token-12345"

const AUTO_JOB_RESULTS: Record<string, { jobId: string; data: unknown }> = {
  "POST /api/query": {
    jobId: "job-query-1",
    data: { answer: "hi", references: [], savedPath: null, conversationId: "c1", question: "?" },
  },
  "POST /api/lint": {
    jobId: "job-lint-1",
    data: { structural: [], semantic: [], total: 0 },
  },
  "POST /api/research": {
    jobId: "job-research-1",
    data: { taskId: "t1", savedPath: null, synthesis: null, sources: [] },
  },
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const requests: RecordedRequest[] = []
  const sseSubscribers = new Map<string, ServerResponse[]>()
  // Buffer events emitted before any subscriber connects; drain on subscribe.
  const pendingEvents = new Map<string, string[]>()

  const server = createServer((req, res) => {
    const auth = req.headers.authorization
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const url = req.url ?? ""
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url,
        body: body ? safeJson(body) : null,
        authorization: typeof auth === "string" ? auth : undefined,
      }
      requests.push(recorded)

      if (auth !== `Bearer ${TOKEN}`) {
        return respond(res, 401, { error: "unauthorized" })
      }

      if (url.startsWith("/api/jobs/") && url.endsWith("/stream")) {
        const jobId = url.slice("/api/jobs/".length, url.length - "/stream".length)
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        res.write(": connected\n\n")
        const list = sseSubscribers.get(jobId) ?? []
        list.push(res)
        sseSubscribers.set(jobId, list)
        const pending = pendingEvents.get(jobId)
        if (pending && pending.length > 0) {
          for (const frame of pending) res.write(frame)
          pendingEvents.delete(jobId)
        }
        req.on("close", () => {
          const cur = sseSubscribers.get(jobId) ?? []
          sseSubscribers.set(
            jobId,
            cur.filter((r) => r !== res),
          )
        })
        return
      }

      const route = url.split("?")[0] ?? ""
      handleRoute(route, req.method ?? "GET", recorded.body, res)
      // For routes that return a jobId, auto-deliver a `done` event so tests
      // can subscribe and finish without manual orchestration.
      const autoJob = AUTO_JOB_RESULTS[`${req.method ?? "GET"} ${route}`]
      if (autoJob) {
        setImmediate(() => {
          const frame = `event: done\ndata: ${JSON.stringify({ jobId: autoJob.jobId, done: true, data: autoJob.data })}\n\n`
          emitJobEvent(autoJob.jobId, frame)
        })
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as AddressInfo).port

  function emitJobEvent(jobId: string, frame: string): void {
    const subs = sseSubscribers.get(jobId) ?? []
    if (subs.length === 0) {
      const pending = pendingEvents.get(jobId) ?? []
      pending.push(frame)
      pendingEvents.set(jobId, pending)
      return
    }
    for (const r of subs) r.write(frame)
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    emitJobEvent,
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function handleRoute(route: string, method: string, body: unknown, res: ServerResponse): void {
  // GET endpoints
  if (method === "GET") {
    switch (route) {
      case "/api/health":
        return respond(res, 200, { ok: true, version: "0.3.1", project: null, jobsRunning: 0 })
      case "/api/templates":
        return respond(res, 200, {
          templates: [
            { id: "general", name: "General", description: "A blank slate", icon: "book", extraDirs: [] },
          ],
        })
      case "/api/projects":
        return respond(res, 200, { projects: [], current: null })
      case "/api/sources":
        return respond(res, 200, { sources: [] })
      case "/api/wiki/index":
        return respond(res, 200, { path: "wiki/index.md", content: "# Index" })
      case "/api/wiki/pages":
        return respond(res, 200, { pages: [{ path: "wiki/foo.md", name: "foo.md" }] })
      case "/api/wiki/page":
        return respond(res, 200, { path: "wiki/foo.md", content: "# Foo" })
      case "/api/graph":
        return respond(res, 200, { mode: "communities", stats: { nodes: 1, edges: 0, communities: 0 }, communities: [], topNodes: [] })
      case "/api/review":
        return respond(res, 200, { items: [] })
      case "/api/jobs":
        return respond(res, 200, { jobs: [] })
      case "/api/config/llm":
        return respond(res, 200, { config: { provider: "openai", apiKey: "", model: "gpt-4o-mini" } })
      case "/api/config/embedding":
        return respond(res, 200, { config: { enabled: false } })
      case "/api/config/search":
        return respond(res, 200, { config: { provider: "none" } })
    }
  }

  if (method === "POST") {
    switch (route) {
      case "/api/projects":
        return respond(res, 200, { project: { name: (body as Record<string, unknown>).name, path: "/tmp/x" } })
      case "/api/projects/open":
      case "/api/projects/select":
        return respond(res, 200, { project: { name: "x", path: "/tmp/x" } })
      case "/api/config/llm":
        return respond(res, 200, { config: body })
      case "/api/config/embedding":
        return respond(res, 200, { config: body })
      case "/api/config/search":
        return respond(res, 200, { config: body })
      case "/api/sources/import":
        return respond(res, 200, { jobId: "job-import-1", copied: ["raw/sources/x.md"], taskIds: ["t1"] })
      case "/api/sources/delete":
        return respond(res, 200, { deleted: (body as Record<string, unknown>).path })
      case "/api/query":
        return respond(res, 200, { jobId: "job-query-1" })
      case "/api/lint":
        return respond(res, 200, { jobId: "job-lint-1" })
      case "/api/research":
        return respond(res, 200, { jobId: "job-research-1" })
      case "/api/review/resolve":
        return respond(res, 200, { id: (body as Record<string, unknown>).id, action: (body as Record<string, unknown>).action })
    }
  }

  if (method === "DELETE" && route === "/api/jobs") {
    return respond(res, 200, { cancelled: "x" })
  }

  respond(res, 404, { error: `no fake handler for ${method} ${route}` })
}

let daemon: FakeDaemon
let client: Client
let mcp: McpServer

beforeAll(async () => {
  daemon = await startFakeDaemon()
  process.env.LLM_WIKI_API_TOKEN = TOKEN
  process.env.LLM_WIKI_API_URL = daemon.baseUrl

  mcp = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  )
  registerTools(mcp, new WikiDaemonClient({ baseUrl: daemon.baseUrl, token: TOKEN }))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
})

afterAll(async () => {
  await client.close()
  await mcp.close()
  await new Promise<void>((resolve, reject) => daemon.server.close((e) => (e ? reject(e) : resolve())))
})

describe("MCP server: tool catalogue", () => {
  it("exposes every Quick Start tool", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    for (const expected of [
      "health",
      "list_templates",
      "create_project",
      "list_projects",
      "open_project",
      "select_project",
      "configure_llm",
      "get_llm_config",
      "configure_embedding",
      "configure_search",
      "list_sources",
      "import_documents",
      "delete_source",
      "query",
      "graph",
      "review",
      "resolve_review_item",
      "lint",
      "deep_research",
      "list_pages",
      "read_page",
      "job_status",
      "cancel_job",
    ]) {
      expect(names, `tool ${expected} should be registered`).toContain(expected)
    }
  })

  it("rejects calls with missing required args", async () => {
    const result = await client.callTool({ name: "create_project", arguments: {} })
    expect(result.isError).toBe(true)
  })
})

describe("MCP server: Quick Start workflow", () => {
  it("step 1 — create_project hits POST /api/projects", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "demo", path: "/tmp", templateId: "general" },
    })
    expect(result.isError).toBeFalsy()
    expect(daemon.requests.some((r) => r.method === "POST" && r.url === "/api/projects")).toBe(true)
  })

  it("step 2 — configure_llm forwards body verbatim", async () => {
    const result = await client.callTool({
      name: "configure_llm",
      arguments: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" },
    })
    expect(result.isError).toBeFalsy()
    const last = daemon.requests
      .filter((r) => r.method === "POST" && r.url === "/api/config/llm")
      .at(-1)
    expect(last?.body).toMatchObject({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" })
  })

  it("step 3 — import_documents returns a jobId without waiting", async () => {
    const result = await client.callTool({
      name: "import_documents",
      arguments: { paths: ["/tmp/a.pdf"], projectPath: "/tmp/x" },
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as Record<string, unknown>).jobId).toBe("job-import-1")
  })

  it("step 5 — query streams to completion when wait=true", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { question: "What is X?", projectPath: "/tmp/x", wait: true },
    })
    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.jobId).toBe("job-query-1")
    expect(sc.answer).toBe("hi")
  })

  it("step 6 — graph supports the three modes", async () => {
    const result = await client.callTool({
      name: "graph",
      arguments: { mode: "communities", projectPath: "/tmp/x" },
    })
    expect(result.isError).toBeFalsy()
    const last = daemon.requests
      .filter((r) => r.method === "GET" && r.url.startsWith("/api/graph"))
      .at(-1)
    expect(last?.url).toContain("mode=communities")
  })

  it("step 7 — review is a plain GET", async () => {
    const result = await client.callTool({ name: "review", arguments: { projectPath: "/tmp/x" } })
    expect(result.isError).toBeFalsy()
    expect(daemon.requests.some((r) => r.method === "GET" && r.url.startsWith("/api/review"))).toBe(true)
  })

  it("step 8 — lint streams to completion when wait=true", async () => {
    const result = await client.callTool({
      name: "lint",
      arguments: { projectPath: "/tmp/x", wait: true },
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as Record<string, unknown>).total).toBe(0)
  })

  it("forwards bearer token on every call", () => {
    for (const r of daemon.requests) {
      expect(r.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })
})
