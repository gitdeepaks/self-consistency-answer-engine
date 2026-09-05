"use client"

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs"
import {
  BarChart3,
  History,
  KeyRound,
  MessageSquarePlus,
  Share2,
  ShieldAlert,
  Terminal,
  Users,
  Webhook,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactElement } from "react"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/cn"

/**
 * The application chrome.
 *
 * Keyboard-first, mirroring the TUI: every destination is a real `<a>` with a
 * visible focus ring and an access key, so the app can be driven without
 * reaching for a mouse — which is the habit the terminal client trains and the
 * thing most web ports quietly take away.
 *
 * The workspace switcher is Clerk's, not ours, and that is deliberate. The
 * active organization lives in the Clerk session, and the API resolves the
 * tenant from *that* — so a switcher of our own would be a second source of
 * truth about which workspace a request acts inside, and the two would
 * eventually disagree. Clerk switches it; `GET /api/auth/whoami` reports what
 * the API actually resolved.
 */

interface Destination {
  href: string
  label: string
  Icon: typeof History
  /** Shown only to install operators. */
  operatorOnly?: boolean
}

const DESTINATIONS: readonly Destination[] = [
  { href: "/ask", label: "Ask", Icon: MessageSquarePlus },
  { href: "/runs", label: "History", Icon: History },
  { href: "/shares", label: "Shared", Icon: Share2 },
  { href: "/usage", label: "Usage", Icon: BarChart3 },
  { href: "/team", label: "Team", Icon: Users },
  { href: "/settings/keys", label: "API keys", Icon: KeyRound },
  { href: "/settings/webhooks", label: "Webhooks", Icon: Webhook },
  { href: "/settings/playground", label: "Playground", Icon: Terminal },
  { href: "/admin", label: "Operations", Icon: ShieldAlert, operatorOnly: true },
]

export function Nav({ isOperator }: { isOperator: boolean }): ReactElement {
  const pathname = usePathname()

  const visible = DESTINATIONS.filter((item) => item.operatorOnly !== true || isOperator)

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Link
          href="/ask"
          className="flex shrink-0 items-center gap-2 text-sm font-semibold text-ink"
        >
          <span
            className="inline-block size-2.5 rounded-full bg-accent"
            aria-hidden="true"
          />
          <span className="hidden sm:inline">Answer Engine</span>
        </Link>

        <nav aria-label="Main" className="min-w-0 flex-1">
          <ul className="flex items-center gap-0.5 overflow-x-auto">
            {visible.map(({ href, label, Icon }) => {
              // `startsWith` so `/runs/abc` still highlights History, but
              // guarded on the segment boundary so `/settings/keys` does not
              // light up a hypothetical `/settings`.
              const active = pathname === href || pathname.startsWith(`${href}/`)
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-surface-sunken font-medium text-ink"
                        : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
                    )}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    <span className="whitespace-nowrap">{label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <OrganizationSwitcher
            hidePersonal={false}
            afterSelectOrganizationUrl="/runs"
            afterSelectPersonalUrl="/runs"
            appearance={{ elements: { rootBox: "flex items-center" } }}
          />
          <UserButton />
        </div>
      </div>
    </header>
  )
}
