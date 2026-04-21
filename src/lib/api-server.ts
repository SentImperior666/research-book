/**
 * Renderer-side dispatcher for the MCP bridge.
 *
 * The Rust HTTP daemon (`src-tauri/src/api/`) authenticates `/api/*` requests,
 * acquires the per-project write lock, and emits `api://request` Tauri events
 * with a `correlationId`. This module subscribes once at app startup, runs the
 * matching `src/lib/*` function (the same code paths the GUI uses), and emits
 * an `api://reply` event the daemon is awaiting on.
 *
 * Long-running operations return immediately with `{ jobId }`. Progress is
 * forwarded to the daemon as `api://progress` events; the daemon's
 * `/api/jobs/:jobId/stream` endpoint demultiplexes them to SSE clients.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event"

import {
  readFile,
  writeFile,
  listDirectory,
  copyFile,
  createDirectory,
  createProject as rustCreateProject,
  openProject as rustOpenProject,
  deleteFile,
} from "@/commands/fs"
import { applyTemplate, listTemplateSummaries } from "@/lib/templates"
import {
  loadLlmConfig,
  saveLlmConfig,
  loadEmbeddingConfig,
  saveEmbeddingConfig,
  loadSearchApiConfig,
  saveSearchApiConfig,
  getRecentProjects,
  saveLastProject,
  addToRecentProjects,
  removeFromRecentProjects,
} from "@/lib/project-store"
import { saveReviewItems, loadReviewItems } from "@/lib/persist"
import { useWikiStore } from "@/stores/wiki-store"
import type { LlmConfig, SearchApiConfig, EmbeddingConfig } from "@/stores/wiki-store"
import { useChatStore, type DisplayMessage, type Conversation } from "@/stores/chat-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useLintStore } from "@/stores/lint-store"
import { autoIngest } from "@/lib/ingest"
import { runStructuralLint, runSemanticLint, type LintResult } from "@/lib/lint"
import { searchWiki } from "@/lib/search"
import { buildWikiGraph } from "@/lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps } from "@/lib/graph-insights"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { streamChat, type ChatMessage as LLMChatMessage } from "@/lib/llm-client"
import { detectLanguage } from "@/lib/detect-language"
import { saveChatHistory } from "@/lib/persist"
import { queueResearch } from "@/lib/deep-research"
import { useResearchStore } from "@/stores/research-store"
import { enqueueBatch, getQueue } from "@/lib/ingest-queue"
import { normalizePath, getFileName, getFileStem, getRelativePath, resolveWithinBase } from "@/lib/path-utils"
import type { FileNode, WikiProject } from "@/types/wiki"

// ── Types shared with the Rust bridge ──────────────────────────────────────

interface ApiRequest {
  correlationId: string
  method: string
  route: string
  query: Record<string, string>
  body: unknown
}

interface ApiReply {
  correlationId: string
  ok: boolean
  status?: number
  data: unknown
  error?: string
}

interface ProgressEventPayload {
  jobId: string
  status?: string
  detail?: string
  progress?: number
  data?: unknown
  done?: boolean
}

// ── Per-project job lock ───────────────────────────────────────────────────
//
// The Rust router holds a per-project lock for the lifetime of the *HTTP
// request*, but most mutating routes (lint, query, research, sources/import)
// return a `{ jobId }` within ~100 ms and then run asynchronously in the
// renderer. By the time a second concurrent CLI fires, the Rust lock is long
// gone and both jobs end up running in parallel against the same project —
// which is exactly the behavior the user reported.
//
// The fix lives here because the renderer is what owns the job lifetime: we
// acquire the lock when `startJob` is called and release it in the job's
// `finally`, regardless of success or failure. Concurrent attempts throw a
// `ProjectBusyError` which the dispatcher maps to `409 Conflict`.

const projectJobLocks = new Map<string, string>() // projectPath → owning jobId

class ProjectBusyError extends Error {
  readonly code = "project_locked"
  readonly status = 409
  constructor(public readonly projectPath: string, public readonly heldBy: string) {
    super(`project busy: another job (${heldBy}) is running on ${projectPath}`)
    this.name = "ProjectBusyError"
  }
}

function lockProjectForJob(projectPath: string, jobId: string): void {
  const key = normalizePath(projectPath)
  const owner = projectJobLocks.get(key)
  if (owner && owner !== jobId) {
    throw new ProjectBusyError(key, owner)
  }
  projectJobLocks.set(key, jobId)
}

function releaseProjectFromJob(projectPath: string, jobId: string): void {
  const key = normalizePath(projectPath)
  if (projectJobLocks.get(key) === jobId) {
    projectJobLocks.delete(key)
  }
}

// ── Job registry ───────────────────────────────────────────────────────────

type JobType = "ingest" | "query" | "lint" | "research"

interface JobRecord {
  id: string
  type: JobType
  projectPath: string
  status: "queued" | "running" | "done" | "error"
  detail: string
  result?: unknown
  error?: string
  abort: AbortController
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, JobRecord>()

function newId(): string {
  // Browser crypto is always available in Tauri's webview.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

async function emitProgress(payload: ProgressEventPayload): Promise<void> {
  try {
    await emit("api://progress", payload)
  } catch {
    // non-critical
  }
}

async function emitReply(reply: ApiReply): Promise<void> {
  try {
    await emit("api://reply", reply)
  } catch {
    // non-critical — the requester will time out and report renderer_unreachable.
  }
}

/**
 * Kick off an async job, returning its id immediately.
 *
 * Acquires the per-project lock synchronously *before* allocating an id so a
 * busy project surfaces as a `ProjectBusyError` (→ 409) before any state has
 * been mutated. The lock is released in the job's `finally` block, which
 * means it spans the entire async operation — not just the HTTP request that
 * scheduled it.
 */
function startJob(
  type: JobType,
  projectPath: string,
  op: (jobId: string, signal: AbortSignal) => Promise<unknown>,
): string {
  const id = newId()
  // Throws ProjectBusyError if another job already owns this project. We
  // pre-bind the lock to `id` (peeking at "is it free?" then claiming it
  // atomically) before doing any other bookkeeping.
  lockProjectForJob(projectPath, id)

  const abort = new AbortController()
  const job: JobRecord = {
    id,
    type,
    projectPath,
    status: "queued",
    detail: "queued",
    abort,
    startedAt: Date.now(),
  }
  jobs.set(id, job)

  void (async () => {
    job.status = "running"
    await emitProgress({ jobId: id, status: "running", detail: "started" })
    try {
      const result = await op(id, abort.signal)
      job.status = "done"
      job.result = result
      job.finishedAt = Date.now()
      await emitProgress({
        jobId: id,
        status: "done",
        detail: "completed",
        data: result,
        done: true,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      job.status = "error"
      job.error = message
      job.finishedAt = Date.now()
      await emitProgress({
        jobId: id,
        status: "error",
        detail: message,
        error: message,
        done: true,
      } as ProgressEventPayload & { error: string })
    } finally {
      releaseProjectFromJob(projectPath, id)
    }
  })()

  return id
}

// ── Type guards / helpers ──────────────────────────────────────────────────

function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  return {}
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required field: ${field}`)
  }
  return value
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function requireProject(body: Record<string, unknown>, req?: ApiRequest): string {
  const explicit = optString(body.projectPath) ?? optString(req?.query.projectPath)
  if (explicit) return normalizePath(explicit)
  const active = useWikiStore.getState().project
  if (!active) {
    throw new Error("no active project (provide projectPath or POST /api/projects/select first)")
  }
  return normalizePath(active.path)
}


// ── Route handlers ─────────────────────────────────────────────────────────

type RouteHandler = (req: ApiRequest) => Promise<unknown>

const VERSION = "0.3.1"

const handlers: Record<string, RouteHandler> = {
  // ── Diagnostics ─────────────────────────────────────────────────────────
  "GET /api/health": async () => {
    const project = useWikiStore.getState().project
    return {
      ok: true,
      version: VERSION,
      project: project ? { name: project.name, path: project.path } : null,
      jobsRunning: Array.from(jobs.values()).filter((j) => j.status === "running").length,
    }
  },

  // ── Templates ───────────────────────────────────────────────────────────
  "GET /api/templates": async () => ({ templates: listTemplateSummaries() }),

  // ── Projects ────────────────────────────────────────────────────────────
  "POST /api/projects": async (req) => {
    const body = asObject(req.body)
    const name = asString(body.name, "name")
    const parent = asString(body.path, "path")
    const templateId = asString(body.templateId, "templateId")
    const project = await rustCreateProject(name, parent)
    await applyTemplate(project.path, templateId)
    return { project }
  },

  "POST /api/projects/open": async (req) => {
    const body = asObject(req.body)
    const path = asString(body.path, "path")
    const project = await rustOpenProject(path)
    // MCP tool contract says `open_project` adds the project to the recent
    // list. Without this, a subsequent `list_projects` won't reflect it.
    await addToRecentProjects(project)
    return { project }
  },

  "GET /api/projects": async () => {
    const recents = await getRecentProjects()
    const current = useWikiStore.getState().project
    return {
      projects: recents,
      current: current ? { name: current.name, path: current.path } : null,
    }
  },

  "POST /api/projects/select": async (req) => {
    const body = asObject(req.body)
    const path = asString(body.path, "path")
    const project = await rustOpenProject(path)
    await selectProjectInRenderer(project)
    return { project }
  },

  "DELETE /api/projects": async (req) => {
    const body = asObject(req.body)
    const path = asString(body.path, "path")
    await removeFromRecentProjects(path)
    return { removed: path }
  },

  // ── Config: LLM ─────────────────────────────────────────────────────────
  "GET /api/config/llm": async () => {
    const fromStore = useWikiStore.getState().llmConfig
    const persisted = await loadLlmConfig().catch(() => null)
    return { config: persisted ?? fromStore }
  },

  "POST /api/config/llm": async (req) => {
    const body = asObject(req.body)
    const config = mergeLlmConfig(body)
    useWikiStore.getState().setLlmConfig(config)
    await saveLlmConfig(config)
    return { config }
  },

  // ── Config: embedding ───────────────────────────────────────────────────
  "GET /api/config/embedding": async () => {
    const fromStore = useWikiStore.getState().embeddingConfig
    const persisted = await loadEmbeddingConfig().catch(() => null)
    return { config: persisted ?? fromStore }
  },

  "POST /api/config/embedding": async (req) => {
    const body = asObject(req.body)
    const current = useWikiStore.getState().embeddingConfig
    const config: EmbeddingConfig = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      endpoint: optString(body.endpoint) ?? current.endpoint,
      apiKey: optString(body.apiKey) ?? current.apiKey,
      model: optString(body.model) ?? current.model,
    }
    useWikiStore.getState().setEmbeddingConfig(config)
    await saveEmbeddingConfig(config)
    return { config }
  },

  // ── Config: search ──────────────────────────────────────────────────────
  "GET /api/config/search": async () => {
    const fromStore = useWikiStore.getState().searchApiConfig
    const persisted = await loadSearchApiConfig().catch(() => null)
    return { config: persisted ?? fromStore }
  },

  "POST /api/config/search": async (req) => {
    const body = asObject(req.body)
    const current = useWikiStore.getState().searchApiConfig
    const config: SearchApiConfig = {
      provider:
        body.provider === "tavily" || body.provider === "none"
          ? body.provider
          : current.provider,
      apiKey: optString(body.apiKey) ?? current.apiKey,
    }
    useWikiStore.getState().setSearchApiConfig(config)
    await saveSearchApiConfig(config)
    return { config }
  },

  // ── Sources (raw inputs) ────────────────────────────────────────────────
  "GET /api/sources": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const tree = await listDirectory(`${project}/raw/sources`).catch(() => [] as FileNode[])
    return { sources: flattenFiles(tree, project) }
  },

  "POST /api/sources/import": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const paths = Array.isArray(body.paths)
      ? (body.paths as unknown[]).filter((p): p is string => typeof p === "string")
      : null
    if (!paths || paths.length === 0) {
      throw new Error("paths must be a non-empty array of absolute file paths")
    }
    const folderContext = optString(body.folderContext) ?? ""

    // Copy each file into raw/sources/ then enqueue.
    const enqueueArgs: Array<{ sourcePath: string; folderContext: string }> = []
    const copied: string[] = []
    for (const src of paths) {
      const fileName = getFileName(src)
      const dest = `${project}/raw/sources/${fileName}`
      try {
        await createDirectory(`${project}/raw/sources`).catch(() => {})
        await copyFile(src, dest)
        copied.push(`raw/sources/${fileName}`)
        enqueueArgs.push({ sourcePath: `raw/sources/${fileName}`, folderContext })
      } catch (err) {
        throw new Error(`failed to import ${src}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const taskIds = await enqueueBatch(project, enqueueArgs)

    // Wrap the queue in a job so callers can poll/stream completion.
    const jobId = startJob("ingest", project, async (jid, signal) => {
      let lastDetail = ""
      while (true) {
        if (signal.aborted) {
          throw new Error("cancelled")
        }
        const queue = getQueue()
        const ours = queue.filter((t) => taskIds.includes(t.id))
        const pending = ours.filter((t) => t.status === "pending" || t.status === "processing")
        const failed = ours.filter((t) => t.status === "failed")
        const detail = `${pending.length} pending, ${failed.length} failed, ${taskIds.length - pending.length - failed.length} done`
        if (detail !== lastDetail) {
          lastDetail = detail
          await emitProgress({ jobId: jid, status: "running", detail })
        }
        if (pending.length === 0) {
          return {
            taskIds,
            failed: failed.map((t) => ({ source: t.sourcePath, error: t.error })),
            imported: copied,
          }
        }
        await sleep(500)
      }
    })
    return { jobId, copied, taskIds }
  },

  "POST /api/sources/delete": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const target = asString(body.path, "path")
    // Resolve strictly under the project root — absolute paths and `..`
    // traversal are both rejected so a token-holding caller cannot delete
    // arbitrary files outside the project.
    const full = resolveWithinBase(project, target)
    await deleteFile(full)
    return { deleted: target }
  },

  // ── Wiki content ────────────────────────────────────────────────────────
  "GET /api/wiki/index": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const content = await readFile(`${project}/wiki/index.md`).catch(() => "")
    return { path: "wiki/index.md", content }
  },

  "GET /api/wiki/pages": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const tree = await listDirectory(`${project}/wiki`).catch(() => [] as FileNode[])
    const all = flattenMarkdown(tree).map((f) => ({
      path: getRelativePath(f.path, project),
      name: f.name,
    }))
    const filterType = req.query.type
    if (filterType) {
      const filtered: typeof all = []
      for (const page of all) {
        try {
          const content = await readFile(`${project}/${page.path}`)
          const m = content.match(/^---\n[\s\S]*?^type:\s*["']?([^"'\n]+?)["']?\s*$/m)
          if (m && m[1].trim().toLowerCase() === filterType.toLowerCase()) {
            filtered.push(page)
          }
        } catch {
          // skip
        }
      }
      return { pages: filtered }
    }
    return { pages: all }
  },

  "GET /api/wiki/page": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const rel = req.query.path
    if (!rel) throw new Error("query parameter `path` is required")
    // Reject absolute / traversal paths so a token-holding caller cannot
    // read arbitrary files (`../../secrets.txt`) through this endpoint.
    const full = resolveWithinBase(project, rel)
    const content = await readFile(full)
    return { path: rel, content }
  },

  // ── Query ──────────────────────────────────────────────────────────────
  "POST /api/query": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const question = asString(body.question, "question")
    const saveToWiki = body.saveToWiki === true
    const conversationId = optString(body.conversationId)
    const contextSize = typeof body.contextSize === "number" ? body.contextSize : undefined
    const llmConfig = useWikiStore.getState().llmConfig

    const jobId = startJob("query", project, async (jid, signal) => {
      const result = await runQuery({
        project,
        question,
        conversationId,
        saveToWiki,
        contextSize,
        llmConfig,
        signal,
        onToken: (delta, accumulated) => {
          void emitProgress({
            jobId: jid,
            status: "running",
            detail: "streaming",
            progress: Math.min(0.95, accumulated.length / 4000),
          })
        },
      })
      return result
    })
    return { jobId }
  },

  // ── Graph ──────────────────────────────────────────────────────────────
  "GET /api/graph": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const mode = req.query.mode || "communities"
    const limit = req.query.limit ? Number(req.query.limit) : 10
    const graph = await buildWikiGraph(project)

    if (mode === "neighbors") {
      const page = req.query.page
      if (!page) throw new Error("query parameter `page` is required for mode=neighbors")
      const dataVersion = useWikiStore.getState().dataVersion
      const retrieval = await buildRetrievalGraph(project, dataVersion)
      const related = getRelatedNodes(page, retrieval, limit)
      return {
        mode,
        page,
        neighbors: related.map((r) => ({
          id: r.node.id,
          title: r.node.title,
          path: getRelativePath(r.node.path, project),
          relevance: r.relevance,
        })),
      }
    }

    if (mode === "insights") {
      const surprising = findSurprisingConnections(graph.nodes, graph.edges, graph.communities, limit)
      const gaps = detectKnowledgeGaps(graph.nodes, graph.edges, graph.communities, limit)
      return { mode, surprising, gaps }
    }

    // default: communities
    return {
      mode: "communities",
      stats: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        communities: graph.communities.length,
      },
      communities: graph.communities.slice(0, limit),
      topNodes: graph.nodes
        .slice()
        .sort((a, b) => b.linkCount - a.linkCount)
        .slice(0, limit)
        .map((n) => ({ id: n.id, label: n.label, type: n.type, linkCount: n.linkCount })),
    }
  },

  // ── Review ─────────────────────────────────────────────────────────────
  "GET /api/review": async (req) => {
    const project = requireProject(asObject(req.body), req)
    const fromStore = useReviewStore.getState().items
    const persisted = await loadReviewItems(project).catch(() => [] as ReviewItem[])
    const merged = mergeReviewItems(persisted, fromStore)
    return { items: merged }
  },

  "POST /api/review/resolve": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const id = asString(body.id, "id")
    const action = asString(body.action, "action")
    useReviewStore.getState().resolveItem(id, action)
    const items = useReviewStore.getState().items
    await saveReviewItems(project, items)
    return { id, action }
  },

  // ── Lint ───────────────────────────────────────────────────────────────
  "POST /api/lint": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const semantic = body.semantic === true
    const llmConfig = useWikiStore.getState().llmConfig

    // Surface the run in the GUI's Wiki Lint panel as it happens — without
    // this the human reviewer would see the activity-feed spinner but the
    // Lint page would stay on its empty "Run lint to check wiki health" state.
    useLintStore.getState().beginRun("mcp")

    const jobId = startJob("lint", project, async (_jid, signal) => {
      try {
        const structural = await runStructuralLint(project)
        if (signal.aborted) throw new Error("cancelled")
        let semanticResults: LintResult[] = []
        if (semantic) {
          semanticResults = await runSemanticLint(project, llmConfig)
        }
        if (signal.aborted) throw new Error("cancelled")
        const all: LintResult[] = [...structural, ...semanticResults]
        useLintStore.getState().setResults({
          results: all,
          semantic,
          source: "mcp",
          projectPath: project,
          finishedAt: Date.now(),
        })
        return {
          structural,
          semantic: semanticResults,
          total: all.length,
        }
      } catch (err) {
        // Make sure the GUI's spinner doesn't get stuck if the run blew up.
        useLintStore.getState().setResults({
          results: [],
          semantic,
          source: "mcp",
          projectPath: project,
          finishedAt: Date.now(),
        })
        throw err
      }
    })
    return { jobId }
  },

  // ── Deep research ───────────────────────────────────────────────────────
  "POST /api/research": async (req) => {
    const body = asObject(req.body)
    const project = requireProject(body)
    const topic = asString(body.topic, "topic")
    const queries = Array.isArray(body.queries)
      ? (body.queries as unknown[]).filter((q): q is string => typeof q === "string")
      : undefined
    const llmConfig = useWikiStore.getState().llmConfig
    const searchConfig = useWikiStore.getState().searchApiConfig
    if (searchConfig.provider === "none" || !searchConfig.apiKey) {
      throw new Error("search provider not configured (POST /api/config/search first)")
    }

    const jobId = startJob("research", project, async (jid, signal) => {
      const taskId = queueResearch(project, topic, llmConfig, searchConfig, queries)
      while (true) {
        if (signal.aborted) {
          throw new Error("cancelled")
        }
        const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
        if (!task) {
          throw new Error("research task disappeared")
        }
        await emitProgress({
          jobId: jid,
          status: task.status,
          detail: task.error ?? task.status,
        })
        if (task.status === "done") {
          return {
            taskId,
            savedPath: task.savedPath ?? null,
            synthesis: task.synthesis ?? null,
            sources: task.webResults?.map((w) => ({ title: w.title, url: w.url, source: w.source })) ?? [],
          }
        }
        if (task.status === "error") {
          throw new Error(task.error ?? "research failed")
        }
        await sleep(750)
      }
    })
    return { jobId }
  },

  // ── Jobs ───────────────────────────────────────────────────────────────
  "GET /api/jobs": async (req) => {
    const id = req.query.id
    if (id) {
      const job = jobs.get(id)
      if (!job) throw new Error(`unknown job: ${id}`)
      return { job: serializeJob(job) }
    }
    return { jobs: Array.from(jobs.values()).map(serializeJob) }
  },

  "DELETE /api/jobs": async (req) => {
    const id = req.query.id
    if (!id) throw new Error("query parameter `id` is required")
    const job = jobs.get(id)
    if (!job) throw new Error(`unknown job: ${id}`)
    // Only signal cancellation. Releasing the lock and deleting the record
    // here used to let the cancelled work keep mutating the project while a
    // second job started in parallel — a race the lock is supposed to prevent.
    // The job's own `finally` block will release the lock and we keep the
    // record so callers can still observe its final status.
    job.abort.abort()
    job.detail = "cancelling"
    return { cancelled: id }
  },
}

// ── Dispatcher boot ────────────────────────────────────────────────────────

// We track BOTH the resolved unsubscriber and the in-flight registration
// promise. Caching just the unsubscriber is racy: under React.StrictMode
// (or any concurrent caller) the second `startApiServer()` invocation can
// arrive while the first `await listen(...)` is still pending, find
// `unlisten === null`, and register a *second* listener. That doubles every
// dispatched request — `runQuery`, `autoIngest`, etc. all execute twice,
// producing duplicate activity items and burning duplicate LLM calls. The
// extra reply is silently dropped by the Rust bridge (it `.remove`s the
// pending entry on first reply), so the CLI sees a single result and the
// bug is invisible from the outside.
let unlisten: UnlistenFn | null = null
let starting: Promise<UnlistenFn> | null = null

/**
 * Subscribe to `api://request` events from the Rust bridge. Idempotent and
 * safe under concurrent callers: a second call returns the same in-flight
 * registration. Returns an unsubscriber for tests.
 */
export async function startApiServer(): Promise<UnlistenFn> {
  if (unlisten) return unlisten
  if (starting) return starting
  starting = (async () => {
    const fn = await listen<ApiRequest>("api://request", async (event) => {
      const req = event.payload
      const key = `${req.method.toUpperCase()} ${req.route}`
      const handler = handlers[key]
      if (!handler) {
        await emitReply({
          correlationId: req.correlationId,
          ok: false,
          status: 404,
          data: null,
          error: `no handler for ${key}`,
        })
        return
      }
      try {
        const data = await handler(req)
        await emitReply({ correlationId: req.correlationId, ok: true, status: 200, data })
      } catch (err) {
        if (err instanceof ProjectBusyError) {
          // Mirrors the 409 envelope the Rust router produces for its own
          // (request-lifetime) lock so CLIs only have to handle one shape.
          await emitReply({
            correlationId: req.correlationId,
            ok: false,
            status: 409,
            data: {
              code: err.code,
              project: err.projectPath,
              heldBy: err.heldBy,
            },
            error: "project busy",
          })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        await emitReply({
          correlationId: req.correlationId,
          ok: false,
          status: 500,
          data: null,
          error: message,
        })
      }
    })
    unlisten = fn
    return fn
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Stop the dispatcher (used by tests). */
export async function stopApiServer(): Promise<void> {
  if (starting) {
    try {
      await starting
    } catch {
      // ignore — we're tearing down anyway
    }
  }
  if (unlisten) {
    await unlisten()
    unlisten = null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function flattenMarkdown(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) out.push(...flattenMarkdown(node.children))
    else if (!node.is_dir && node.name.endsWith(".md")) out.push(node)
  }
  return out
}

function flattenFiles(nodes: FileNode[], projectPath: string): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = []
  function walk(list: FileNode[]) {
    for (const node of list) {
      if (node.is_dir && node.children) walk(node.children)
      else if (!node.is_dir) {
        out.push({
          path: getRelativePath(node.path, projectPath),
          name: node.name,
        })
      }
    }
  }
  walk(nodes)
  return out
}

function mergeLlmConfig(body: Record<string, unknown>): LlmConfig {
  const current = useWikiStore.getState().llmConfig
  const validProvider = (p: unknown): p is LlmConfig["provider"] =>
    typeof p === "string" &&
    ["openai", "anthropic", "google", "ollama", "custom", "minimax"].includes(p)
  return {
    provider: validProvider(body.provider) ? body.provider : current.provider,
    apiKey: optString(body.apiKey) ?? current.apiKey,
    model: optString(body.model) ?? current.model,
    ollamaUrl: optString(body.ollamaUrl) ?? current.ollamaUrl,
    customEndpoint: optString(body.customEndpoint) ?? current.customEndpoint,
    maxContextSize:
      typeof body.maxContextSize === "number" ? body.maxContextSize : current.maxContextSize,
  }
}

function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    type: job.type,
    projectPath: job.projectPath,
    status: job.status,
    detail: job.detail,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function mergeReviewItems(persisted: ReviewItem[], inMemory: ReviewItem[]): ReviewItem[] {
  const seen = new Set<string>()
  const out: ReviewItem[] = []
  for (const item of [...inMemory, ...persisted]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

async function selectProjectInRenderer(project: WikiProject): Promise<void> {
  // Mirror App.tsx::handleProjectOpened so the GUI doesn't keep displaying
  // the previous project's chats, reviews, research tasks, activity feed, or
  // lint results after an MCP/CLI-initiated switch. Without this, the GUI
  // and the MCP bridge diverge.
  useReviewStore.getState().clear()
  useChatStore.getState().clear()
  useResearchStore.getState().clear()
  useActivityStore.getState().clear()
  useLintStore.getState().clear()
  const { clearGraphCache } = await import("@/lib/graph-relevance")
  clearGraphCache()

  useWikiStore.getState().setProject(project)
  useWikiStore.getState().setSelectedFile(null)
  await saveLastProject(project)

  // Resume any interrupted ingest tasks saved under this project.
  try {
    const { restoreQueue } = await import("@/lib/ingest-queue")
    await restoreQueue(project.path)
  } catch {
    // non-critical
  }

  try {
    const tree = await listDirectory(project.path)
    useWikiStore.getState().setFileTree(tree)
  } catch {
    // ignore
  }

  // Load persisted review and chat state for this project.
  try {
    const savedReview = await loadReviewItems(project.path)
    useReviewStore.getState().setItems(savedReview)
  } catch {
    useReviewStore.getState().setItems([])
  }
  try {
    const { loadChatHistory } = await import("@/lib/persist")
    const savedChat = await loadChatHistory(project.path)
    useChatStore.getState().setConversations(savedChat.conversations)
    useChatStore.getState().setMessages(savedChat.messages)
    const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
    useChatStore.getState().setActiveConversation(sorted[0]?.id ?? null)
  } catch {
    useChatStore.getState().setConversations([])
    useChatStore.getState().setMessages([])
    useChatStore.getState().setActiveConversation(null)
  }

  // Notify the clip server of the new active project and update the
  // recent-projects list so the Chrome extension picker stays in sync.
  try {
    await fetch("http://127.0.0.1:19827/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project.path }),
    })
    const recents = await getRecentProjects()
    await fetch("http://127.0.0.1:19827/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: recents.map((p) => ({ name: p.name, path: p.path })) }),
    })
  } catch {
    // clip server not reachable — fine
  }
}

// ── Query implementation ───────────────────────────────────────────────────
//
// Mirrors the GUI's chat-panel.tsx pipeline (graph-enhanced retrieval +
// streamChat) but writes the result into a dedicated MCP-tagged conversation
// instead of UI state. When `saveToWiki` is true, the answer is also written
// to `wiki/queries/`.

interface RunQueryArgs {
  project: string
  question: string
  conversationId?: string
  saveToWiki: boolean
  contextSize?: number
  llmConfig: LlmConfig
  signal: AbortSignal
  onToken: (delta: string, accumulated: string) => void
}

interface RunQueryResult {
  conversationId: string
  question: string
  answer: string
  references: Array<{ title: string; path: string }>
  savedPath: string | null
}

async function runQuery(args: RunQueryArgs): Promise<RunQueryResult> {
  const { project, question, llmConfig, signal, onToken } = args
  const dataVersion = useWikiStore.getState().dataVersion
  const maxCtx = args.contextSize ?? llmConfig.maxContextSize ?? 204800
  const INDEX_BUDGET = Math.floor(maxCtx * 0.05)
  const PAGE_BUDGET = Math.floor(maxCtx * 0.6)
  const MAX_PAGE_SIZE = Math.min(Math.floor(PAGE_BUDGET * 0.3), 30_000)

  const [rawIndex, purpose] = await Promise.all([
    readFile(`${project}/wiki/index.md`).catch(() => ""),
    readFile(`${project}/purpose.md`).catch(() => ""),
  ])

  const searchResults = await searchWiki(project, question)
  const top = searchResults.slice(0, 10)

  let index = rawIndex
  if (rawIndex.length > INDEX_BUDGET) {
    const { tokenizeQuery } = await import("@/lib/search")
    const tokens = tokenizeQuery(question)
    const lines = rawIndex.split("\n")
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
      const isHeader = line.startsWith("##")
      const lower = line.toLowerCase()
      const isRelevant = tokens.some((t) => lower.includes(t))
      if (isHeader || isRelevant) {
        if (used + line.length + 1 <= INDEX_BUDGET) {
          kept.push(line)
          used += line.length + 1
        }
      }
    }
    index = kept.join("\n")
    if (index.length < rawIndex.length) {
      index += "\n\n[...index trimmed to relevant entries...]"
    }
  }

  const graph = await buildRetrievalGraph(project, dataVersion)
  const expanded = new Set<string>()
  const hitPaths = new Set(top.map((r) => r.path))
  const expansions: Array<{ title: string; path: string; relevance: number }> = []
  for (const r of top) {
    const fileName = getFileName(r.path)
    const nodeId = fileName.replace(/\.md$/, "")
    const related = getRelatedNodes(nodeId, graph, 3)
    for (const { node, relevance } of related) {
      if (relevance < 2.0) continue
      if (hitPaths.has(node.path)) continue
      if (expanded.has(node.id)) continue
      expanded.add(node.id)
      expansions.push({ title: node.title, path: node.path, relevance })
    }
  }
  expansions.sort((a, b) => b.relevance - a.relevance)

  let used = 0
  type PageEntry = { title: string; path: string; content: string; priority: number }
  const pages: PageEntry[] = []

  const tryAdd = async (title: string, filePath: string, priority: number) => {
    if (used >= PAGE_BUDGET) return
    try {
      const raw = await readFile(filePath)
      const truncated = raw.length > MAX_PAGE_SIZE
        ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
        : raw
      if (used + truncated.length > PAGE_BUDGET) return
      used += truncated.length
      pages.push({
        title,
        path: getRelativePath(filePath, project),
        content: truncated,
        priority,
      })
    } catch {
      // ignore
    }
  }

  for (const r of top.filter((r) => r.titleMatch)) await tryAdd(r.title, r.path, 0)
  for (const r of top.filter((r) => !r.titleMatch)) await tryAdd(r.title, r.path, 1)
  for (const exp of expansions) await tryAdd(exp.title, exp.path, 2)
  if (pages.length === 0) await tryAdd("Overview", `${project}/wiki/overview.md`, 3)

  const pagesContext =
    pages.length > 0
      ? pages
          .map((p, i) => `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`)
          .join("\n\n---\n\n")
      : "(No wiki pages found)"

  const pageList = pages.map((p, i) => `[${i + 1}] ${p.title} (${p.path})`).join("\n")

  const lang = detectLanguage(question)
  const systemPrompt = [
    "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
    "",
    `## CRITICAL: Response Language`,
    `The user is writing in **${lang}**. You MUST respond in **${lang}** regardless of what language the wiki content is written in.`,
    "",
    "## Rules",
    "- Answer based ONLY on the numbered wiki pages provided below.",
    "- If the provided pages don't contain enough information, say so honestly.",
    "- Use [[wikilink]] syntax to reference wiki pages.",
    "- Cite information using [N] notation matching the page numbers.",
    "- At the end, add: <!-- cited: 1, 3, 5 -->",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Wiki Index\n${index}` : "",
    pages.length > 0 ? `## Page List\n${pageList}` : "",
    `## Wiki Pages\n\n${pagesContext}`,
  ]
    .filter(Boolean)
    .join("\n")

  const messages: LLMChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ]

  let accumulated = ""
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token) => {
        accumulated += token
        onToken(token, accumulated)
      },
      onDone: () => {},
      onError: (err) => {
        throw err
      },
    },
    signal,
  )

  // Persist as an MCP-tagged conversation so it shows up in the GUI sidebar.
  const conversationId = args.conversationId ?? `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const chatStore = useChatStore.getState()
  const existingConv = chatStore.conversations.find((c) => c.id === conversationId)
  if (!existingConv) {
    const newConv: Conversation & { source?: string } = {
      id: conversationId,
      title: question.slice(0, 60),
      createdAt: now,
      updatedAt: now,
      source: "mcp",
    } as Conversation
    chatStore.setConversations([newConv, ...chatStore.conversations])
  } else {
    chatStore.setConversations(
      chatStore.conversations.map((c) => (c.id === conversationId ? { ...c, updatedAt: now } : c)),
    )
  }

  const userMsg: DisplayMessage = {
    id: `mcp_u_${now}_${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    content: question,
    timestamp: now,
    conversationId,
  }
  const assistantMsg: DisplayMessage = {
    id: `mcp_a_${now + 1}_${Math.random().toString(36).slice(2, 6)}`,
    role: "assistant",
    content: accumulated,
    timestamp: now + 1,
    conversationId,
    references: pages.map((p) => ({ title: p.title, path: p.path })),
  }
  chatStore.setMessages([...chatStore.messages, userMsg, assistantMsg])
  await saveChatHistory(project, useChatStore.getState().conversations, useChatStore.getState().messages).catch(() => {})

  let savedPath: string | null = null
  if (args.saveToWiki) {
    const date = new Date(now).toISOString().slice(0, 10)
    const slug = question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 50) || "query"
    const fileName = `${slug}-${date}.md`
    const rel = `wiki/queries/${fileName}`
    const fullPath = `${project}/${rel}`
    const stem = getFileStem(fileName)
    void stem
    const refs = pages
      .map((p, i) => `${i + 1}. [[${p.path.replace(/^wiki\//, "").replace(/\.md$/, "")}|${p.title}]]`)
      .join("\n")
    const body = [
      "---",
      "type: query",
      `title: "Query: ${question.replace(/"/g, '\\"').slice(0, 80)}"`,
      `created: ${date}`,
      "origin: mcp",
      "tags: [mcp]",
      "---",
      "",
      `# Query: ${question}`,
      "",
      accumulated,
      "",
      "## References",
      "",
      refs || "(none)",
      "",
    ].join("\n")
    await writeFile(fullPath, body)
    savedPath = rel
    try {
      const tree = await listDirectory(project)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  // Run a one-shot ingest in the background if user opted to save the answer.
  if (savedPath) {
    autoIngest(project, `${project}/${savedPath}`, llmConfig).catch((err) => {
      console.error("[mcp/query] follow-up ingest failed:", err)
    })
  }

  // Suppress no-unused warning when activity import is unused.
  void useActivityStore

  return {
    conversationId,
    question,
    answer: accumulated,
    references: pages.map((p) => ({ title: p.title, path: p.path })),
    savedPath,
  }
}
