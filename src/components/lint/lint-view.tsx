import { useState, useCallback } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
  Bot,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { runStructuralLint, runSemanticLint, type LintResult } from "@/lib/lint"
import { readFile, writeFile, deleteFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }> = {
  orphan: { icon: Unlink, label: "Orphan Page" },
  "broken-link": { icon: Link2Off, label: "Broken Link" },
  "no-outlinks": { icon: ArrowUpRight, label: "No Outbound Links" },
  semantic: { icon: BrainCircuit, label: "Semantic Issue" },
}

export function LintView() {
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const lastRun = useLintStore((s) => s.lastRun)
  const running = useLintStore((s) => s.running)
  const beginRun = useLintStore((s) => s.beginRun)
  const setRunResults = useLintStore((s) => s.setResults)
  const removeAt = useLintStore((s) => s.removeAt)

  // Only display results that belong to the currently open project so
  // switching projects doesn't surface stale lint from a different wiki.
  const projectPath = project ? normalizePath(project.path) : null
  const activeRun = lastRun && projectPath && lastRun.projectPath === projectPath ? lastRun : null
  const results = activeRun?.results ?? []
  const hasRun = activeRun !== null
  const lastSource = activeRun?.source ?? null

  const [runSemantic, setRunSemantic] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    beginRun("gui")
    try {
      const structural = await runStructuralLint(pp)
      let all = structural
      const includeSemantic =
        runSemantic && (llmConfig.apiKey || llmConfig.provider === "ollama")

      if (includeSemantic) {
        const semantic = await runSemanticLint(pp, llmConfig)
        all = [...structural, ...semantic]
      }

      setRunResults({
        results: all,
        semantic: includeSemantic,
        source: "gui",
        projectPath: pp,
        finishedAt: Date.now(),
      })
    } catch (err) {
      console.error("Lint failed:", err)
      setRunResults({
        results: [],
        semantic: runSemantic,
        source: "gui",
        projectPath: pp,
        finishedAt: Date.now(),
      })
    }
  }, [project, llmConfig, running, runSemantic, beginRun, setRunResults])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    setActiveView("wiki")
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        return
      } catch {
        // try next
      }
    }
    setSelectedFile(candidates[0])
    setFileContent(`Unable to load: ${page}`)
  }

  async function handleFix(result: LintResult, index: number) {
    if (!project) return
    const pp = normalizePath(project.path)
    const id = `${result.type}-${index}`
    setFixingId(id)

    try {
      switch (result.type) {
        case "orphan": {
          // Add a link to this page from index.md
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

          const pageName = result.page.replace(".md", "").replace(/^.*\//, "")
          const entry = `- [[${pageName}]]`
          if (!indexContent.includes(entry)) {
            indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
            await writeFile(indexPath, indexContent)
          }
          // Remove from results
          removeAt(index)
          break
        }

        case "broken-link": {
          // Option: remove the broken link from the page, or send to Review for manual fix
          const pagePath = `${pp}/wiki/${result.page}`
          useReviewStore.getState().addItem({
            type: "confirm",
            title: `Fix broken link in ${result.page}`,
            description: result.detail,
            affectedPages: [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Delete Page", action: `delete:${pagePath}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          removeAt(index)
          break
        }

        case "no-outlinks": {
          // Send to Review — user should add links manually
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: `Add cross-references to ${result.page}`,
            description: "This page has no outbound [[wikilinks]]. Consider adding cross-references to related entities and concepts.",
            affectedPages: [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          removeAt(index)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          useReviewStore.getState().addItem({
            type: "confirm",
            title: result.detail.slice(0, 80),
            description: result.detail,
            affectedPages: result.affectedPages ?? [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          removeAt(index)
          break
        }
      }

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Fix failed:", err)
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(result: LintResult, index: number) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${result.page}`
    const confirmed = window.confirm(`Delete orphan page "${result.page}"?`)
    if (!confirmed) return

    try {
      await deleteFile(pagePath)
      removeAt(index)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const warnings = results.filter((r) => r.severity === "warning")
  const infos = results.filter((r) => r.severity === "info")

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Wiki Lint</h2>
          {hasRun && results.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {results.length} issue{results.length !== 1 ? "s" : ""}
            </span>
          )}
          {lastSource === "mcp" && (
            <span
              title="Last lint run was triggered by an MCP/CLI agent"
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400"
            >
              <Bot className="h-3 w-3" />
              MCP
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => setRunSemantic(e.target.checked)}
            />
            Semantic (LLM)
          </label>
          <Button
            size="sm"
            onClick={handleRunLint}
            disabled={running || !project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? "Running..." : "Run Lint"}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!hasRun ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>Run lint to check wiki health</p>
            <p className="text-xs">Checks for orphan pages, broken links, and more</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">All clear!</p>
            <p className="text-xs">No issues found.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label="Warnings" count={warnings.length} color="text-amber-500" />
            )}
            {warnings.map((result, i) => (
              <LintCard
                key={`warn-${i}`}
                result={result}
                index={i}
                fixing={fixingId === `${result.type}-${i}`}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={result.type === "orphan" ? handleDeleteOrphan : undefined}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label="Info" count={infos.length} color="text-blue-500" />
            )}
            {infos.map((result, i) => {
              const realIndex = warnings.length + i
              return (
                <LintCard
                  key={`info-${i}`}
                  result={result}
                  index={realIndex}
                  fixing={fixingId === `${result.type}-${realIndex}`}
                  onOpenPage={handleOpenPage}
                  onFix={handleFix}
                  onDelete={result.type === "orphan" ? handleDeleteOrphan : undefined}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  color,
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {label} ({count})
    </div>
  )
}

function LintCard({
  result,
  index,
  fixing,
  onOpenPage,
  onFix,
  onDelete,
}: {
  result: LintResult
  index: number
  fixing: boolean
  onOpenPage: (page: string) => void
  onFix: (result: LintResult, index: number) => void
  onDelete?: (result: LintResult, index: number) => void
}) {
  const config = typeConfig[result.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            result.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{result.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{result.detail}</p>

      {result.affectedPages && result.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {result.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(result.page)}
        >
          Open
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(result, index)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? "Fixing..." : "Fix"}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(result, index)}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
