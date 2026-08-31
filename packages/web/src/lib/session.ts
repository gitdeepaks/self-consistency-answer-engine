import "server-only"
import { auth } from "@clerk/nextjs/server"
import { cache } from "react"
import { authConfigured } from "@/env"
import { serverApi } from "@/lib/api/server"

/**
 * Facts about the current request, resolved once.
 *
 * Wrapped in React's `cache()`, which deduplicates per request rather than
 * across them: a layout and three server components that each ask "is this
 * person an operator?" issue one HTTP call, not four, and a *different* request
 * a second later gets a fresh answer. A module-level memo would leak one user's
 * answer to the next.
 */

export interface Viewer {
  userId: string | null
  /** True when this person is on the install's operator allowlist. */
  isOperator: boolean
}

/**
 * Is the signed-in person an install operator?
 *
 * Asked of the API rather than decided here, because the allowlist lives in the
 * API's configuration and a web app that decided this for itself would be a
 * second, weaker copy of the rule — one that a browser could be persuaded to
 * answer "yes" to. The route answers 404 for everyone else, so a failure of any
 * kind means "no", which is the safe direction.
 */
const resolveOperator = cache(async (): Promise<boolean> => {
  try {
    await serverApi().whoamiOperator()
    return true
  } catch {
    return false
  }
})

export const currentViewer = cache(async (): Promise<Viewer> => {
  if (!authConfigured()) return { userId: null, isOperator: false }

  const { userId } = await auth()
  if (userId === null) return { userId: null, isOperator: false }

  return { userId, isOperator: await resolveOperator() }
})
