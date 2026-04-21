/**
 * MCP tool registrations covering every Quick Start step in the desktop app's
 * README:
 *
 *   1. create_project        — scaffold + apply template
 *   2. configure_llm         — set provider / model / API key
 *      configure_embedding   — set the embedding endpoint (optional but recommended)
 *      configure_search      — set the deep-research search provider
 *   3. import_documents      — copy files into raw/sources and ingest
 *   5. query                 — graph-augmented Q&A, optionally saved as a wiki page
 *   6. graph                 — query the knowledge graph (communities / neighbors / insights)
 *   7. review                — list / resolve human-review items
 *   8. lint                  — run structural (and optional semantic) lint
 *
 * Plus utility tools agents will reach for: list_projects, open_project,
 * select_project, list_templates, list_sources, list_pages, read_page,
 * deep_research, job_status, cancel_job.
 *
 * Tool *schemas* are declared with Zod so MCP clients (Cursor, Claude Code,
 * etc.) get full input validation + autocomplete.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { ApiError, type WikiDaemonClient } from "./client.js"
import { awaitJob } from "./progress.js"

// ── Helpers ────────────────────────────────────────────────────────────────

interface ToolExtra {
  _meta?: { progressToken?: string | number }
  signal?: AbortSignal
}

/**
 * Build a uniform tool result. Always returns `structuredContent` so callers
 * can read it programmatically; the `text` block is a JSON pretty-print so
 * humans / less-capable LLM clients still see the content.
 */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { value: data },
  }
}

function err(message: string, detail?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          detail !== undefined
            ? `${message}\n\n${JSON.stringify(detail, null, 2)}`
            : message,
      },
    ],
  }
}

/** Wrap a handler so daemon errors become `isError: true` results. */
function safe<T>(fn: () => Promise<T>) {
  return fn().catch((e: unknown) => {
    if (e instanceof ApiError) {
      return err(`API ${e.status}: ${e.message}`, e.body)
    }
    return err(e instanceof Error ? e.message : String(e))
  })
}

function extractProgressToken(extra: ToolExtra | undefined): string | number | undefined {
  return extra?._meta?.progressToken
}

// ── Tool registration ──────────────────────────────────────────────────────

export function registerTools(server: McpServer, client: WikiDaemonClient): void {
  // ── 0. Diagnostics & discovery ───────────────────────────────────────────

  server.registerTool(
    "health",
    {
      title: "Daemon health check",
      description: "Verify the desktop daemon is reachable and report the active project.",
      inputSchema: {},
    },
    async () => safe(async () => ok(await client.request("GET", "/api/health"))),
  )

  server.registerTool(
    "list_templates",
    {
      title: "List project templates",
      description:
        "Return all built-in templates (id, name, description, default folders) used by `create_project`.",
      inputSchema: {},
    },
    async () => safe(async () => ok(await client.request("GET", "/api/templates"))),
  )

  // ── 1. Projects ──────────────────────────────────────────────────────────

  server.registerTool(
    "create_project",
    {
      title: "Create a new wiki project",
      description:
        "Quick Start step 1. Scaffolds a new project under `path/<name>/`, applies the chosen template, and returns the project descriptor. After creation the project is NOT made active automatically — call `select_project` if you want subsequent commands to default to it.",
      inputSchema: {
        name: z.string().min(1).describe("Project name (also the new directory name)."),
        path: z
          .string()
          .min(1)
          .describe("Absolute path to the parent directory that will contain the new project folder."),
        templateId: z
          .string()
          .min(1)
          .describe("Template id from `list_templates` (e.g. `general`, `research`, `engineering`)."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/projects", {
            body: input,
          }),
        ),
      ),
  )

  server.registerTool(
    "list_projects",
    {
      title: "List recent projects",
      description: "Return the recent-projects list and the currently active project (if any).",
      inputSchema: {},
    },
    async () => safe(async () => ok(await client.request("GET", "/api/projects"))),
  )

  server.registerTool(
    "open_project",
    {
      title: "Open a project (without activating)",
      description:
        "Validate that `path` is a valid project directory and add it to the recent-projects list. Returns the project descriptor. Does NOT change the active project — use `select_project` for that.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the project directory."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/projects/open", {
            body: input,
          }),
        ),
      ),
  )

  server.registerTool(
    "select_project",
    {
      title: "Set active project",
      description:
        "Open `path` and make it the active project for the desktop app. Subsequent tools that omit `projectPath` will default to this project.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the project directory."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/projects/select", {
            body: input,
          }),
        ),
      ),
  )

  // ── 2. Configuration ─────────────────────────────────────────────────────

  const llmProvider = z.enum(["openai", "anthropic", "google", "ollama", "custom", "minimax"])

  server.registerTool(
    "configure_llm",
    {
      title: "Configure LLM provider",
      description:
        "Quick Start step 2. Update the LLM provider, model, API key, and optional context window. Persisted across sessions; takes effect immediately.",
      inputSchema: {
        provider: llmProvider.optional().describe("Which provider to call."),
        apiKey: z.string().optional().describe("Provider API key (omit to keep the current value)."),
        model: z.string().optional().describe("Model name as the provider expects it."),
        ollamaUrl: z.string().optional().describe("Base URL for a local Ollama instance."),
        customEndpoint: z.string().optional().describe("Base URL for an OpenAI-compatible custom endpoint."),
        maxContextSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Approximate context window in characters (default ~204800)."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/config/llm", {
            body: input,
          }),
        ),
      ),
  )

  server.registerTool(
    "get_llm_config",
    {
      title: "Read LLM configuration",
      description: "Return the currently saved LLM provider configuration.",
      inputSchema: {},
    },
    async () => safe(async () => ok(await client.request("GET", "/api/config/llm"))),
  )

  server.registerTool(
    "configure_embedding",
    {
      title: "Configure embedding provider",
      description:
        "Set the OpenAI-compatible embedding endpoint used for vector search and graph relevance. Required for high-quality `query` results.",
      inputSchema: {
        enabled: z.boolean().optional().describe("Enable or disable embedding-backed retrieval."),
        endpoint: z.string().optional().describe("Embedding endpoint base URL."),
        apiKey: z.string().optional().describe("API key (omit to keep current)."),
        model: z.string().optional().describe("Embedding model name."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/config/embedding", {
            body: input,
          }),
        ),
      ),
  )

  server.registerTool(
    "configure_search",
    {
      title: "Configure web-search provider",
      description: "Set the search provider used by `deep_research` (currently `tavily` or `none`).",
      inputSchema: {
        provider: z.enum(["tavily", "none"]).describe("Search provider."),
        apiKey: z.string().optional().describe("Provider API key (omit to keep current)."),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/config/search", {
            body: input,
          }),
        ),
      ),
  )

  // ── 3. Sources / ingest ──────────────────────────────────────────────────

  server.registerTool(
    "list_sources",
    {
      title: "List raw source files",
      description: "Return every file under the project's `raw/sources/` directory.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe("Override the active project. Absolute path."),
      },
    },
    async (input) =>
      safe(async () => {
        const data = await client.request("GET", "/api/sources", {
          query: { projectPath: input?.projectPath },
        })
        return ok(data)
      }),
  )

  server.registerTool(
    "import_documents",
    {
      title: "Import documents into the wiki",
      description:
        "Quick Start step 3. Copies each file into `raw/sources/` and runs the ingest pipeline (chunking + summarization + linking). Returns a `jobId`; subscribe to `wiki://job/{jobId}` or call `job_status` to follow progress. The call also forwards SSE progress events as MCP progress notifications when a `progressToken` is supplied.",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Absolute paths to source files (PDF, DOCX, MD, TXT, …)."),
        folderContext: z
          .string()
          .optional()
          .describe("Free-form hint stored alongside each source describing where it came from."),
        projectPath: z.string().optional().describe("Override the active project."),
        wait: z
          .boolean()
          .optional()
          .describe("If true, block until the ingest job finishes and return its result."),
      },
    },
    async (input, extra) =>
      safe(async () => {
        const { wait, ...body } = input
        const initial = await client.request<{ jobId: string; copied: string[]; taskIds: string[] }>(
          "POST",
          "/api/sources/import",
          { body },
        )
        if (!wait) return ok(initial)
        const result = await awaitJob(client, initial.jobId, {
          progressToken: extractProgressToken(extra),
          server: server.server,
          signal: extra?.signal,
        })
        return ok({ ...initial, result })
      }),
  )

  server.registerTool(
    "delete_source",
    {
      title: "Delete a source file",
      description:
        "Remove a file from the project. Path is project-relative (e.g. `raw/sources/foo.pdf`) or absolute.",
      inputSchema: {
        path: z.string().min(1),
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/sources/delete", {
            body: input,
          }),
        ),
      ),
  )

  // ── 5. Query ─────────────────────────────────────────────────────────────

  server.registerTool(
    "query",
    {
      title: "Query the knowledge base",
      description:
        "Quick Start step 5. Runs the same graph-augmented retrieval + LLM chat as the GUI. Always returns a `jobId`; pass `wait: true` to block until the answer is ready (recommended for tool use). When `saveToWiki: true`, the answer is also written to `wiki/queries/<slug>-<date>.md` and ingested.",
      inputSchema: {
        question: z.string().min(1).describe("Natural-language question."),
        projectPath: z.string().optional(),
        saveToWiki: z
          .boolean()
          .optional()
          .describe("If true, persist the answer as a `wiki/queries/*.md` page."),
        contextSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override the LLM context window (characters)."),
        conversationId: z
          .string()
          .optional()
          .describe("Reuse an existing conversation id to thread multiple queries together."),
        wait: z
          .boolean()
          .optional()
          .default(true)
          .describe("Block until the LLM completes (default true)."),
      },
    },
    async (input, extra) =>
      safe(async () => {
        const { wait = true, ...body } = input
        const initial = await client.request<{ jobId: string }>("POST", "/api/query", {
          body,
        })
        if (!wait) return ok(initial)
        const result = await awaitJob(client, initial.jobId, {
          progressToken: extractProgressToken(extra),
          server: server.server,
          signal: extra?.signal,
        })
        return ok({ jobId: initial.jobId, ...((result ?? {}) as Record<string, unknown>) })
      }),
  )

  // ── 6. Graph ─────────────────────────────────────────────────────────────

  server.registerTool(
    "graph",
    {
      title: "Query the knowledge graph",
      description:
        "Quick Start step 6. Three modes:\n  - `communities` (default): summary stats + top communities and most-linked nodes.\n  - `neighbors`: pages most relevant to a given page (requires `page`).\n  - `insights`: surprising connections + knowledge gaps.",
      inputSchema: {
        mode: z.enum(["communities", "neighbors", "insights"]).optional(),
        page: z
          .string()
          .optional()
          .describe("Page id (filename without `.md`) — required for mode=`neighbors`."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum results per category (default 10)."),
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () => {
        const { mode, page, limit, projectPath } = input
        const data = await client.request("GET", "/api/graph", {
          query: { mode, page, limit, projectPath },
        })
        return ok(data)
      }),
  )

  // ── 7. Review ────────────────────────────────────────────────────────────

  server.registerTool(
    "review",
    {
      title: "List review items",
      description:
        "Quick Start step 7. Returns items the wiki has flagged as needing human review (conflicting facts, low-confidence merges, etc.).",
      inputSchema: {
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("GET", "/api/review", {
            query: { projectPath: input?.projectPath },
          }),
        ),
      ),
  )

  server.registerTool(
    "resolve_review_item",
    {
      title: "Resolve a review item",
      description: "Mark a review item as resolved with an action (e.g. `accepted`, `rejected`, `merged`).",
      inputSchema: {
        id: z.string().min(1),
        action: z.string().min(1),
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("POST", "/api/review/resolve", {
            body: input,
          }),
        ),
      ),
  )

  // ── 8. Lint ──────────────────────────────────────────────────────────────

  server.registerTool(
    "lint",
    {
      title: "Lint the wiki",
      description:
        "Quick Start step 8. Runs the structural linter (broken links, schema violations) and, when `semantic: true`, the LLM-backed semantic linter. Returns a `jobId`; pass `wait: true` to block until results are ready.",
      inputSchema: {
        semantic: z
          .boolean()
          .optional()
          .describe("Also run the semantic (LLM-backed) lint pass. Slower but catches contradictions."),
        projectPath: z.string().optional(),
        wait: z.boolean().optional().default(true),
      },
    },
    async (input, extra) =>
      safe(async () => {
        const { wait = true, ...body } = input
        const initial = await client.request<{ jobId: string }>("POST", "/api/lint", {
          body,
        })
        if (!wait) return ok(initial)
        const result = await awaitJob(client, initial.jobId, {
          progressToken: extractProgressToken(extra),
          server: server.server,
          signal: extra?.signal,
        })
        return ok({ jobId: initial.jobId, ...((result ?? {}) as Record<string, unknown>) })
      }),
  )

  // ── Bonus: deep research ─────────────────────────────────────────────────

  server.registerTool(
    "deep_research",
    {
      title: "Run deep research on a topic",
      description:
        "Spawn the deep-research pipeline: web search + LLM synthesis, optionally saved into the wiki. Requires `configure_search`. Returns a `jobId`; pass `wait: true` to block.",
      inputSchema: {
        topic: z.string().min(1).describe("Research topic / question."),
        queries: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional explicit search queries to run instead of the auto-generated ones."),
        projectPath: z.string().optional(),
        wait: z.boolean().optional().default(false),
      },
    },
    async (input, extra) =>
      safe(async () => {
        const { wait = false, ...body } = input
        const initial = await client.request<{ jobId: string }>("POST", "/api/research", {
          body,
        })
        if (!wait) return ok(initial)
        const result = await awaitJob(client, initial.jobId, {
          progressToken: extractProgressToken(extra),
          server: server.server,
          signal: extra?.signal,
        })
        return ok({ jobId: initial.jobId, ...((result ?? {}) as Record<string, unknown>) })
      }),
  )

  // ── Wiki content reads (use the `wiki://` resources for cheap reads) ─────

  server.registerTool(
    "list_pages",
    {
      title: "List wiki pages",
      description:
        "Return every markdown page under `wiki/`, optionally filtered by frontmatter `type` (entity, concept, decision, query, …).",
      inputSchema: {
        type: z.string().optional().describe("Filter by frontmatter `type`."),
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("GET", "/api/wiki/pages", {
            query: { type: input.type, projectPath: input.projectPath },
          }),
        ),
      ),
  )

  server.registerTool(
    "read_page",
    {
      title: "Read a wiki page",
      description:
        "Read the markdown content of a single wiki page. `path` is project-relative (e.g. `wiki/entities/openai.md`).",
      inputSchema: {
        path: z.string().min(1),
        projectPath: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("GET", "/api/wiki/page", {
            query: { path: input.path, projectPath: input.projectPath },
          }),
        ),
      ),
  )

  // ── Job control ──────────────────────────────────────────────────────────

  server.registerTool(
    "job_status",
    {
      title: "Inspect a job",
      description: "Look up an async job (ingest / query / lint / research) by id, or list all jobs.",
      inputSchema: {
        id: z.string().optional(),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("GET", "/api/jobs", {
            query: { id: input.id },
          }),
        ),
      ),
  )

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a running job",
      description: "Abort an in-flight job by id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async (input) =>
      safe(async () =>
        ok(
          await client.request("DELETE", "/api/jobs", {
            query: { id: input.id },
          }),
        ),
      ),
  )
}
