import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getRelativePath, normalizePath } from "@/lib/path-utils"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

/**
 * Normalize a wikilink target or page identifier into a stable lookup key.
 *
 * Lowercases, strips file extension and anchor (`Page#Section`), collapses any
 * non-alphanumeric run into a single "-", and trims edge dashes. This lets us
 * resolve all of these to the same page:
 *   - `overview`            (filename slug)
 *   - `Project Overview`    (title, as the LLM tends to write it)
 *   - `project-overview`    (kebab title)
 *   - `Project_Overview`    (Obsidian style)
 *   - `Overview#Goals`      (with section anchor)
 */
function normalizeKey(value: string): string {
  return value
    .replace(/#.*$/, "") // drop section anchor
    .replace(/\.md$/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Collect all human-readable titles a markdown page is known by, in priority
 * order: YAML `title:` frontmatter first, then the first H1. Both are aliased
 * onto the page in the slug index so links can resolve by either form.
 *
 * Why both? The default `wiki/overview.md` template has `title: Project
 * Overview` in frontmatter but `# Overview` as its H1. The LLM (and humans)
 * naturally write `[[Project Overview]]`, which would otherwise be flagged
 * broken even though the page is right there.
 */
function extractTitles(content: string): string[] {
  const titles: string[] = []

  // YAML frontmatter `title:` (quoted or bare).
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3)
    if (end !== -1) {
      const frontmatter = content.slice(3, end)
      const titleMatch = frontmatter.match(/^\s*title\s*:\s*(.+?)\s*$/m)
      if (titleMatch) {
        const raw = titleMatch[1].replace(/^["'](.*)["']$/, "$1").trim()
        if (raw) titles.push(raw)
      }
    }
  }

  // First H1 of the body (skip past frontmatter so a stray `# foo` in YAML
  // doesn't win).
  let body = content
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3)
    if (end !== -1) body = body.slice(end + 4)
  }
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m)
  if (h1) titles.push(h1[1].trim())

  return titles
}

interface SlugIndex {
  /** All known keys → absolute file path. */
  byKey: Map<string, string>
  /** Absolute file path → canonical relative slug (used for inbound counts). */
  pathToSlug: Map<string, string>
}

/**
 * Build a forgiving lookup map from many name shapes → wiki page path. Any of
 * relative path, filename, page title, or kebab forms thereof will resolve to
 * the same file.
 */
async function buildSlugIndex(
  wikiFiles: FileNode[],
  wikiRoot: string,
): Promise<SlugIndex> {
  const byKey = new Map<string, string>()
  const pathToSlug = new Map<string, string>()

  const register = (raw: string, abs: string) => {
    const key = normalizeKey(raw)
    if (!key) return
    // First writer wins so a more "canonical" name (relative path) takes
    // precedence over later aliases (basename, title) on collision.
    if (!byKey.has(key)) byKey.set(key, abs)
  }

  for (const f of wikiFiles) {
    const relPath = getRelativePath(f.path, wikiRoot)
    const slug = relPath.replace(/\.md$/, "")
    pathToSlug.set(f.path, slug)

    // Path-based aliases.
    register(slug, f.path)
    register(f.name, f.path)
    register(f.name.replace(/\.md$/, ""), f.path)

    // Title-based aliases (frontmatter `title:` and first H1). Best-effort —
    // missing/unreadable files just get fewer aliases and still resolve via
    // filename.
    try {
      const content = await readFile(f.path)
      for (const title of extractTitles(content)) register(title, f.path)
    } catch {
      // ignore — page just won't be resolvable by title.
    }
  }

  return { byKey, pathToSlug }
}

// ── Structural lint ───────────────────────────────────────────────────────────

export async function runStructuralLint(projectPath: string): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  // Index ALL wiki files (including index/log) so links to them resolve, but
  // only consider `contentFiles` for orphan/no-outlink reports below.
  const slugIndex = await buildSlugIndex(wikiFiles, wikiRoot)

  // Read all content files
  type PageData = { path: string; slug: string; content: string; outlinks: string[] }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
      const outlinks = extractWikilinks(content)
      pages.push({ path: f.path, slug, content, outlinks })
    } catch {
      // skip unreadable files
    }
  }

  // Build inbound link count keyed by canonical slug. Self-links don't count
  // toward inbound — a page that only links to itself is still an orphan.
  const inboundCounts = new Map<string, number>()
  for (const p of pages) {
    for (const link of p.outlinks) {
      const targetPath = slugIndex.byKey.get(normalizeKey(link))
      if (!targetPath || targetPath === p.path) continue
      const targetSlug = slugIndex.pathToSlug.get(targetPath)
      if (!targetSlug) continue
      inboundCounts.set(targetSlug, (inboundCounts.get(targetSlug) ?? 0) + 1)
    }
  }

  const results: LintResult[] = []

  for (const p of pages) {
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links
    const inbound = inboundCounts.get(p.slug) ?? 0
    if (inbound === 0) {
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
      })
    }

    // Broken links — resolve through the forgiving index (path slug, basename,
    // page title, kebab/title variants, with `#anchor` stripped).
    for (const link of p.outlinks) {
      const exists = slugIndex.byKey.has(normalizeKey(link))
      if (!exists) {
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: `Broken link: [[${link}]] — target page not found.`,
        })
      }
    }
  }

  return results
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars)
  const summaries: string[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    "## Language Rule",
    "- Match the language of the wiki content. If pages are in Chinese, write issues in Chinese. If in English, use English.",
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // semantic results always use type "semantic"
    void rawType

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}
