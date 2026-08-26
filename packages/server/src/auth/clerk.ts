import { createClerkClient, type ClerkClient } from "@clerk/backend"
import { describeError, parseScopeList, type Scope } from "@sce/shared"
import { clerkConfigured, config } from "../env.ts"

/**
 * Clerk verification, reduced to the two facts this API needs.
 *
 * `authenticateRequest` understands four kinds of credential; exactly two of
 * them reach us. A **session token** is a browser (Phase 5's web app), and it
 * carries the active organization. An **OAuth token** is the CLI, which got it
 * through the authorization-code + PKCE flow, and it carries the scopes the
 * user consented to but no organization — a terminal has no "active org", so
 * the tenant is chosen explicitly instead (see `resolve.ts`).
 *
 * Everything Clerk returns is narrowed to the small record below before it
 * leaves this module. That boundary matters: Clerk types its JWT claims as
 * `Record<string, any>`, and letting that shape spread into route handlers
 * would quietly disable checking across the whole authenticated surface.
 */

/** What a verified Clerk credential tells us. */
export interface ClerkPrincipal {
  kind: "session" | "oauth"
  /** Clerk user id (`user_…`) — the subject, whichever token type carried it. */
  externalUserId: string
  /** Clerk organization id from an active session, when there is one. */
  externalOrgId: string | null
  /** Scopes the credential holds. A browser session is not scope-limited. */
  scopes: readonly Scope[] | "all"
  /** Session id, or the OAuth client id — whichever identifies the credential. */
  credentialId: string | null
}

export type ClerkVerification =
  | { ok: true; principal: ClerkPrincipal }
  | { ok: false; reason: string }

let client: ClerkClient | null = null

/**
 * The Clerk client, created once.
 *
 * Lazily, because a process with no Clerk configuration must still boot and
 * still serve API-key traffic — the whole point of making the credentials
 * optional in `env.ts`.
 */
function clerkClient(): ClerkClient | null {
  if (!clerkConfigured()) return null
  const { secretKey, publishableKey } = config.clerk
  if (secretKey === null || publishableKey === null) return null

  client ??= createClerkClient({ secretKey, publishableKey })
  return client
}

/** Drop the memoised client. Tests use this; production never needs it. */
export function resetClerkClient(): void {
  client = null
}

/**
 * Verify a request's Clerk credential.
 *
 * Returns a refusal rather than throwing, because failing to authenticate is
 * the expected outcome for a large share of requests to a public API and is not
 * an exceptional condition. The reason is for the audit log — the caller gets a
 * flat 401, since telling an attacker *why* their token was rejected is free
 * information about which half of it to change.
 */
export async function verifyClerkRequest(request: Request): Promise<ClerkVerification> {
  const clerk = clerkClient()
  if (clerk === null) return { ok: false, reason: "clerk-not-configured" }

  try {
    const state = await clerk.authenticateRequest(request, {
      // The union is the point: one middleware serves both surfaces, and a
      // token of any other kind — an m2m token, an api_key minted in Clerk
      // rather than here — is rejected rather than silently accepted.
      acceptsToken: ["session_token", "oauth_token"],
    })

    if (!state.isAuthenticated) return { ok: false, reason: state.reason }

    const auth = state.toAuth()

    if (auth.tokenType === "session_token") {
      return {
        ok: true,
        principal: {
          kind: "session",
          externalUserId: auth.userId,
          // Clerk leaves `orgId` undefined for a personal-account session;
          // this codebase distinguishes "no organization" as null throughout.
          externalOrgId: auth.orgId ?? null,
          // A browser session acts with the person's full authority; narrowing
          // happens through their role, not through scopes. Scope restriction
          // is a property of issued credentials — keys and OAuth grants.
          scopes: "all",
          credentialId: auth.sessionId,
        },
      }
    }

    // An OAuth token that verified always carries its subject, but the type
    // permits null for the unauthenticated case, so it is checked rather than
    // asserted.
    if (auth.userId === null) return { ok: false, reason: "oauth-token-without-subject" }

    return {
      ok: true,
      principal: {
        kind: "oauth",
        externalUserId: auth.userId,
        externalOrgId: null,
        // Clerk hands back `string[]`; anything this build does not recognise
        // is dropped, which can only ever reduce what the token may do.
        scopes: parseScopeList(auth.scopes.join(" ")),
        credentialId: auth.clientId,
      },
    }
  } catch (error: unknown) {
    // A network failure reaching Clerk, or a malformed token that throws rather
    // than returning a signed-out state. Either way the request is not
    // authenticated, and the reason belongs in the log rather than the response.
    return { ok: false, reason: `clerk-error: ${describeError(error)}` }
  }
}
