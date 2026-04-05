import {
  AlertTriangle,
  Copy,
  FileQuestion,
  CheckCircle2,
  Lightbulb,
  MessageSquare,
  X,
  Check,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"

const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; label: string; color: string }> = {
  contradiction: { icon: AlertTriangle, label: "Contradiction", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "Possible Duplicate", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "Missing Page", color: "text-purple-500" },
  confirm: { icon: MessageSquare, label: "Needs Confirmation", color: "text-foreground" },
  suggestion: { icon: Lightbulb, label: "Suggestion", color: "text-emerald-500" },
}

export function ReviewView() {
  const items = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)

  const pending = items.filter((i) => !i.resolved)
  const resolved = items.filter((i) => i.resolved)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          Review
          {pending.length > 0 && (
            <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
              {pending.length}
            </span>
          )}
        </h2>
        {resolved.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearResolved} className="text-xs">
            <Trash2 className="mr-1 h-3 w-3" />
            Clear resolved
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>All clear — nothing to review</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {pending.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={resolveItem}
                onDismiss={dismissItem}
              />
            ))}
            {resolved.length > 0 && pending.length > 0 && (
              <div className="my-2 text-center text-xs text-muted-foreground">
                — Resolved —
              </div>
            )}
            {resolved.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={resolveItem}
                onDismiss={dismissItem}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function ReviewCard({
  item,
  onResolve,
  onDismiss,
}: {
  item: ReviewItem
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
}) {
  const config = typeConfig[item.type]
  const Icon = config.icon

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-opacity ${
        item.resolved ? "opacity-50" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
          <span className="font-medium">{item.title}</span>
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">{item.description}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-3 text-xs text-muted-foreground">
          Pages: {item.affectedPages.join(", ")}
        </div>
      )}

      {!item.resolved ? (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((opt) => (
            <Button
              key={opt.action}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onResolve(item.id, opt.action)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-emerald-600">
          <Check className="h-3 w-3" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}
