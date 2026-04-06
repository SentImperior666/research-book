import { useState } from "react"
import ReactMarkdown from "react-markdown"
import {
  Search, Loader2, CheckCircle2, AlertCircle, ChevronRight, ChevronDown, X,
  ExternalLink, FileText,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useResearchStore, type ResearchTask } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"

export function ResearchPanel() {
  const tasks = useResearchStore((s) => s.tasks)
  const removeTask = useResearchStore((s) => s.removeTask)
  const setPanelOpen = useResearchStore((s) => s.setPanelOpen)

  const running = tasks.filter((t) => ["searching", "synthesizing", "saving"].includes(t.status))
  const queued = tasks.filter((t) => t.status === "queued")
  const done = tasks.filter((t) => t.status === "done" || t.status === "error")

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Deep Research</span>
          {(running.length > 0 || queued.length > 0) && (
            <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {running.length} running{queued.length > 0 ? `, ${queued.length} queued` : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => setPanelOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
            <Search className="h-8 w-8 opacity-20" />
            <p>No research tasks yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {running.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
            {queued.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
            {done.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ResearchTaskCard({ task, onRemove }: { task: ResearchTask; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(
    task.status === "synthesizing" || task.status === "searching"
  )
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const project = useWikiStore((s) => s.project)

  const statusIcon = {
    queued: <div className="h-3 w-3 rounded-full border-2 border-muted-foreground" />,
    searching: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
    synthesizing: <Loader2 className="h-3 w-3 animate-spin text-purple-500" />,
    saving: <Loader2 className="h-3 w-3 animate-spin text-orange-500" />,
    done: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
    error: <AlertCircle className="h-3 w-3 text-destructive" />,
  }[task.status]

  const statusText = {
    queued: "Queued",
    searching: "Searching web...",
    synthesizing: "Synthesizing...",
    saving: "Saving to wiki...",
    done: task.savedPath ? "Saved" : "Done",
    error: "Failed",
  }[task.status]

  async function handleOpenSaved() {
    if (!project || !task.savedPath) return
    const path = `${project.path}/${task.savedPath}`
    try {
      const content = await readFile(path)
      setSelectedFile(path)
      setFileContent(content)
    } catch {
      // ignore
    }
  }

  return (
    <div className="rounded-lg border text-xs">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {statusIcon}
        <span className="flex-1 truncate font-medium">{task.topic}</span>
        <span className="shrink-0 text-muted-foreground">{statusText}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t px-3 py-2">
          {/* Error */}
          {task.error && (
            <p className="mb-2 text-destructive">{task.error}</p>
          )}

          {/* Web results */}
          {task.webResults.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-medium text-muted-foreground">
                Sources ({task.webResults.length})
              </div>
              <div className="flex flex-col gap-1">
                {task.webResults.map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5 rounded bg-muted/50 px-2 py-1">
                    <span className="shrink-0 font-mono text-muted-foreground">[{i + 1}]</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.title}</div>
                      <div className="truncate text-muted-foreground">{r.source}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Synthesis (streaming) */}
          {task.synthesis && (
            <div className="mb-2">
              <div className="mb-1 font-medium text-muted-foreground">Synthesis</div>
              <div className="max-h-64 overflow-y-auto rounded bg-muted/30 p-2 prose prose-xs prose-invert max-w-none">
                <ReactMarkdown>{task.synthesis}</ReactMarkdown>
                {task.status === "synthesizing" && (
                  <span className="animate-pulse">▊</span>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1.5 mt-2">
            {task.savedPath && (
              <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1" onClick={handleOpenSaved}>
                <FileText className="h-3 w-3" />
                Open
              </Button>
            )}
            {(task.status === "done" || task.status === "error") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] gap-1 text-muted-foreground"
                onClick={() => onRemove(task.id)}
              >
                <X className="h-3 w-3" />
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
