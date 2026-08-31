"use client"

import { X } from "lucide-react"
import { useEffect, useRef, type ReactElement, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

/**
 * A modal, built on the native `<dialog>` element.
 *
 * `showModal()` gives — for free, and correctly — the four things hand-rolled
 * modals get wrong: focus moves into the dialog, focus is *trapped* there,
 * Escape closes it, and everything behind it is inert to both the pointer and
 * the accessibility tree. Reimplementing that in React is several hundred lines
 * that are subtly wrong in Safari.
 *
 * The one thing the element does not do is close on a backdrop click, because
 * the backdrop is a pseudo-element rather than a node. The click handler below
 * compares the click's coordinates against the dialog's own box, which is the
 * reliable way to tell "clicked the backdrop" from "clicked inside".
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}): ReactElement {
  const ref = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    if (open && !dialog.open) dialog.showModal()
    // `close()` rather than unmounting: the element's own closing behaviour
    // restores focus to whatever opened it, which is the part a keyboard user
    // notices when it is missing.
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      // Fires for Escape as well as `close()`, so the React state cannot get
      // out of step with the element's own idea of whether it is open.
      onClose={onClose}
      onClick={(event) => {
        const dialog = ref.current
        if (dialog === null || event.target !== dialog) return
        const box = dialog.getBoundingClientRect()
        const outside =
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        if (outside) onClose()
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[--radius-panel] border border-line bg-surface-raised p-0 text-ink backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 text-sm text-ink-muted">{description}</p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <div className="px-5 py-4">{children}</div>

      {footer !== undefined && (
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
      )}
    </dialog>
  )
}
