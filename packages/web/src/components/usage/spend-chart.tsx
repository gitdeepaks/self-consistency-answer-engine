import type { UsageDayEntry } from "@sce/shared"
import type { ReactElement } from "react"
import { money, providerColor, providerLabel } from "@/lib/format"

/**
 * Daily spend, by model.
 *
 * A stacked bar per day, drawn with CSS rather than a charting library. That is
 * a deliberate trade: this is one chart with one shape, and a charting
 * dependency would add far more to the bundle than it saves in code — on a page
 * whose Core Web Vitals budget is enforced in CI.
 *
 * It is a table underneath, in the accessibility tree sense: every bar carries
 * its figure in a `title`, and the totals are stated in text below, so the data
 * is reachable without seeing the picture.
 */
export function SpendChart({
  entries,
  rolledUpAt,
}: {
  entries: readonly UsageDayEntry[]
  rolledUpAt: string | null
}): ReactElement {
  const byDay = new Map<string, UsageDayEntry[]>()
  for (const entry of entries) {
    const existing = byDay.get(entry.day)
    if (existing === undefined) byDay.set(entry.day, [entry])
    else existing.push(entry)
  }

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  const dayTotals = days.map(([day, rows]) => ({
    day,
    rows,
    total: rows.reduce((sum, row) => sum + row.costMicroCents, 0),
  }))
  const peak = Math.max(1, ...dayTotals.map((entry) => entry.total))
  const grand = dayTotals.reduce((sum, entry) => sum + entry.total, 0)

  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-ink-faint">
        No metered spend in this window.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex h-40 items-end gap-1 overflow-x-auto pb-1">
        {dayTotals.map(({ day, rows, total }) => (
          <div key={day} className="flex min-w-[1.5rem] flex-1 flex-col items-center gap-1">
            <div
              className="flex w-full flex-col-reverse justify-start"
              style={{ height: `${Math.max(2, (total / peak) * 100)}%` }}
              title={`${day}: ${money(total)}`}
            >
              {rows.map((row) => (
                <div
                  key={`${row.provider}-${row.model}`}
                  style={{
                    backgroundColor: providerColor(row.provider),
                    height: `${(row.costMicroCents / Math.max(1, total)) * 100}%`,
                  }}
                  title={`${providerLabel(row.provider)} ${row.model}: ${money(row.costMicroCents)} over ${row.calls} calls`}
                />
              ))}
            </div>
            <span className="text-[0.6rem] text-ink-faint">{day.slice(8)}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs text-ink-muted">
        <span>
          <strong className="font-mono text-ink">{money(grand)}</strong> across {days.length} day
          {days.length === 1 ? "" : "s"}
        </span>
        {rolledUpAt !== null && (
          <span className="text-ink-faint">
            Rolled up {new Date(rolledUpAt).toLocaleString("en-GB")} — today&rsquo;s figure lags by
            up to one rollup interval.
          </span>
        )}
      </div>
    </div>
  )
}
