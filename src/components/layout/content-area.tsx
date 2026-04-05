import { useEffect, useCallback, useRef } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { ChatBar } from "./chat-bar"
import { SettingsView } from "@/components/settings/settings-view"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"

export function ContentArea() {
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const activeView = useWikiStore((s) => s.activeView)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const chatExpanded = useWikiStore((s) => s.chatExpanded)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      return
    }

    const category = getFileCategory(selectedFile)

    // Don't try to read binary files as text
    if (isBinary(category)) {
      setFileContent("")
      return
    }

    // For PDF, read_file extracts text on Rust side
    // For text/code/data/markdown, read as text
    readFile(selectedFile)
      .then(setFileContent)
      .catch((err) => setFileContent(`Error loading file: ${err}`))
  }, [selectedFile, setFileContent])

  const handleSave = useCallback(
    (markdown: string) => {
      if (!selectedFile) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        writeFile(selectedFile, markdown).catch((err) =>
          console.error("Failed to save:", err)
        )
      }, 1000)
    },
    [selectedFile]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (activeView === "settings") {
    return <SettingsView />
  }

  if (activeView === "sources") {
    return <SourcesView />
  }

  if (activeView === "review") {
    return <ReviewView />
  }

  const category = selectedFile ? getFileCategory(selectedFile) : null

  const editorContent = (
    <div className="h-full min-w-0 overflow-auto">
      {selectedFile ? (
        category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          Select a file from the tree to view
        </div>
      )}
    </div>
  )

  if (!chatExpanded) {
    return (
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">{editorContent}</div>
        <ChatBar />
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">{editorContent}</div>
      <div className="h-1.5 shrink-0 cursor-row-resize bg-border/40 transition-colors hover:bg-primary/30" />
      <div className="h-64 shrink-0 overflow-hidden">
        <ChatBar />
      </div>
    </div>
  )
}
