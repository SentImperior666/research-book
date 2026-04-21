import { useWikiStore } from "@/stores/wiki-store"
import { autoIngest } from "./ingest"
import { listDirectory } from "@/commands/fs"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running

  intervalId = setInterval(async () => {
    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (!data.ok || !data.clips || data.clips.length === 0) return

      const store = useWikiStore.getState()
      const project = store.project
      const llmConfig = store.llmConfig
      const llmReady =
        llmConfig.apiKey ||
        llmConfig.provider === "ollama" ||
        llmConfig.provider === "custom"

      for (const clip of data.clips) {
        const clipProjectPath: string = clip.projectPath
        const clipFilePath: string = clip.filePath

        // Refresh file tree only if clip is for current project
        if (project && clipProjectPath === project.path) {
          try {
            const tree = await listDirectory(project.path)
            store.setFileTree(tree)
          } catch {
            // ignore
          }
        }

        // Auto-ingest regardless of which project the clip was saved to, so
        // clips saved while a different project is active still get picked up.
        if (llmReady) {
          autoIngest(clipProjectPath, clipFilePath, llmConfig).catch((err) => {
            console.error("Failed to auto-ingest web clip:", err)
          })
        }
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
