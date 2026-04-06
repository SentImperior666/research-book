import { webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { writeFile, listDirectory } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"

let processing = false

/**
 * Queue a deep research task. Automatically starts processing if under concurrency limit.
 */
export function queueResearch(
  projectPath: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
): string {
  const store = useResearchStore.getState()
  const taskId = store.addTask(topic)
  processQueue(projectPath, llmConfig, searchConfig)
  return taskId
}

/**
 * Process queued tasks up to maxConcurrent limit.
 */
function processQueue(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const store = useResearchStore.getState()
  const running = store.getRunningCount()
  const available = store.maxConcurrent - running

  for (let i = 0; i < available; i++) {
    const next = useResearchStore.getState().getNextQueued()
    if (!next) break
    executeResearch(projectPath, next.id, next.topic, llmConfig, searchConfig)
  }
}

async function executeResearch(
  projectPath: string,
  taskId: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const store = useResearchStore.getState()

  try {
    // Step 1: Web search
    store.updateTask(taskId, { status: "searching" })

    const webResults = await webSearch(topic, searchConfig, 8)
    store.updateTask(taskId, { webResults })

    if (webResults.length === 0) {
      store.updateTask(taskId, { status: "done", synthesis: "No web results found." })
      onTaskFinished(projectPath, llmConfig, searchConfig)
      return
    }

    // Step 2: LLM synthesis
    store.updateTask(taskId, { status: "synthesizing" })

    const searchContext = webResults
      .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
      .join("\n\n")

    const systemPrompt = [
      "You are a research assistant. Synthesize the web search results into a comprehensive wiki page.",
      "- Organize into clear sections with headings",
      "- Cite sources using [N] notation",
      "- Note contradictions or gaps",
      "- Suggest additional sources worth finding",
      "- Neutral, encyclopedic tone",
      "- Use [[wikilink]] for cross-references",
    ].join("\n")

    let accumulated = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Research topic: **${topic}**\n\n## Web Search Results\n\n${searchContext}\n\nSynthesize into a wiki page.` },
      ],
      {
        onToken: (token) => {
          accumulated += token
          // Update synthesis progressively so UI shows real-time text
          useResearchStore.getState().updateTask(taskId, { synthesis: accumulated })
        },
        onDone: () => {},
        onError: (err) => {
          useResearchStore.getState().updateTask(taskId, {
            status: "error",
            error: err.message,
          })
        },
      },
    )

    // Check if errored during streaming
    if (useResearchStore.getState().tasks.find((t) => t.id === taskId)?.status === "error") {
      onTaskFinished(projectPath, llmConfig, searchConfig)
      return
    }

    // Step 3: Save to wiki
    store.updateTask(taskId, { status: "saving", synthesis: accumulated })

    const date = new Date().toISOString().slice(0, 10)
    const slug = topic.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 50)
    const fileName = `research-${slug}-${date}.md`
    const filePath = `${projectPath}/wiki/queries/${fileName}`

    const references = webResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")

    const pageContent = [
      "---",
      `type: query`,
      `title: "Research: ${topic.replace(/"/g, '\\"')}"`,
      `created: ${date}`,
      `origin: deep-research`,
      `tags: [research]`,
      "---",
      "",
      `# Research: ${topic}`,
      "",
      accumulated,
      "",
      "## References",
      "",
      references,
      "",
    ].join("\n")

    await writeFile(filePath, pageContent)
    const savedPath = `wiki/queries/${fileName}`

    useResearchStore.getState().updateTask(taskId, {
      status: "done",
      savedPath,
    })

    // Refresh tree
    try {
      const tree = await listDirectory(projectPath)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useResearchStore.getState().updateTask(taskId, {
      status: "error",
      error: message,
    })
  }

  onTaskFinished(projectPath, llmConfig, searchConfig)
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
