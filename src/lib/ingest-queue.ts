import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  projectPath: string  // normalized absolute project path this task belongs to
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────
//
// Tasks for every known project live in one shared queue and each task carries
// its own `projectPath`. The queue file on disk is still per-project — we only
// serialize the tasks that belong to each project. Previously the in-memory
// queue was a single array replaced whenever a project was opened, so opening
// project B would wipe project A's pending work from memory (and
// `processNext` would run the next task against whatever path was passed
// last, even if the task itself came from a different project).

let queue: IngestTask[] = []
let processing = false
let currentAbortController: AbortController | null = null
let lastWrittenFiles: string[] = []  // track files written by current ingest for cleanup

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    const pp = normalizePath(projectPath)
    // Only save pending/failed tasks for THIS project. The in-memory queue
    // can hold tasks for other projects simultaneously; we mustn't write
    // them into this project's queue file.
    const toSave = queue.filter((t) => t.projectPath === pp && t.status !== "done")
    await writeFile(queueFilePath(pp), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(projectPath: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const pp = normalizePath(projectPath)
    const parsed = JSON.parse(raw) as Array<Partial<IngestTask>>
    // Backfill `projectPath` on legacy queue files that didn't record it, so
    // we never dispatch a task against the wrong project.
    return parsed
      .filter((t): t is IngestTask => typeof t?.id === "string" && typeof t?.sourcePath === "string")
      .map((t) => ({ ...(t as IngestTask), projectPath: t.projectPath ?? pp }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Add a file to the ingest queue.
 */
export async function enqueueIngest(
  projectPath: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  const pp = normalizePath(projectPath)

  const task: IngestTask = {
    id: generateId(),
    projectPath: pp,
    sourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }

  queue.push(task)
  await saveQueue(pp)

  // Start processing if not already running
  processNext()

  return task.id
}

/**
 * Add multiple files to the queue at once.
 */
export async function enqueueBatch(
  projectPath: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const ids: string[] = []

  for (const file of files) {
    const task: IngestTask = {
      id: generateId(),
      projectPath: pp,
      sourcePath: file.sourcePath,
      folderContext: file.folderContext,
      status: "pending",
      addedAt: Date.now(),
      error: null,
      retryCount: 0,
    }
    queue.push(task)
    ids.push(task.id)
  }

  await saveQueue(pp)
  console.log(`[Ingest Queue] Enqueued ${files.length} files`)
  processNext()

  return ids
}

/**
 * Retry a failed task.
 */
export async function retryTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  task.status = "pending"
  task.error = null
  await saveQueue(projectPath)
  processNext()
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }

    // Clean up any files written by the interrupted ingest
    if (lastWrittenFiles.length > 0) {
      const { deleteFile } = await import("@/commands/fs")
      for (const filePath of lastWrittenFiles) {
        try {
          const fullPath = filePath.startsWith("/") ? filePath : `${normalizePath(projectPath)}/${filePath}`
          await deleteFile(fullPath)
        } catch {
          // file may not exist
        }
      }
      console.log(`[Ingest Queue] Cleaned up ${lastWrittenFiles.length} files from cancelled task`)
      lastWrittenFiles = []
    }

    processing = false
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(projectPath)
  console.log(`[Ingest Queue] Cancelled: ${task.sourcePath}`)

  // Continue with next task
  processNext()
}

/**
 * Clear all done/failed tasks from the queue.
 */
export async function clearCompletedTasks(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  // Only prune completed tasks for THIS project; another project's history
  // is not the current caller's concern.
  queue = queue.filter(
    (t) => t.projectPath !== pp || t.status === "pending" || t.status === "processing",
  )
  await saveQueue(pp)
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): { pending: number; processing: number; failed: number; total: number } {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
  }
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing.
 * Called on app startup.
 */
export async function restoreQueue(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  const saved = await loadQueue(pp)

  // Drop anything we previously held for this project and merge in what was
  // on disk. Other projects' tasks in memory are untouched, so switching
  // projects no longer wipes pending work.
  queue = queue.filter((t) => t.projectPath !== pp)

  if (saved.length === 0) return

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of saved) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue.push(...saved)
  await saveQueue(pp)

  const pending = saved.filter((t) => t.status === "pending").length
  const failed = saved.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending, ${failed} failed, ${restored} resumed from interrupted`)
    processNext()
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function processNext(): Promise<void> {
  if (processing) return

  const next = queue.find((t) => t.status === "pending")
  if (!next) return

  processing = true
  next.status = "processing"
  const pp = normalizePath(next.projectPath)
  await saveQueue(pp)

  const llmConfig = useWikiStore.getState().llmConfig

  // Check if LLM is configured
  if (!llmConfig.apiKey && llmConfig.provider !== "ollama" && llmConfig.provider !== "custom") {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    processNext()
    return
  }

  const fullSourcePath = next.sourcePath.startsWith("/")
    ? next.sourcePath
    : `${pp}/${next.sourcePath}`

  console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${queue.filter((t) => t.status === "pending").length} remaining)`)

  // Create abort controller for this task
  currentAbortController = new AbortController()
  lastWrittenFiles = []

  try {
    const writtenFiles = await autoIngest(pp, fullSourcePath, llmConfig, currentAbortController.signal, next.folderContext)
    lastWrittenFiles = writtenFiles

    // Success: remove from queue
    currentAbortController = null
    lastWrittenFiles = []
    queue = queue.filter((t) => t.id !== next.id)
    await saveQueue(pp)

    console.log(`[Ingest Queue] Done: ${next.sourcePath}`)
  } catch (err) {
    currentAbortController = null
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(`[Ingest Queue] Failed (${next.retryCount}x): ${next.sourcePath} — ${message}`)
    } else {
      next.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.sourcePath} — ${message}`)
    }

    await saveQueue(pp)
  }

  processing = false
  processNext()
}
