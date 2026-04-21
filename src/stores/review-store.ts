import { create } from "zustand"

export interface ReviewOption {
  label: string
  action: string // identifier for the action
}

export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
  /** Wipe every review item (e.g. on project switch). */
  clear: () => void
}

function newReviewId(): string {
  // UUIDs avoid colliding with persisted review items after restart — a
  // session-local counter would start at 0 again and reuse ids that are
  // already on disk, making `resolve_review_item` ambiguous.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `review-${crypto.randomUUID()}`
  }
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          ...item,
          id: newReviewId(),
          resolved: false,
          createdAt: Date.now(),
        },
      ],
    })),

  addItems: (items) =>
    set((state) => ({
      items: [
        ...state.items,
        ...items.map((item) => ({
          ...item,
          id: newReviewId(),
          resolved: false,
          createdAt: Date.now(),
        })),
      ],
    })),

  setItems: (items) => set({ items }),

  resolveItem: (id, action) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action } : item
      ),
    })),

  dismissItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearResolved: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.resolved),
    })),

  clear: () => set({ items: [] }),
}))
