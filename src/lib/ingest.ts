import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"

const FILE_BLOCK_REGEX = /---FILE:\s*([^\n-]+?)\s*---\n([\s\S]*?)---END FILE---/g

/**
 * Auto-ingest: reads source → LLM analyzes → LLM writes wiki pages, all in one go.
 * Used when importing new files.
 */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sourcePath)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sourcePath),
    tryReadFile(`${projectPath}/schema.md`),
    tryReadFile(`${projectPath}/purpose.md`),
    tryReadFile(`${projectPath}/wiki/index.md`),
  ])

  const fileName = sourcePath.split("/").pop() ?? sourcePath

  const systemPrompt = [
    "You are a wiki maintainer. You will read a source document and directly produce wiki files.",
    "",
    "## Output Format",
    "",
    "Output wiki files in this format:",
    "",
    "---FILE: wiki/sources/filename.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "",
    "For each source, produce:",
    "1. A source summary page in wiki/sources/",
    "2. Entity pages in wiki/entities/ for key entities (people, organizations, products)",
    "3. Concept pages in wiki/concepts/ for key concepts (theories, methods, techniques)",
    "4. An updated wiki/index.md with new entries added to existing categories",
    "5. A log entry for wiki/log.md (just the new entry to append)",
    "",
    "Use YAML frontmatter on every page. Use [[wikilink]] syntax for cross-references.",
    "Use kebab-case filenames.",
    "",
    "## Review Items",
    "",
    "After the FILE blocks, if you find anything that needs human judgment, output REVIEW blocks:",
    "",
    "---REVIEW: type | Title---",
    "Description of what needs attention.",
    "OPTIONS: Option A | Option B | Option C",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "---END REVIEW---",
    "",
    "Review types: contradiction, duplicate, missing-page, suggestion",
    "Only create reviews for things that genuinely need human input. Examples:",
    "- Contradiction: new source conflicts with existing wiki content",
    "- Duplicate: an entity/concept might already exist under a different name",
    "- Missing page: an important concept is referenced but has no dedicated page yet",
    "- Suggestion: ideas for further research or sources to look for",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index (add to this, don't remove existing entries)\n${index}` : "",
  ].filter(Boolean).join("\n")

  const userMessage = `Ingest this source into the wiki:\n\n**File:** ${fileName}\n\n---\n\n${sourceContent.length > 50000 ? sourceContent.slice(0, 50000) + "\n\n[...truncated...]" : sourceContent}`

  store.addMessage("system", `Auto-ingesting: ${fileName}`)
  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during auto-ingest: ${err.message}`)
      },
    },
    signal,
  )

  // Parse and write files
  const writtenPaths = await writeFileBlocks(projectPath, accumulated)

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `✓ Wiki updated (${writtenPaths.length} files):\n${fileList}`)

    // Refresh file tree
    try {
      const tree = await listDirectory(projectPath)
      useWikiStore.getState().setFileTree(tree)
    } catch {
      // ignore
    }
  } else {
    getStore().addMessage("system", "No wiki files were generated.")
  }

  // Parse and add review items
  const reviewItems = parseReviewBlocks(accumulated, sourcePath)
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
    getStore().addMessage("system", `📋 ${reviewItems.length} item(s) added to Review for your attention.`)
  }

  return writtenPaths
}

async function writeFileBlocks(projectPath: string, text: string): Promise<string[]> {
  const writtenPaths: string[] = []
  const matches = text.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    const relativePath = match[1].trim()
    const content = match[2]
    if (!relativePath) continue

    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  return writtenPaths
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Description is the body minus OPTIONS and PAGES lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      options,
    })
  }

  return items
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sourcePath)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sourcePath),
    tryReadFile(`${projectPath}/wiki/schema.md`),
    tryReadFile(`${projectPath}/wiki/purpose.md`),
    tryReadFile(`${projectPath}/wiki/index.md`),
  ])

  const fileName = sourcePath.split("/").pop() ?? sourcePath

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const store = getStore()

  const [schema, index] = await Promise.all([
    tryReadFile(`${projectPath}/wiki/schema.md`),
    tryReadFile(`${projectPath}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    const relativePath = match[1].trim()
    const content = match[2]

    if (!relativePath) continue

    const fullPath = `${projectPath}/${relativePath}`

    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  return writtenPaths
}
