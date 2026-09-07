import type { CandidateStatus, ProviderId, RunStatus } from "@sce/shared"
import type { ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/cn"
import {
  candidateStatusLabel,
  providerColor,
  providerLabel,
  runStatusLabel,
} from "@/lib/format"

/**
 * Status, provenance and confidence, rendered consistently.
 *
 * Every one of these pairs colour with a word or a number. That is a WCAG 1.4.1
 * requirement, and it is also the thing that makes a dense run view readable at
 * a glance: "green dot" is a guess, "Answered" is a fact.
 */

function runTone(status: RunStatus): "neutral" | "accent" | "success" | "danger" {
  switch (status) {
    case "COMPLETE":
      return "success"
    case "FAILED":
      return "danger"
    case "CANCELED":
      return "neutral"
    case "PENDING":
    case "QUEUED":
      return "neutral"
    case "FANNING_OUT":
    case "SYNTHESIZING":
      return "accent"
  }
}

export function RunStatusBadge({ status }: { status: RunStatus }): ReactElement {
  const inFlight = status === "FANNING_OUT" || status === "SYNTHESIZING"
  return (
    <Badge tone={runTone(status)}>
      {inFlight && (
        <span
          className="size-1.5 animate-pulse rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {runStatusLabel(status)}
    </Badge>
  )
}

function candidateTone(
  status: CandidateStatus,
): "neutral" | "accent" | "success" | "warning" | "danger" {
  switch (status) {
    case "OK":
      return "success"
    case "ERROR":
      return "danger"
    case "SKIPPED":
      return "warning"
    case "RUNNING":
      return "accent"
    case "PENDING":
    case "CANCELED":
      return "neutral"
  }
}

export function CandidateStatusBadge({ status }: { status: CandidateStatus }): ReactElement {
  return <Badge tone={candidateTone(status)}>{candidateStatusLabel(status)}</Badge>
}

/**
 * A provider's accent dot, with its name.
 *
 * The colour comes from the shared registry rather than a stylesheet, so adding
 * a fourth panel member to `models.ts` gives it an identity in this UI with no
 * change here — and gives it the *same* identity the CLI already paints.
 */
export function ProviderTag({
  provider,
  model,
  className,
}: {
  provider: ProviderId
  model?: string
  className?: string
}): ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: providerColor(provider) }}
        aria-hidden="true"
      />
      <span className="font-medium text-ink">{providerLabel(provider)}</span>
      {model !== undefined && (
        <span className="truncate font-mono text-xs text-ink-faint">{model}</span>
      )}
    </span>
  )
}

/**
 * The evaluator's confidence.
 *
 * Rendered as a bar *and* a number, and captioned honestly: Phase 7 has not
 * calibrated this figure yet, so it is the evaluator's self-report rather than
 * a measured probability. Presenting an uncalibrated number as though it were
 * one is how a product teaches people to trust something it has not earned.
 */
/**
 * The confidence, and — once this build has measured its own — the corrected
 * reading of it.
 *
 * The calibrated number is the one shown large, because it is the one that
 * means what it says: of the answers reported at 80% after correction, about
 * 80% were judged correct. The raw value stays visible beside it rather than
 * being replaced, so a number that moved a long way is something a reader can
 * see rather than something the product quietly did to them.
 *
 * With no calibration configured, this renders exactly as it did before and
 * says so — an uncalibrated confidence presented as a probability is the
 * failure mode this component exists to avoid.
 */
export function ConfidenceMeter({
  value,
  calibrated,
  className,
}: {
  value: number
  /** Null when this build has not fitted a calibration map. */
  calibrated?: number | null
  className?: string
}): ReactElement {
  const shown = calibrated ?? value
  const percent = Math.round(Math.max(0, Math.min(1, shown)) * 100)
  const rawPercent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  const tone = percent >= 75 ? "bg-success" : percent >= 50 ? "bg-warning" : "bg-danger"
  const isCalibrated = calibrated !== undefined && calibrated !== null

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-muted">
          {isCalibrated ? "Confidence" : "Evaluator confidence"}
        </span>
        <span className="font-mono text-sm text-ink">
          {percent}%
          {isCalibrated && percent !== rawPercent && (
            <span className="ml-1.5 text-ink-faint">(self-reported {rawPercent}%)</span>
          )}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confidence in this answer"
      >
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-ink-faint">
        {isCalibrated
          ? "Corrected against measured accuracy on the evaluation set: of answers shown at this level, about this share were judged correct."
          : "Self-reported by the evaluator, not yet calibrated against measured accuracy."}
      </p>
    </div>
  )
}
