"use client"

import type { Candidate, Synthesis } from "@sce/shared"
import { Check, GitCompare, X } from "lucide-react"
import type { ReactElement } from "react"
import { Markdown } from "@/components/markdown"
import { ConfidenceMeter, ProviderTag } from "@/components/run/status"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/ui/copy-button"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { cn } from "@/lib/cn"
import { duration, providerColor, providerLabel } from "@/lib/format"

/**
 * The synthesised answer, and the evidence behind it.
 *
 * The claim this product makes is that a merged answer beats any single model's,
 * and the agreements and disagreements are what make that claim *inspectable*
 * rather than something a user has to take on faith. So they are not an
 * appendix: they sit directly under the answer, and the disagreements are given
 * the more prominent treatment of the two, because a point where three models
 * conflicted is precisely where a reader should look hardest.
 */

export function AnswerView({
  synthesis,
  candidates,
  onCompare,
}: {
  synthesis: Synthesis
  candidates: readonly Candidate[]
  /** Opens the side-by-side comparison, when there is more than one answer. */
  onCompare?: () => void
}): ReactElement {
  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          title="Answer"
          description={`Synthesised by ${synthesis.model}`}
          actions={
            <>
              {onCompare !== undefined && candidates.length > 1 && (
                <button
                  type="button"
                  onClick={onCompare}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
                >
                  <GitCompare className="size-4" aria-hidden="true" />
                  Compare drafts
                </button>
              )}
              <CopyButton value={synthesis.finalAnswer} label="Copy" />
            </>
          }
        />
        <PanelBody>
          <Markdown className="max-w-[72ch]">{synthesis.finalAnswer}</Markdown>
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <ClaimList
          title="Where they agreed"
          description="Claims the models reached independently. Convergence is evidence, not proof."
          tone="success"
          items={synthesis.agreements}
          empty="The models did not converge on any single claim."
        />
        <ClaimList
          title="Where they disagreed"
          description="Conflicts the evaluator had to resolve. Read these first."
          tone="warning"
          items={synthesis.disagreements}
          empty="No conflicts were found between the answers."
        />
      </div>

      <Panel>
        <PanelHeader
          title="Scorecard"
          description="The evaluator's read on each draft, and what it took from them."
        />
        <PanelBody className="space-y-4">
          <ConfidenceMeter value={synthesis.confidence} className="max-w-sm" />

          <div className="space-y-3">
            {synthesis.reviews.map((review) => {
              const candidate = candidates.find((entry) => entry.provider === review.provider)
              return (
                <div
                  key={review.provider}
                  className="rounded-lg border border-line p-3"
                  style={{ borderLeftWidth: 3, borderLeftColor: providerColor(review.provider) }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <ProviderTag provider={review.provider} model={candidate?.model} />
                    <div className="flex items-center gap-2">
                      <Badge tone={review.score >= 7 ? "success" : review.score >= 4 ? "warning" : "danger"}>
                        {review.score.toFixed(1)} / 10
                      </Badge>
                      {candidate !== undefined && (
                        <span className="text-xs text-ink-faint">
                          {duration(candidate.latencyMs)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Points
                      icon={<Check className="size-3.5 text-success" aria-hidden="true" />}
                      label="Strengths"
                      items={review.strengths}
                    />
                    <Points
                      icon={<X className="size-3.5 text-danger" aria-hidden="true" />}
                      label="Weaknesses"
                      items={review.weaknesses}
                    />
                  </div>
                </div>
              )
            })}

            {synthesis.reviews.length === 0 && (
              <p className="text-sm text-ink-muted">
                The evaluator did not return per-model reviews for this run.
              </p>
            )}
          </div>
        </PanelBody>
      </Panel>
    </div>
  )
}

function ClaimList({
  title,
  description,
  tone,
  items,
  empty,
}: {
  title: string
  description: string
  tone: "success" | "warning"
  items: readonly string[]
  empty: string
}): ReactElement {
  return (
    <Panel>
      <PanelHeader title={title} description={description} />
      <PanelBody>
        {items.length === 0 ? (
          <p className="text-sm text-ink-faint">{empty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={index} className="flex gap-2.5 text-sm text-ink">
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    tone === "success" ? "bg-success" : "bg-warning",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}

function Points({
  icon,
  label,
  items,
}: {
  icon: ReactElement
  label: string
  items: readonly string[]
}): ReactElement {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        {icon}
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-ink-faint">None noted.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={index} className="text-xs text-ink-muted">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Side-by-side drafts.
 *
 * A genuine side-by-side rather than a text diff, and the reason is what these
 * documents *are*: two models answering the same question produce prose that
 * shares almost no tokens, so a line diff of them is a wall of red and green
 * that communicates nothing. What a reader actually wants is to read both and
 * see where the substance differs — which the evaluator has already summarised
 * above, and which this view lets them check for themselves.
 */
export function CandidateComparison({
  candidates,
}: {
  candidates: readonly Candidate[]
}): ReactElement {
  const answered = candidates.filter(
    (candidate) => candidate.content !== null && candidate.content.length > 0,
  )

  if (answered.length === 0) {
    return <p className="text-sm text-ink-muted">No model produced an answer to compare.</p>
  }

  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${Math.min(answered.length, 3)}, minmax(0, 1fr))` }}
    >
      {answered.map((candidate) => (
        <div key={candidate.id} className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
            <ProviderTag provider={candidate.provider} />
            <span className="text-xs text-ink-faint">
              {(candidate.outputTokens ?? 0).toLocaleString("en-US")} tokens
            </span>
          </div>
          <Markdown className="max-h-[32rem] overflow-y-auto pr-2">
            {candidate.content ?? ""}
          </Markdown>
        </div>
      ))}
      <p className="col-span-full text-xs text-ink-faint">
        Shown side by side rather than as a text diff: two models answering the same question share
        almost no wording, so a line diff of {answered.map((c) => providerLabel(c.provider)).join(" and ")}{" "}
        would be entirely red and green and tell you nothing.
      </p>
    </div>
  )
}
