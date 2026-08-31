import { formatMicroCentsUsd, type QuotaStatus } from "@sce/shared"
import type { ReactElement } from "react"
import { cn } from "@/lib/cn"
import { count, when } from "@/lib/format"

/**
 * One plan ceiling, and how close this workspace is to it.
 *
 * Rendered from `QuotaStatus` — the exact record `evaluateQuota` produces and
 * the API refuses requests with — so the number somebody reads here is produced
 * by the same function that will block their next run. A usage bar computed
 * independently in a UI is a usage bar that eventually disagrees with the 429.
 *
 * A plan with no ceiling shows the figure without a bar rather than a full one:
 * "unlimited" drawn as a bar at 100% reads as "you are out".
 */
export function QuotaBar({ status }: { status: QuotaStatus }): ReactElement {
  const percent =
    status.ceiling === null || status.ceiling === 0
      ? null
      : Math.min(100, Math.round((status.used / status.ceiling) * 100))

  const tone =
    percent === null
      ? "bg-accent"
      : percent >= 100
        ? "bg-danger"
        : percent >= 80
          ? "bg-warning"
          : "bg-accent"

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-ink">{LABELS[status.limit]}</span>
        <span className="font-mono text-sm text-ink-muted">
          {render(status.limit, status.used)}
          {status.ceiling !== null && (
            <span className="text-ink-faint"> / {render(status.limit, status.ceiling)}</span>
          )}
        </span>
      </div>

      {percent === null ? (
        <p className="text-xs text-ink-faint">No ceiling on this plan.</p>
      ) : (
        <>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
            role="meter"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={LABELS[status.limit]}
          >
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-ink-faint">
            {percent >= 100
              ? "Reached. New runs are refused until this resets."
              : `${percent}% used`}
            {status.resetAt !== null && ` · resets ${when(status.resetAt)}`}
          </p>
        </>
      )}
    </div>
  )
}

const LABELS: Record<QuotaStatus["limit"], string> = {
  monthly_runs: "Runs this month",
  monthly_tokens: "Tokens this month",
  monthly_cost: "Spend this month",
  concurrent_runs: "Runs in flight",
}

/** Money is money; everything else is a count. */
function render(limit: QuotaStatus["limit"], value: number): string {
  return limit === "monthly_cost" ? formatMicroCentsUsd(value, 2) : count(value)
}
