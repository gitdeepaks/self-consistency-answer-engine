import type { ReactElement } from "react"
import { Skeleton, SkeletonRows } from "@/components/ui/states"

/**
 * The shell while a page's data is in flight.
 *
 * Shaped like the pages it stands in for — a heading, then a list — rather than
 * a centred spinner, so the layout does not jump when the content lands. That
 * is the Cumulative Layout Shift half of the Core Web Vitals budget this phase
 * puts in CI, and it is far cheaper to get right by default than to chase down
 * per page afterwards.
 */
export default function Loading(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <SkeletonRows rows={4} />
    </div>
  )
}
