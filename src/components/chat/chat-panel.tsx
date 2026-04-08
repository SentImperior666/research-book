import { useRef, useEffect, useCallback } from "react"
import { BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { useReviewStore } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

export function ChatPanel() {
  useSourceFiles() // Keep source file cache warm
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages, streamingContent])

  const handleSend = useCallback(
    async (text: string) => {
      addMessage("user", text)
      setStreaming(true)

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      if (project) {
        const dataVersion = useWikiStore.getState().dataVersion
        const [index, purpose] = await Promise.all([
          readFile(`${project.path}/wiki/index.md`).catch(() => ""),
          readFile(`${project.path}/purpose.md`).catch(() => ""),
        ])

        // --- Phase 1: Tokenized search -> top 10 ---
        const searchResults = await searchWiki(project.path, text)
        const topSearchResults = searchResults.slice(0, 10)

        // --- Phase 2: Graph 1-level expansion ---
        const graph = await buildRetrievalGraph(project.path, dataVersion)
        const expandedIds = new Set<string>()
        const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        for (const result of topSearchResults) {
          // Derive node ID from file path (kebab-case filename without .md)
          const fileName = result.path.split("/").pop() ?? ""
          const nodeId = fileName.replace(/\.md$/, "")
          const related = getRelatedNodes(nodeId, graph, 3)
          for (const { node, relevance } of related) {
            if (relevance < 2.0) continue
            if (searchHitPaths.has(node.path)) continue
            if (expandedIds.has(node.id)) continue
            expandedIds.add(node.id)
            graphExpansions.push({
              title: node.title,
              path: node.path,
              relevance,
            })
          }
        }
        // Sort graph expansions by relevance descending
        graphExpansions.sort((a, b) => b.relevance - a.relevance)

        // --- Phase 3 & 4: Budget control with priority queue ---
        // Use ~60% of max context for page content, rest for prompt + history + response
        const TOTAL_BUDGET = Math.floor(llmConfig.maxContextSize * 0.6)
        const MAX_PAGE_SIZE = Math.min(Math.floor(TOTAL_BUDGET * 0.3), 30_000)
        let usedChars = 0

        type PageEntry = { title: string; path: string; content: string; priority: number }
        const relevantPages: PageEntry[] = []

        // Helper to add a page within budget
        const tryAddPage = async (
          title: string,
          filePath: string,
          priority: number,
        ): Promise<boolean> => {
          if (usedChars >= TOTAL_BUDGET) return false
          try {
            const raw = await readFile(filePath)
            const relativePath = filePath.replace(project.path + "/", "")
            const truncated = raw.length > MAX_PAGE_SIZE
              ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
              : raw
            if (usedChars + truncated.length > TOTAL_BUDGET) return false
            usedChars += truncated.length
            relevantPages.push({ title, path: relativePath, content: truncated, priority })
            return true
          } catch {
            return false
          }
        }

        // P0: Title matches from search
        for (const r of topSearchResults.filter((r) => r.titleMatch)) {
          await tryAddPage(r.title, r.path, 0)
        }
        // P1: Content matches from search
        for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
          await tryAddPage(r.title, r.path, 1)
        }
        // P2: Graph expansions (already sorted by relevance)
        for (const exp of graphExpansions) {
          await tryAddPage(exp.title, exp.path, 2)
        }
        // P3: Overview fallback if nothing found
        if (relevantPages.length === 0) {
          await tryAddPage("Overview", `${project.path}/wiki/overview.md`, 3)
        }

        // Build numbered wiki context so AI can cite by number
        const pagesContext = relevantPages.length > 0
          ? relevantPages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        // Build page list for reference
        const pageList = relevantPages.map((p, i) =>
          `[${i + 1}] ${p.title} (${p.path})`
        ).join("\n")

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
            "",
            "## Language Rule",
            "- ALWAYS respond in the same language the user uses. If the user writes in Chinese, respond in Chinese. If in English, respond in English. Match the user's language exactly.",
            "",
            "## Rules",
            "- Answer based ONLY on the numbered wiki pages provided below.",
            "- If the provided pages don't contain enough information, say so honestly.",
            "- Use [[wikilink]] syntax to reference wiki pages.",
            "- When citing information, use the page number in brackets, e.g. [1], [2].",
            "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
            "  <!-- cited: 1, 3, 5 -->",
            "",
            "## Save Judgment",
            "- If your answer contains a valuable synthesis, comparison, analysis, or new insight worth preserving, add BEFORE the cited comment:",
            "  <!-- save-worthy: yes | Brief reason -->",
            "- Only for genuinely valuable answers. NOT for simple lookups.",
            "",
            "Use markdown formatting for clarity.",
            "",
            purpose ? `## Wiki Purpose\n${purpose}` : "",
            index ? `## Wiki Index\n${index}` : "",
            relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
            `## Wiki Pages\n\n${pagesContext}`,
          ].filter(Boolean).join("\n"),
        })

        // Store page mapping for SourceFilesBar to use
        lastQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
      }

      // Only include user and assistant messages in conversation history (not internal system messages)
      const allMessages = useChatStore.getState().messages
        .filter((m) => m.role === "user" || m.role === "assistant")
      const llmMessages = [...systemMessages, ...chatMessagesToLLM(allMessages)]

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            accumulated += token
            appendStreamToken(token)
          },
          onDone: () => {
            finalizeStream(accumulated)
            abortRef.current = null
            // Check if LLM marked this answer as save-worthy
            checkSaveWorthy(accumulated, text)
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`)
            abortRef.current = null
          },
        },
        controller.signal,
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    try {
      await executeIngestWrites(project.path, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(project.path)
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig, setFileTree])

  const hasAssistantMessages = messages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        <div className="flex flex-col gap-3">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {isStreaming && <StreamingMessage content={streamingContent} />}
          <div ref={bottomRef} />
        </div>
      </div>

      {showWriteButton && (
        <div className="border-t px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleWriteToWiki}
            className="w-full gap-2"
          >
            <BookOpen className="h-4 w-4" />
            Write to Wiki
          </Button>
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        placeholder={
          mode === "ingest"
            ? "Discuss the source or ask follow-up questions..."
            : "Type a message..."
        }
      />
    </div>
  )
}

/**
 * Check if the LLM marked its response as save-worthy.
 * If so, add a review item prompting the user to save it.
 */
function checkSaveWorthy(response: string, question: string) {
  const match = response.match(/<!--\s*save-worthy:\s*yes\s*\|\s*(.+?)\s*-->/)
  if (!match) return

  const reason = match[1]
  const firstLine = response.split("\n").find((l) => l.trim() && !l.startsWith("<!--"))?.replace(/^#+\s*/, "").trim() ?? "Chat answer"
  const title = firstLine.slice(0, 60)

  // Store the content reference so the review action can save it
  const contentToSave = response
  const questionText = question

  useReviewStore.getState().addItem({
    type: "suggestion",
    title: `Save to Wiki: ${title}`,
    description: `${reason}\n\nQuestion: "${questionText.slice(0, 100)}${questionText.length > 100 ? "..." : ""}"`,
    options: [
      { label: "Save to Wiki", action: `save:${encodeContent(contentToSave)}` },
      { label: "Skip", action: "Skip" },
    ],
  })
}

function encodeContent(text: string): string {
  // Use base64-like encoding to safely store content in action string
  return btoa(encodeURIComponent(text))
}

function flattenFileNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenFileNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
