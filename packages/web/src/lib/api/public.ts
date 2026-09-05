import { Sce } from "@sce/sdk"
import { config } from "@/env"
import type { TokenProvider } from "./client"

/**
 * The public API, as this app uses it.
 *
 * Two things are going on here, and the second is the more important one.
 *
 * **Webhook management has no first-party route.** `/api` grew from what the
 * web app and the TUI needed; outbound webhooks are a Phase 6 capability that
 * exists on `/v1` only. Rather than add a second copy of those routes to the
 * internal surface, this page talks to the published one — which it is entitled
 * to do, because the API accepts a Clerk session token exactly as it accepts an
 * API key.
 *
 * **It goes through `@sce/sdk`, not through `fetch`.** Using our own published
 * client for a real feature is the only reliable way to find out whether it is
 * any good: a retry policy that is wrong, an error that loses its `details`, or
 * a schema that does not parse shows up here, in a page somebody uses, rather
 * than in an integrator's bug report. The SDK's retries, rate-limit awareness
 * and response parsing all come along for free.
 *
 * The credential is resolved per request, not captured, because a Clerk session
 * token is short-lived and refreshed underneath — which is why this takes a
 * `TokenProvider` rather than a string.
 */

/**
 * A `Sce` client bound to the current session.
 *
 * The SDK takes a static key, so a fresh instance is built per call rather than
 * memoised. That is cheap — the constructor validates two strings — and it is
 * what keeps a refreshed token from being ignored for the lifetime of a page.
 */
export async function publicApi(getToken: TokenProvider): Promise<Sce | null> {
  const token = await getToken()
  if (token === null) return null

  return new Sce({
    apiKey: token,
    baseUrl: config.apiUrl,
    appName: "web",
    // The browser is already behind a user's own patience; a request that fails
    // twice should surface rather than spend fifteen seconds trying again.
    maxRetries: 1,
  })
}
