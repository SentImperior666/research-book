/**
 * Bridge daemon SSE events to MCP progress notifications.
 *
 * The daemon emits chunked SSE events with JSON bodies that mirror the
 * renderer's activity feed. We translate each into an MCP progress notification
 * (when a `progressToken` is supplied) and aggregate the final result.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WikiDaemonClient, type JobEvent } from "./client.js"

export interface AwaitJobOptions {
  /** MCP progress token (forwarded from the tool call's `_meta.progressToken`). */
  progressToken?: string | number
  /** Optional MCP server reference; if provided, we send progress notifications. */
  server?: Server
  /** Abort the wait early. */
  signal?: AbortSignal
  /**
   * Maximum total wait time. Defaults to 20 minutes — long enough for big
   * imports and deep research but not infinite.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Subscribe to a job's SSE stream and return its final result. Emits MCP
 * progress notifications along the way when `progressToken` is supplied.
 */
export async function awaitJob<T = unknown>(
  client: WikiDaemonClient,
  jobId: string,
  options: AwaitJobOptions = {},
): Promise<T> {
  const timeoutController = new AbortController()
  const onAbort = () => timeoutController.abort()
  const timer = setTimeout(onAbort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (options.signal) {
    options.signal.addEventListener("abort", onAbort)
  }

  let lastEvent: JobEvent | null = null

  try {
    let stepIndex = 0
    for await (const event of client.streamJob(jobId, { signal: timeoutController.signal })) {
      lastEvent = event
      if (event.kind === "comment") continue

      if (options.progressToken !== undefined && options.server) {
        try {
          await options.server.notification({
            method: "notifications/progress",
            params: {
              progressToken: options.progressToken,
              progress: event.data.progress ?? ++stepIndex,
              // The MCP spec recently added `message`; older clients ignore it.
              message: event.data.detail ?? event.data.status ?? "",
            },
          })
        } catch {
          // progress notifications are best-effort
        }
      }

      if (event.kind === "done") {
        return event.data.data as T
      }
      if (event.kind === "error") {
        throw new Error(event.data.error ?? event.data.detail ?? "job failed")
      }
    }
  } finally {
    clearTimeout(timer)
  }

  // Stream ended without a `done` frame — fall back to polling /api/jobs.
  const status = await client.request<{ job: { status: string; result?: unknown; error?: string } }>(
    "GET",
    "/api/jobs",
    { query: { id: jobId } },
  )
  const job = status.job
  if (job.status === "done") return job.result as T
  if (job.status === "error") throw new Error(job.error ?? "job failed")
  throw new Error(`job ${jobId} ended in unexpected state: ${job.status} (last event: ${lastEvent?.data.detail ?? "none"})`)
}
