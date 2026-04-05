import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core"
import { commonmark } from "@milkdown/kit/preset/commonmark"
import { history } from "@milkdown/kit/plugin/history"
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener"
import { nord } from "@milkdown/theme-nord"
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react"
import "@milkdown/theme-nord/style.css"

interface WikiEditorInnerProps {
  content: string
  onSave: (markdown: string) => void
}

function WikiEditorInner({ content, onSave }: WikiEditorInnerProps) {
  useEditor(
    (root) =>
      Editor.make()
        .config(nord)
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, content)
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onSave(markdown)
          })
        })
        .use(commonmark)
        .use(history)
        .use(listener),
    [content],
  )

  return <Milkdown />
}

interface WikiEditorProps {
  content: string
  onSave: (markdown: string) => void
}

export function WikiEditor({ content, onSave }: WikiEditorProps) {
  return (
    <MilkdownProvider>
      <div className="prose prose-invert min-w-0 max-w-none overflow-hidden p-6">
        <WikiEditorInner content={content} onSave={onSave} />
      </div>
    </MilkdownProvider>
  )
}
