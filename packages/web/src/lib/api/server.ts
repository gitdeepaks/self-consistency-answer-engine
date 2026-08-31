import "server-only"
import { auth } from "@clerk/nextjs/server"
import { authConfigured } from "@/env"
import { createApi, type Api } from "./operations"

/**
 * The API, as a React Server Component sees it.
 *
 * `server-only` at the top is load-bearing: this module resolves a Clerk
 * session token, and importing it from a client component would be a build
 * error rather than a token that quietly ends up in a browser bundle.
 *
 * Server-rendered pages fetch here so the first paint already has data — no
 * spinner on a page whose whole content is one list — while anything that has
 * to react to a click or a stream uses the browser client instead.
 */
export function serverApi(): Api {
  return createApi(async () => {
    // An install with no Clerk keys still renders; it simply has no session to
    // present, so the API answers 401 and the page says "sign in" rather than
    // throwing during render.
    if (!authConfigured()) return null
    const { getToken } = await auth()
    return getToken()
  })
}
