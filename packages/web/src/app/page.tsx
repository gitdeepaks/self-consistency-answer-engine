import { auth } from "@clerk/nextjs/server"
import Link from "next/link"
import { redirect } from "next/navigation"
import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import { authConfigured } from "@/env"

/**
 * Rendered per request, because the answer depends on whether there is a
 * session — and whether *that* is even asked depends on how the install is
 * configured. Left to inference, this page prerenders as the marketing copy on
 * a build with no Clerk keys and then serves it to signed-in users forever.
 */
export const dynamic = "force-dynamic"

/**
 * The front door.
 *
 * A signed-in person never sees it — they are sent straight to the composer,
 * because a landing page between someone and the thing they came to do is
 * friction with no upside once they have an account.
 */
export default async function HomePage(): Promise<ReactElement> {
  if (authConfigured()) {
    const { userId } = await auth()
    if (userId !== null) redirect("/ask")
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium text-accent">Self-consistency answer engine</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Ask several frontier models. Read one answer.
      </h1>
      <p className="mt-4 text-base text-ink-muted">
        Every question goes to a panel of models at once. An evaluator reads all of their answers,
        merges the strongest parts into one, and shows you exactly where they agreed — and where
        they did not.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sign-up">
          <Button size="lg">Create an account</Button>
        </Link>
        <Link href="/sign-in">
          <Button size="lg" variant="secondary">
            Sign in
          </Button>
        </Link>
      </div>

      <p className="mt-10 text-sm text-ink-faint">
        Prefer a terminal? The same engine ships as <code className="font-mono">sce</code>, a
        keyboard-driven client that streams the panel side by side.
      </p>
    </main>
  )
}
