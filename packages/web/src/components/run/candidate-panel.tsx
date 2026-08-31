"use client"

import type { Candidate } from "@sce/shared"
import type { ReactElement } from "react"
import { Markdown } from "@/components/markdown"
import { CandidateStatusBadge, ProviderTag } from "@/components/run/status"
import { CopyButton } from "@/components/ui/copy-button"
import { Panel, PanelBody } from "@/components/ui/panel"
import { cn } from "@/lib/cn"
import { duration, providerColor } from "@/lib/format"

/**
 * One panel member's answer, live.
 *
 * The distinction this component exists to make honest: `streamingText` is the
 * *decoration* and `candidate.content` is the *truth*. Token deltas are
 * ephemeral — the server never writes them to the durable log — so a client
 * that reconnects mid-answer will have missed some. The settled body carries
 * the whole thing, so it wins the moment it exists, and the partial buffer is
 * only ever shown while there is nothing better.
 *
 * Getting that the wrong way round produces the bug where an answer looks
 * complete but is silently missing the paragraph that arrived while a laptop
 * was asleep.
 */
export function CandidatePanel({
  candidate,
  streamingText,
  className,
}: {
  candidate: Candidate
  /** Partial text while the answer is still arriving, or undefined. */
  streamingText?: string
  className?: string
}): ReactElement {
  const settled = candidate.content
  const body = settled ?? streamingText ?? ""
  const streaming = settled === null && candidate.status === "RUNNING"

  const tokens =
    candidate.inputTokens === null && candidate.outputTokens === null
      ? null
      : `${(candidate.inputTokens ?? 0).toLocaleString("en-US")} in · ${(candidate.outputTokens ?? 0).toLocaleString("en-US")} out`

  return (
    <Panel className={cn("flex min-w-0 flex-col overflow-hidden", className)}>
      {/* The provider's accent as a hairline rather than a fill: it identifies
          the column at a glance without competing with the text for contrast. */}
      <div
        className="h-0.5 w-full shrink-0"
        style={{ backgroundColor: providerColor(candidate.provider) }}
        aria-hidden="true"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <ProviderTag provider={candidate.provider} model={candidate.model} />
        <div className="flex items-center gap-2">
          <CandidateStatusBadge status={candidate.status} />
          {settled !== null && settled.length > 0 && (
            <CopyButton value={settled} size="icon" label="Copy this answer" />
          )}
        </div>
      </div>

      <PanelBody
        className="min-h-0 flex-1 overflow-y-auto"
        // Announced politely so a screen-reader user is told when an answer
        // lands, without every token interrupting them.
        aria-live="polite"
        aria-busy={streaming}
      >
        {candidate.status === "ERROR" ? (
          <p className="text-sm text-danger">{candidate.error ?? "This model failed to answer."}</p>
        ) : candidate.status === "SKIPPED" ? (
          <p className="text-sm text-ink-muted">
            {candidate.error ?? "Skipped — this provider was unavailable when the run started."}
          </p>
        ) : candidate.status === "CANCELED" ? (
          <p className="text-sm text-ink-muted">Canceled before this model finished.</p>
        ) : body.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {candidate.status === "PENDING" ? "Waiting for a worker…" : "Thinking…"}
          </p>
        ) : (
          <>
            <Markdown>{body}</Markdown>
            {streaming && <span className="sce-caret ml-0.5 align-baseline" aria-hidden="true" />}
          </>
        )}
      </PanelBody>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-faint">
        <span>{duration(candidate.latencyMs)}</span>
        {tokens !== null && <span className="font-mono">{tokens}</span>}
        {candidate.attempts > 1 && (
          <span title="Queue delivery attempts spent on this candidate">
            {candidate.attempts} attempts
          </span>
        )}
      </div>
    </Panel>
  )
}
