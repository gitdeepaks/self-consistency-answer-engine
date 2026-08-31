import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Compose class names, with later Tailwind utilities winning.
 *
 * `clsx` handles the conditional part and `tailwind-merge` handles the part
 * that catches people out: `"px-2"` and `"px-4"` are both valid classes and CSS
 * resolves the conflict by *source order in the stylesheet*, not by order in
 * the attribute. Without the merge, a component's default padding silently
 * beats the override a caller passed in, roughly half the time.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
