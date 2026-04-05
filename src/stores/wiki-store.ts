import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"

interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "ollama" | "custom"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
}

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: string
  chatExpanded: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "settings"
  llmConfig: LlmConfig

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setChatExpanded: (expanded: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  selectedFile: null,
  fileContent: "",
  chatExpanded: false,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
  },

  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setActiveView: (activeView) => set({ activeView }),
  setLlmConfig: (llmConfig) => set({ llmConfig }),
}))

export type { WikiState, LlmConfig }
