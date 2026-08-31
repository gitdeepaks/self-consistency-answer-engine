"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { useEffect, useState, type ReactElement } from "react"
import { cn } from "@/lib/cn"

/**
 * Light, dark, or whatever the operating system says.
 *
 * Three states rather than two, because "follow the system" is the setting most
 * people actually want and a two-way toggle silently opts them out of it the
 * first time they press it.
 *
 * The choice is written to `localStorage` and applied by the inline script in
 * the root layout *before* first paint. That ordering is the whole point: a
 * theme applied in an effect renders the light palette first and then repaints,
 * which is the white flash every dark-mode implementation has until somebody
 * fixes it.
 */

export type ThemeChoice = "light" | "dark" | "system"

/** The key the inline pre-paint script reads. Exported so the two cannot drift. */
export const THEME_STORAGE_KEY = "sce-theme"

const OPTIONS: readonly { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
]

function readStored(): ThemeChoice {
  if (typeof window === "undefined") return "system"
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
  // Parsed rather than trusted: `localStorage` is a value a user can edit, and
  // an unrecognised one falls back to the safe default instead of becoming a
  // class name.
  return raw === "light" || raw === "dark" ? raw : "system"
}

function apply(choice: ThemeChoice): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const dark = choice === "dark" || (choice === "system" && prefersDark)
  document.documentElement.classList.toggle("dark", dark)
}

export function ThemeToggle(): ReactElement {
  const [choice, setChoice] = useState<ThemeChoice>("system")

  // Read after mount, not during render: the server has no `localStorage`, and
  // rendering a different value on each side is a hydration mismatch.
  useEffect(() => {
    setChoice(readStored())
  }, [])

  // Follow the system while "system" is selected — a laptop that switches at
  // sunset should take the app with it without a reload.
  useEffect(() => {
    if (choice !== "system") return
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (): void => {
      apply("system")
    }
    query.addEventListener("change", onChange)
    return () => {
      query.removeEventListener("change", onChange)
    }
  }, [choice])

  const select = (next: ThemeChoice): void => {
    setChoice(next)
    if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, next)
    apply(next)
  }

  return (
    <div
      className="inline-flex rounded-lg border border-line bg-surface-raised p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => {
            select(value)
          }}
          // `aria-pressed` rather than a visual highlight alone: the selected
          // state has to be announced, not merely shown.
          aria-pressed={choice === value}
          title={label}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md transition-colors",
            choice === value
              ? "bg-surface-sunken text-ink"
              : "text-ink-faint hover:text-ink-muted",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The pre-paint script, as a string.
 *
 * Inlined into `<head>` so it runs before the first paint and there is no
 * flash. It is a string rather than a module because it has to execute
 * synchronously during head parsing, which no bundled script can do, and it is
 * kept beside the component that writes the value so the two read the same key.
 */
export const THEME_SCRIPT = `(function(){try{
  var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  var dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
}catch(e){}})();`
