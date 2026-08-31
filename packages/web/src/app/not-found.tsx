import Link from "next/link"
import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"

/**
 * Not found.
 *
 * The wording is deliberately non-committal about *why*. A run in another
 * workspace, a revoked share link and a mistyped URL all reach this page, and
 * they must remain indistinguishable — the API answers 404 rather than 403 for
 * exactly that reason, and a page that helpfully explained the difference would
 * hand back what the API withheld.
 */
export default function NotFound(): ReactElement {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <h1 className="text-lg font-semibold text-ink">Nothing here</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This page does not exist, or it is not something this account can see.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/runs">
          <Button>Back to history</Button>
        </Link>
        <Link href="/ask">
          <Button variant="secondary">Ask something</Button>
        </Link>
      </div>
    </main>
  )
}
