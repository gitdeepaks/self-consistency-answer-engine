import type { RunSummary } from "@sce/shared"
import Link from "next/link"
import type { ReactElement } from "react"
import { RunStatusBadge } from "@/components/run/status"
import { Badge } from "@/components/ui/badge"
import { providerColor } from "@/lib/format"
import { confidence, duration, exactly, excerpt, when } from "@/lib/format"

/**
 * The history list.
 *
 * Presentational and server-renderable — no hooks, no client boundary — so the
 * first page of history is in the HTML and readable before any JavaScript
 * loads. A list is exactly the kind of view that should not need a runtime.
 *
 * Each row leads with the prompt, because that is what somebody is scanning
 * for. The status, cost and confidence are secondary and are placed where they
 * can be ignored, which is the difference between a dense list and a cluttered
 * one.
 */
export function RunList({ runs }: { runs: readonly RunSummary[] }): ReactElement {
  return (
    <ul className="divide-y divide-[--border] overflow-hidden rounded-[--radius-panel] border border-line bg-surface-raised">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            href={`/runs/${run.id}`}
            className="flex flex-col gap-2 px-4 py-3.5 transition-colors hover:bg-surface-sunken sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{excerpt(run.prompt, 140)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-faint">
                <span title={exactly(run.createdAt)}>{when(run.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {run.candidateCount} model{run.candidateCount === 1 ? "" : "s"}
                </span>
                {run.totalLatencyMs !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{duration(run.totalLatencyMs)}</span>
                  </>
                )}
                {run.tags.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="flex flex-wrap gap-1">
                      {run.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag} tone="neutral" className="px-1.5 py-0 text-[0.65rem]">
                          {tag}
                        </Badge>
                      ))}
                      {run.tags.length > 4 && <span>+{run.tags.length - 4}</span>}
                    </span>
                  </>
                )}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              {run.confidence !== null && (
                <span
                  className="font-mono text-xs text-ink-muted"
                  title="Evaluator confidence, self-reported"
                >
                  {confidence(run.confidence)}
                </span>
              )}
              <RunStatusBadge status={run.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * A compact provider legend, so the colours in this app mean something without
 * the reader having to open a run to find out what.
 */
export function ProviderLegend({
  providers,
}: {
  providers: readonly { id: Parameters<typeof providerColor>[0]; label: string }[]
}): ReactElement {
  return (
    <ul className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
      {providers.map((provider) => (
        <li key={provider.id} className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: providerColor(provider.id) }}
            aria-hidden="true"
          />
          {provider.label}
        </li>
      ))}
    </ul>
  )
}
