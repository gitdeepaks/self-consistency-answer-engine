"use client"

import { useEffect, type ReactElement } from "react"
import { Button } from "@/components/ui/button"

/**
 * The last line of defence.
 *
 * Next requires this to be a client component, and it receives the error with
 * its message already stripped in production — which is correct, and is why the
 * page shows the `digest` instead. That string is what correlates this screen
 * with the server log entry that has the real stack, so a support conversation
 * can start with a fact rather than "it said something went wrong".
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): ReactElement {
  useEffect(() => {
    // Client-side telemetry lands in Phase 8; until then the console is where
    // a developer will look, and an error that is swallowed entirely is worse
    // than one that is only logged locally.
    console.error("[web] unhandled error", error)
  }, [error])

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <h1 className="text-lg font-semibold text-ink">Something broke on our side</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This is not something you did. The failure has been logged; trying again is worth a shot,
        because a fair share of these are a transient hiccup between services.
      </p>

      {error.digest !== undefined && (
        <p className="mt-4 text-xs text-ink-faint">
          Reference <code className="font-mono">{error.digest}</code> — quote it if you report this.
        </p>
      )}

      <div className="mt-6 flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <a href="/runs">
          <Button variant="secondary">Back to history</Button>
        </a>
      </div>
    </main>
  )
}
