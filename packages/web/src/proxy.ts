import { clerkMiddleware } from "@clerk/nextjs/server"
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server"
import { authConfigured } from "@/env"

/**
 * The request proxy (Next 16's replacement for `middleware.ts`).
 *
 * Its only job is to make the Clerk session available to the request; the
 * *decision* about who may see what is taken in each route group's layout,
 * server-side, with `auth()`. Keeping the two apart matters: a matcher list in
 * middleware is a second place where "is this route public?" is decided, and
 * two such places drift until a page is protected in one and not the other.
 * The layout-based check cannot drift, because a page that is not inside the
 * protected group is not rendered by the layout that protects it.
 *
 * The wrapper handles the install with no Clerk keys. `clerkMiddleware()`
 * throws without a publishable key, which would turn a first clone of the repo
 * into an unexplained 500 on every route including the ones that need no
 * identity at all — the health check, the marketing page and a share link. So
 * an unconfigured install passes requests straight through, and the pages that
 * need a session say so in words.
 */

const withClerk = authConfigured() ? clerkMiddleware() : null

export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<Response> {
  if (withClerk === null) return NextResponse.next()
  // Clerk's middleware may legitimately return nothing, meaning "carry on".
  // Normalised to a real response here so the declared return type is a single
  // concrete type rather than a union with `void` — which is the shape that
  // makes every caller of a middleware chain reach for a cast.
  return (await withClerk(request, event)) ?? NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own build output and static files.
     *
     * The negative lookahead is the standard Clerk matcher, with one addition
     * this app needs: a request for `/share/<token>` is matched like any other
     * page, because a *signed-in* visitor opening a share link should still
     * have their session attached — the page is anonymous-capable, not
     * anonymous-only.
     */
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
}
