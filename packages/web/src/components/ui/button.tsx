import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes, ReactElement } from "react"
import { cn } from "@/lib/cn"

/**
 * The one button.
 *
 * Variants rather than a component per look, because a design system with
 * `<PrimaryButton>`, `<DangerButton>` and `<SmallGhostButton>` has three places
 * to fix a focus ring and eventually fixes it in two.
 *
 * Every variant keeps a visible focus ring and a disabled state that is legible
 * rather than merely faint — WCAG 2.1 AA is a requirement of this phase, not a
 * later pass, and contrast is far cheaper to get right at the primitive than to
 * retrofit across forty call sites.
 */
const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-contrast hover:opacity-90",
        secondary: "bg-surface-raised text-ink border border-line-strong hover:bg-surface-sunken",
        ghost: "text-ink-muted hover:bg-surface-sunken hover:text-ink",
        danger: "bg-danger text-white hover:opacity-90",
        // A link that is a button: used where the action is textual and inline,
        // and underlined so it is not colour-alone (WCAG 1.4.1).
        link: "text-accent underline underline-offset-2 hover:opacity-80",
      },
      size: {
        sm: "h-8 px-3 text-sm [&_svg]:size-4",
        md: "h-10 px-4 text-sm [&_svg]:size-4",
        lg: "h-11 px-6 text-base [&_svg]:size-5",
        icon: "size-9 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>

export function Button({ className, variant, size, type, ...props }: ButtonProps): ReactElement {
  return (
    <button
      // Defaulted rather than left to HTML: a `<button>` inside a form is a
      // submit button unless told otherwise, which is how a "Cancel" next to a
      // text field ends up submitting it.
      type={type ?? "button"}
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  )
}

export { button as buttonVariants }
