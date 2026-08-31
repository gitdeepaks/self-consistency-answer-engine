import type { ReactElement, ReactNode } from "react"
import { cn } from "@/lib/cn"

/**
 * Empty, loading and error, as first-class components.
 *
 * Phase 5 requires "a real empty/loading/error state for every view", and the
 * only way that actually happens is if the three are as easy to write as the
 * success case. A view that has to hand-roll its own empty state gets a
 * `<p>No results</p>` and nothing else.
 *
 * The distinction that matters most is between an empty *collection* and an
 * empty *result set*: "you have not asked anything yet" and "nothing matches
 * these filters" want different words and different buttons, and showing the
 * first when the second is true makes a working filter look like a broken app.
 */

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {icon !== undefined && <div className="mb-3 text-ink-faint">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1.5 max-w-md text-sm text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  )
}

/**
 * A loading placeholder shaped like the thing it is replacing.
 *
 * Shaped, rather than a centred spinner, because a skeleton that matches the
 * eventual layout means the page does not jump when the data lands — which is
 * the Cumulative Layout Shift half of the Core Web Vitals budget this phase
 * puts in CI.
 */
export function Skeleton({ className }: { className?: string }): ReactElement {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-sunken", className)}
      // Decorative: a screen reader should hear the `aria-busy` region it sits
      // inside, not a list of empty boxes.
      aria-hidden="true"
    />
  )
}

export function SkeletonRows({ rows = 3 }: { rows?: number }): ReactElement {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2 rounded-[--radius-panel] border border-line p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  )
}

/**
 * Something went wrong, said usefully.
 *
 * `detail` is the message the API actually returned — a quota that names its
 * ceiling, a subscription that names its grace period. Hiding it behind
 * "Something went wrong" is what turns an actionable refusal into a support
 * ticket.
 */
export function ErrorState({
  title = "That did not work",
  detail,
  action,
  className,
}: {
  title?: string
  detail?: string
  action?: ReactNode
  className?: string
}): ReactElement {
  return (
    <div
      // `alert` so a screen reader is told immediately, rather than only when
      // the user next happens to move focus into this region.
      role="alert"
      className={cn(
        "rounded-[--radius-panel] border border-danger/40 bg-danger-soft px-4 py-3",
        className,
      )}
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      {detail !== undefined && detail.length > 0 && (
        <p className="mt-1 text-sm text-ink-muted">{detail}</p>
      )}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  )
}
