"use client"

import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react"
import { cn } from "@/lib/cn"

/**
 * Form controls that are labelled, described and announced correctly.
 *
 * The wrapper exists so no call site has to remember `htmlFor`,
 * `aria-describedby` and `aria-invalid` — the three things that are always
 * skipped when a label is written as a bare `<span>` above an input, and the
 * three that decide whether the form is usable with a screen reader.
 *
 * The id is generated with `useId`, so a control rendered twice on one page —
 * a filter that appears in both a sidebar and a mobile sheet — does not produce
 * two elements claiming the same label.
 */

const controlBase =
  "w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink " +
  "placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"

interface FieldShellProps {
  label: string
  hint?: ReactNode
  error?: string | null
  /** Hide the label visually but keep it for assistive technology. */
  labelHidden?: boolean
  className?: string
  children: (ids: { controlId: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}

export function Field({
  label,
  hint,
  error,
  labelHidden = false,
  className,
  children,
}: FieldShellProps): ReactElement {
  const base = useId()
  const controlId = `${base}-control`
  const hintId = `${base}-hint`
  const errorId = `${base}-error`
  const invalid = error !== null && error !== undefined && error.length > 0

  const describedBy =
    [hint !== undefined ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ") ||
    undefined

  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={controlId}
        className={cn(
          "block text-sm font-medium text-ink",
          // `sr-only` rather than `display:none`: a hidden label still has to
          // reach a screen reader, and `hidden` removes it from the tree.
          labelHidden && "sr-only",
        )}
      >
        {label}
      </label>

      {children({ controlId, describedBy, invalid })}

      {hint !== undefined && (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input className={cn(controlBase, className)} {...props} />
}

export function TextArea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return <textarea className={cn(controlBase, "resize-y", className)} {...props} />
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return <select className={cn(controlBase, "pr-8", className)} {...props} />
}
