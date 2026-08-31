import type { HTMLAttributes, ReactElement, ReactNode } from "react"
import { cn } from "@/lib/cn"

/** A raised surface. The only container shape in the app. */
export function Panel({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      className={cn(
        "rounded-[--radius-panel] border border-line bg-surface-raised",
        className,
      )}
      {...props}
    />
  )
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description !== undefined && (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PanelBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn("px-5 py-4", className)} {...props} />
}
