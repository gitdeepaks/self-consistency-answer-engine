"use client"

import { runTagSchema } from "@sce/shared"
import { Plus, X } from "lucide-react"
import { useState, type KeyboardEvent, type ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { useApi } from "@/lib/api/browser"

/**
 * Labels on a run.
 *
 * A token field: type, press Enter or comma, and it is saved. The whole set is
 * sent on every change rather than a patch, because the field's contents *are*
 * the desired state — a client-computed diff would need a base version it does
 * not have, and two people editing tags at once would produce a union neither
 * asked for.
 *
 * The tag is parsed with the shared schema *before* it is sent, so the error a
 * person sees names the rule ("a-z 0-9 . _ -") rather than being a 400 they
 * have to interpret. The API parses it again; this is an affordance, not the
 * enforcement.
 */
export function TagEditor({
  runId,
  initialTags,
}: {
  runId: string
  initialTags: readonly string[]
}): ReactElement {
  const api = useApi()
  const [tags, setTags] = useState<readonly string[]>(initialTags)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  const save = async (next: readonly string[]): Promise<void> => {
    const previous = tags
    setTags(next)
    setError(null)
    try {
      setTags(await api.setRunTags(runId, next))
    } catch (caught: unknown) {
      // Rolled back rather than left showing a tag that was never stored — a
      // label that survives on screen but not in the database is worse than one
      // that visibly failed.
      setTags(previous)
      setError(caught instanceof Error ? caught.message : "Could not save tags")
    }
  }

  const add = (): void => {
    const parsed = runTagSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That is not a valid tag")
      return
    }
    if (tags.includes(parsed.data)) {
      setDraft("")
      return
    }
    if (tags.length >= 16) {
      setError("A run may carry at most 16 tags")
      return
    }
    setDraft("")
    void save([...tags, parsed.data])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      add()
      return
    }
    // Backspace on an empty field removes the last tag — the behaviour every
    // token field has, and the one people try before reaching for the ×.
    if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
      void save(tags.slice(0, -1))
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} tone="neutral" className="pr-1">
            {tag}
            <button
              type="button"
              onClick={() => void save(tags.filter((entry) => entry !== tag))}
              className="ml-0.5 rounded-full p-0.5 text-ink-faint hover:bg-surface-raised hover:text-ink"
            >
              <X className="size-3" aria-hidden="true" />
              <span className="sr-only">Remove the tag {tag}</span>
            </button>
          </Badge>
        ))}

        <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5">
          <Plus className="size-3 text-ink-faint" aria-hidden="true" />
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (draft.trim().length > 0) add()
            }}
            maxLength={32}
            placeholder="Add a tag"
            aria-label="Add a tag"
            className="w-24 bg-transparent text-xs text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </span>
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
