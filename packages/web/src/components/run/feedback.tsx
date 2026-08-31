"use client"

import {
  describeFeedbackReason,
  feedbackReasonSchema,
  type FeedbackRating,
  type FeedbackReason,
  type FeedbackSummary,
} from "@sce/shared"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { useEffect, useState, type ReactElement } from "react"
import { Button } from "@/components/ui/button"
import { Field, Select, TextArea } from "@/components/ui/field"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/api/browser"

/**
 * Was this answer any good?
 *
 * The cheapest ground truth this product will ever collect, and the design is
 * driven entirely by submission rate:
 *
 *   - **One click is a complete submission.** The rating is sent the moment it
 *     is pressed. The reason and the note are *invited* afterwards, never
 *     required — a form that demands an explanation before it accepts a
 *     thumbs-down collects far fewer thumbs-downs, and the click alone is
 *     already the signal worth having.
 *   - **Changing your mind is free.** The API upserts on `[runId, userId]`, so
 *     pressing the other thumb corrects the label rather than adding a second,
 *     contradictory one.
 *   - **The detail form only appears for a thumbs-down.** Asking somebody to
 *     categorise why they were happy is a tax on the good case.
 */
export function FeedbackControl({ runId }: { runId: string }): ReactElement {
  const api = useApi()
  const [summary, setSummary] = useState<FeedbackSummary | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [reason, setReason] = useState<FeedbackReason | "">("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .getFeedback(runId)
      .then((result) => {
        if (!cancelled) setSummary(result)
      })
      // A feedback panel that cannot load is not worth an error banner on top
      // of somebody's answer; it simply renders in its neutral state.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, runId])

  const send = async (rating: FeedbackRating, withDetail: boolean): Promise<void> => {
    setSaving(true)
    try {
      const parsedReason = feedbackReasonSchema.safeParse(reason)
      const result = await api.submitFeedback(runId, {
        rating,
        ...(withDetail && parsedReason.success ? { reason: parsedReason.data } : {}),
        ...(withDetail && note.trim().length > 0 ? { note: note.trim() } : {}),
      })
      setSummary(result)
      if (withDetail) {
        setExpanded(false)
        setSaved(true)
      } else {
        setExpanded(rating === "down")
      }
    } catch {
      // Deliberately quiet. Feedback is a courtesy the user is doing us; an
      // error toast for a failed courtesy is worse than losing the datum.
    } finally {
      setSaving(false)
    }
  }

  const mine = summary?.mine ?? null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-muted">Was this answer useful?</span>

        <div className="flex items-center gap-1">
          <Thumb
            direction="up"
            active={mine?.rating === "up"}
            disabled={saving}
            onClick={() => void send("up", false)}
          />
          <Thumb
            direction="down"
            active={mine?.rating === "down"}
            disabled={saving}
            onClick={() => void send("down", false)}
          />
        </div>

        {summary !== null && summary.up + summary.down > 0 && (
          <span className="text-xs text-ink-faint">
            {summary.up} up · {summary.down} down in this workspace
          </span>
        )}

        {saved && <span className="text-xs text-success">Thanks — noted.</span>}
      </div>

      {expanded && (
        <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
          <p className="text-xs text-ink-muted">
            Optional, and genuinely useful: a sentence here becomes a labelled test case in the
            evaluation set.
          </p>

          <Field label="What went wrong?">
            {({ controlId }) => (
              <Select
                id={controlId}
                value={reason}
                onChange={(event) => {
                  const parsed = feedbackReasonSchema.safeParse(event.target.value)
                  setReason(parsed.success ? parsed.data : "")
                }}
              >
                <option value="">Choose one…</option>
                {feedbackReasonSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {describeFeedbackReason(option)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Anything else?" hint="Stored verbatim and read during triage.">
            {({ controlId }) => (
              <TextArea
                id={controlId}
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value)
                }}
                placeholder="It confused two different APIs with the same name."
              />
            )}
          </Field>

          <div className="flex gap-2">
            <Button size="sm" disabled={saving} onClick={() => void send("down", true)}>
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setExpanded(false)
              }}
            >
              Skip
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Thumb({
  direction,
  active,
  disabled,
  onClick,
}: {
  direction: "up" | "down"
  active: boolean
  disabled: boolean
  onClick: () => void
}): ReactElement {
  const Icon = direction === "up" ? ThumbsUp : ThumbsDown
  const label = direction === "up" ? "This answer was useful" : "This answer was not useful"

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // `aria-pressed` rather than colour alone, so the current verdict is
      // announced as well as shown.
      aria-pressed={active}
      title={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg transition-colors disabled:opacity-50",
        active
          ? direction === "up"
            ? "bg-success-soft text-success"
            : "bg-danger-soft text-danger"
          : "text-ink-faint hover:bg-surface-sunken hover:text-ink-muted",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  )
}
