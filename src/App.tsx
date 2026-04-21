import { useState, useEffect } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import { useResearchStore } from "@/stores/research-store"
import { useActivityStore } from "@/stores/activity-store"
import { useLintStore } from "@/stores/lint-store"
import { listDirectory, openProject } from "@/commands/fs"
import { getLastProject, getRecentProjects, saveLastProject, loadLlmConfig, loadLanguage, loadSearchApiConfig, loadEmbeddingConfig } from "@/lib/project-store"
import { loadReviewItems, loadChatHistory } from "@/lib/persist"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { startApiServer } from "@/lib/api-server"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"

function App() {
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)

  // Set up auto-save, clip watcher, and the MCP-bridge dispatcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
    startApiServer().catch((err) => {
      console.error("Failed to start MCP API dispatcher:", err)
    })
  }, [])

  // Auto-open last project on startup
  useEffect(() => {
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        const lastProject = await getLastProject()
        if (lastProject) {
          try {
            const proj = await openProject(lastProject.path)
            await handleProjectOpened(proj)
          } catch {
            // Last project no longer valid
          }
        }
      } catch {
        // ignore init errors
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  async function handleProjectOpened(proj: WikiProject) {
    // Wipe every per-project store BEFORE we flip `project`, so nothing from
    // the previous wiki lingers in memory (review suggestions, saved chats,
    // research tasks, activity feed, last lint run). Without this, the
    // auto-save subscriber would happily write the old project's items into
    // the newly opened project's `.llm-wiki/` folder.
    useReviewStore.getState().clear()
    useChatStore.getState().clear()
    useResearchStore.getState().clear()
    useActivityStore.getState().clear()
    useLintStore.getState().clear()

    setProject(proj)
    setSelectedFile(null)
    setActiveView("wiki")
    await saveLastProject(proj)

    // Restore ingest queue (resume interrupted tasks)
    import("@/lib/ingest-queue").then(({ restoreQueue }) => {
      restoreQueue(proj.path).catch((err) =>
        console.error("Failed to restore ingest queue:", err)
      )
    })
    // Notify local clip server of the current project + all recent projects
    fetch("http://127.0.0.1:19827/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proj.path }),
    }).catch(() => {})

    // Send all recent projects to clip server for extension project picker
    getRecentProjects().then((recents) => {
      const projects = recents.map((p) => ({ name: p.name, path: p.path }))
      fetch("http://127.0.0.1:19827/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects }),
      }).catch(() => {})
    }).catch(() => {})
    try {
      const tree = await listDirectory(proj.path)
      setFileTree(tree)
    } catch (err) {
      console.error("Failed to load file tree:", err)
    }
    // Load persisted review items. Always call setItems — even with an empty
    // array — so the store reflects this project's state exactly and doesn't
    // keep whatever happened to be there before.
    try {
      const savedReview = await loadReviewItems(proj.path)
      useReviewStore.getState().setItems(savedReview)
    } catch {
      useReviewStore.getState().setItems([])
    }
    // Load persisted chat history. Same invariant: always replace, never
    // "skip on empty". Also pick a sensible active conversation (or null).
    try {
      const savedChat = await loadChatHistory(proj.path)
      useChatStore.getState().setConversations(savedChat.conversations)
      useChatStore.getState().setMessages(savedChat.messages)
      const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      useChatStore.getState().setActiveConversation(sorted[0]?.id ?? null)
    } catch {
      useChatStore.getState().setConversations([])
      useChatStore.getState().setMessages([])
      useChatStore.getState().setActiveConversation(null)
    }
  }

  async function handleSelectRecent(proj: WikiProject) {
    try {
      const validated = await openProject(proj.path)
      await handleProjectOpened(validated)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleOpenProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Wiki Project",
    })
    if (!selected) return
    try {
      const proj = await openProject(selected)
      await handleProjectOpened(proj)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  function handleSwitchProject() {
    // Going back to the welcome screen: drop the project AND every store that
    // holds project-scoped data, otherwise the next project we open can flash
    // the previous project's reviews/chats/research/etc. before load finishes
    // (and auto-save would then persist the stale data into the new project).
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
    useReviewStore.getState().clear()
    useChatStore.getState().clear()
    useResearchStore.getState().clear()
    useActivityStore.getState().clear()
    useLintStore.getState().clear()
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectOpened}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectOpened}
      />
    </>
  )
}

export default App
