import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

/**
 * Shared store for the most recent lint run, regardless of who triggered it.
 *
 * Both the GUI's "Run Lint" button and the MCP/CLI `POST /api/lint` handler
 * write into this store so the Wiki Lint panel always reflects the latest
 * results — without it, lint kicked off by an agent would never surface in
 * the GUI even though the work ran.
 *
 * `projectPath` is captured so we can hide stale results after the user
 * switches projects.
 */
export interface LintRun {
  results: LintResult[]
  /** Whether semantic LLM lint was included in this run. */
  semantic: boolean
  /** Source of the run, useful for showing a small badge in the UI. */
  source: "gui" | "mcp"
  /** Project the results belong to (normalized absolute path). */
  projectPath: string
  /** Wall-clock timestamp the run finished. */
  finishedAt: number
}

interface LintState {
  /** Most recent finished run, or null if no run has happened this session. */
  lastRun: LintRun | null
  /** True while a lint is in flight (either source). */
  running: boolean

  /** Mark the start of a run. Optional — purely for spinner UX. */
  beginRun: (source: "gui" | "mcp") => void
  /** Replace the last run with a fresh result set. Also clears `running`. */
  setResults: (run: LintRun) => void
  /** Drop a single issue (e.g. after the user "fixes" it via the panel). */
  removeAt: (index: number) => void
  /** Wipe everything (e.g. project switch). */
  clear: () => void
}

export const useLintStore = create<LintState>((set) => ({
  lastRun: null,
  running: false,

  beginRun: (_source) => set({ running: true }),

  setResults: (run) => set({ lastRun: run, running: false }),

  removeAt: (index) =>
    set((state) => {
      if (!state.lastRun) return state
      const next = state.lastRun.results.filter((_, i) => i !== index)
      return { lastRun: { ...state.lastRun, results: next } }
    }),

  clear: () => set({ lastRun: null, running: false }),
}))
