"use client"

import { useCallback, useId, useRef, type ReactElement, type ReactNode } from "react"
import { cn } from "@/lib/cn"

/**
 * Tabs with the keyboard behaviour the ARIA pattern requires.
 *
 * Written rather than imported because the interesting part is small and the
 * part everybody skips is the part that matters: arrow keys move between tabs,
 * Home and End jump to the ends, only the active tab is in the tab order, and
 * each panel is associated with its tab by id. A `<div onClick>` masquerading
 * as a tab list is unusable without a mouse, and this app's whole identity is
 * that it is not.
 */

export interface TabDefinition<Id extends string> {
  id: Id
  label: ReactNode
  /** Small count or status shown after the label. */
  hint?: ReactNode
}

export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
  className,
  children,
}: {
  tabs: readonly TabDefinition<Id>[]
  active: Id
  onChange: (id: Id) => void
  className?: string
  children: ReactNode
}): ReactElement {
  const base = useId()
  const listRef = useRef<HTMLDivElement | null>(null)

  const move = useCallback(
    (delta: number): void => {
      const index = tabs.findIndex((tab) => tab.id === active)
      if (index === -1) return
      // Wraps, per the ARIA authoring practices: pressing Right on the last tab
      // returns to the first rather than doing nothing.
      const next = tabs[(index + delta + tabs.length) % tabs.length]
      if (next === undefined) return
      onChange(next.id)
      listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${base}-tab-${next.id}`)}`)?.focus()
    },
    [tabs, active, onChange, base],
  )

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        className="flex gap-1 overflow-x-auto border-b border-line"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault()
            move(1)
          } else if (event.key === "ArrowLeft") {
            event.preventDefault()
            move(-1)
          } else if (event.key === "Home") {
            event.preventDefault()
            const first = tabs[0]
            if (first !== undefined) onChange(first.id)
          } else if (event.key === "End") {
            event.preventDefault()
            const last = tabs.at(-1)
            if (last !== undefined) onChange(last.id)
          }
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              // Only the active tab is reachable with Tab; the arrows move
              // within the list. This is the "roving tabindex" the pattern
              // specifies, and it is what stops a ten-tab bar from costing ten
              // presses to skip past.
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onChange(tab.id)
              }}
              className={cn(
                "-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                selected
                  ? "border-accent font-medium text-ink"
                  : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
              {tab.hint !== undefined && (
                <span className="text-xs text-ink-faint">{tab.hint}</span>
              )}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${active}`}
        aria-labelledby={`${base}-tab-${active}`}
        tabIndex={0}
        className="pt-4 focus-visible:outline-none"
      >
        {children}
      </div>
    </div>
  )
}
