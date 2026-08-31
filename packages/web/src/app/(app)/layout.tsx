import { auth } from "@clerk/nextjs/server"
import Link from "next/link"
import { redirect } from "next/navigation"
import type { ReactElement, ReactNode } from "react"
import { Nav } from "@/components/nav"
import { authConfigured } from "@/env"
import { currentViewer } from "@/lib/session"

/**
 * Nothing in this group may ever be prerendered or cached.
 *
 * This is a correctness rule, not a performance tuning knob. Every page below
 * renders one workspace's data, and Next will happily prerender a page at build
 * time if nothing in it happens to touch a request-scoped API — which is
 * exactly what occurs when the identity provider is unconfigured during a
 * build, or when a future refactor moves an `auth()` call behind a condition.
 * The result would be a page baked with one tenant's runs and served to the
 * next, which is the single worst bug this codebase could ship.
 *
 * Declared on the layout so it covers every page in the group, including ones
 * nobody has written yet — the same reasoning that puts the authentication
 * check here rather than in a per-route matcher.
 */
export const dynamic = "force-dynamic"

/**
 * Everything behind a session.
 *
 * The authentication decision lives here rather than in middleware, and that is
 * the design: a page is protected because of *where it is in the tree*, not
 * because somebody remembered to add its path to a matcher list. A new route
 * dropped into this group is protected the moment it exists, and one that
 * genuinely should be public has to be moved out of the group to become so —
 * which is a visible change in a diff.
 */
export default async function AppLayout({
  children,
}: {
  children: ReactNode
}): Promise<ReactElement> {
  if (!authConfigured()) return <SetupRequired />

  const { userId } = await auth()
  if (userId === null) redirect("/sign-in")

  const viewer = await currentViewer()

  return (
    <div className="flex min-h-dvh flex-col">
      <Nav isOperator={viewer.isOperator} />
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  )
}

/**
 * The first-run screen.
 *
 * A clone of this repository with no Clerk keys reaches this instead of a stack
 * trace. It says which variables are missing and where they come from, because
 * the alternative — an unexplained 500 on the first page a new contributor
 * opens — is a bad first ten minutes and an avoidable one.
 */
function SetupRequired(): ReactElement {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6">
      <h1 className="text-lg font-semibold text-ink">Identity is not configured</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This app signs people in with Clerk, and no publishable key is set. Add these to your
        environment and restart:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-[--radius-panel] border border-line bg-surface-sunken p-4 font-mono text-xs text-ink">
        {`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…`}
      </pre>
      <p className="mt-4 text-sm text-ink-muted">
        The API needs the same pair. Everything else — the worker, the queue, API-key
        authentication — runs without them; only browser sessions need Clerk.
      </p>
      <Link href="/" className="mt-6 text-sm text-accent underline underline-offset-2">
        Back to the start
      </Link>
    </main>
  )
}
