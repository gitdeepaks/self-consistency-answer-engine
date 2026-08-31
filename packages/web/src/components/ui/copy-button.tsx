"use client"

import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState, type ReactElement } from "react"
import { Button, type ButtonProps } from "@/components/ui/button"

/**
 * Copy to clipboard, with the confirmation people need.
 *
 * The confirmation is the whole feature. A copy button that does nothing
 * visible gets pressed three times, and the third press is somebody checking
 * whether the first two worked. The label also changes for screen readers, not
 * just the icon.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused
 * by permissions policy, so the failure is surfaced rather than swallowed — a
 * silent no-op is worse than an honest "could not copy".
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "ghost",
  size = "sm",
  className,
}: {
  value: string
  label?: string
  copiedLabel?: string
  variant?: ButtonProps["variant"]
  size?: ButtonProps["size"]
  className?: string
}): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Cleared on unmount: a component that navigates away mid-timeout would
  // otherwise set state on something React has already discarded.
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setState("copied")
    } catch {
      setState("failed")
    }
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setState("idle")
    }, 2000)
  }

  const text = state === "copied" ? copiedLabel : state === "failed" ? "Could not copy" : label

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => {
        void copy()
      }}
      // Announced on change, so a screen-reader user hears the confirmation
      // rather than only seeing a tick they cannot see.
      aria-live="polite"
    >
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {size === "icon" ? <span className="sr-only">{text}</span> : text}
    </Button>
  )
}
