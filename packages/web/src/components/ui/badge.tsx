import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes, ReactElement } from "react"
import { cn } from "@/lib/cn"

/**
 * A small status label.
 *
 * Every tone pairs a background with text of the same hue family, which keeps
 * contrast predictable in both themes — and every use in this app pairs the
 * colour with a *word*, never colour alone, because roughly one in twelve men
 * cannot distinguish the red one from the green one (WCAG 1.4.1).
 */
const badge = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-surface-sunken text-ink-muted",
        accent: "bg-accent-soft text-accent",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>

export function Badge({ className, tone, ...props }: BadgeProps): ReactElement {
  return <span className={cn(badge({ tone }), className)} {...props} />
}
