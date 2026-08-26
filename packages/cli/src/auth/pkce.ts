import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { formatScopeList, parseScopeList, type Scope } from "@sce/shared"

/**
 * OAuth 2.0 authorization code + PKCE, for a terminal.
 *
 * This is the flow every modern CLI uses, and each piece of it answers a
 * specific attack:
 *
 *   **PKCE (RFC 7636).** A CLI is a *public* client — it ships to users, so it
 *   cannot hold a secret. Instead it invents a random `code_verifier` per
 *   login, sends only its SHA-256 (`S256`), and proves possession at the token
 *   exchange. An attacker who intercepts the authorization code cannot redeem
 *   it without the verifier, which never left this process.
 *
 *   **Loopback redirect (RFC 8252 §7.3).** The browser hands the code back to
 *   `127.0.0.1` on an ephemeral port — not `localhost`, which can resolve to an
 *   interface other than the loopback, and not a fixed port, which collides
 *   with whatever else the developer is running.
 *
 *   **`state`.** A random value echoed by the server and compared here, so a
 *   crafted callback from another tab cannot inject an attacker's code.
 *
 *   **Discovery (RFC 8414).** The endpoints come from the authorization
 *   server's own metadata document rather than being hardcoded, so a Clerk
 *   instance on a custom domain works without a code change.
 */

/* ------------------------------------------------------------- discovery */

/**
 * The subset of RFC 8414 metadata this client uses.
 *
 * Passthrough would be pointless here: anything not named is not used, and
 * parsing rather than trusting is what stops a compromised discovery document
 * from redirecting the token exchange somewhere that harvests verifiers.
 */
const metadataSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
})

export interface AuthorizationServer {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | null
}

export async function discover(
  discoveryUrl: string,
  signal?: AbortSignal,
): Promise<AuthorizationServer> {
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`Could not read OAuth metadata from ${discoveryUrl} (HTTP ${response.status})`)
  }

  const metadata = metadataSchema.safeParse(await response.json())
  if (!metadata.success) {
    throw new Error(
      `OAuth metadata at ${discoveryUrl} is not usable: ${metadata.error.issues[0]?.message}`,
    )
  }

  // Refusing to downgrade is the whole point of checking: a server that
  // advertises only `plain` would let an interceptor replay the code.
  const methods = metadata.data.code_challenge_methods_supported
  if (methods !== undefined && !methods.includes("S256")) {
    throw new Error("This authorization server does not support PKCE with S256")
  }

  return {
    issuer: metadata.data.issuer,
    authorizationEndpoint: metadata.data.authorization_endpoint,
    tokenEndpoint: metadata.data.token_endpoint,
    revocationEndpoint: metadata.data.revocation_endpoint ?? null,
  }
}

/* ------------------------------------------------------------------ pkce */

export interface PkcePair {
  verifier: string
  challenge: string
}

/**
 * A verifier and its challenge.
 *
 * 32 random bytes base64url-encoded gives 43 characters — the length RFC 7636
 * recommends, comfortably inside its 43–128 range.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/** A `state` value: single-use, unguessable, compared in constant time. */
export function createState(): string {
  return randomBytes(24).toString("base64url")
}

/**
 * Compare two `state` values without leaking timing.
 *
 * Almost certainly unnecessary — a mismatch aborts the whole login — but the
 * comparison is on the critical path of an authorization response, and a
 * constant-time compare of two short strings costs nothing worth measuring.
 */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(received, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

/* ------------------------------------------------------------ token sets */

/**
 * The token endpoint's success response (RFC 6749 §5.1).
 *
 * `expires_in` is seconds from now, which is unusable five minutes later, so it
 * is turned into an absolute instant immediately — the one transformation that
 * stops a refresh check from being subtly wrong after a suspend.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})

/** The token endpoint's error response (RFC 6749 §5.2). */
const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
})

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  /** Absolute expiry as an ISO string, or null when the server did not say. */
  expiresAt: string | null
  scopes: Scope[]
}

function toTokenSet(raw: z.infer<typeof tokenResponseSchema>, requested: readonly Scope[]): TokenSet {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt:
      raw.expires_in === undefined
        ? null
        : new Date(Date.now() + raw.expires_in * 1000).toISOString(),
    // A server that echoes no `scope` granted what was asked for (RFC 6749
    // §5.1); one that echoes it may have granted less, and less is what counts.
    scopes: raw.scope === undefined ? [...requested] : parseScopeList(raw.scope),
  }
}

async function postToken(
  tokenEndpoint: string,
  body: URLSearchParams,
  requested: readonly Scope[],
): Promise<TokenSet> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  })

  const text = await response.text()
  let payload: unknown = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }

  if (!response.ok) {
    const failure = tokenErrorSchema.safeParse(payload)
    const detail = failure.success
      ? `${failure.data.error}${failure.data.error_description ? `: ${failure.data.error_description}` : ""}`
      : text.slice(0, 200)
    throw new Error(`Token request failed (HTTP ${response.status}): ${detail}`)
  }

  const parsed = tokenResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`Token response was not usable: ${parsed.error.issues[0]?.message}`)
  }

  return toTokenSet(parsed.data, requested)
}

export interface ExchangeInput {
  server: AuthorizationServer
  clientId: string
  code: string
  verifier: string
  redirectUri: string
  scopes: readonly Scope[]
}

/** Redeem an authorization code. The verifier proves this is the same client. */
export async function exchangeCode(input: ExchangeInput): Promise<TokenSet> {
  return postToken(
    input.server.tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      // Required even though the code is already bound to it — the server
      // re-checks, which is what makes redirect substitution detectable.
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    }),
    input.scopes,
  )
}

/** Trade a refresh token for a fresh access token. */
export async function refreshTokens(input: {
  server: AuthorizationServer
  clientId: string
  refreshToken: string
  scopes: readonly Scope[]
}): Promise<TokenSet> {
  const refreshed = await postToken(
    input.server.tokenEndpoint,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }),
    input.scopes,
  )

  // Rotating servers return a new refresh token and invalidate the old one;
  // non-rotating ones return none and expect the old one to be kept. Losing
  // track of that difference is what makes a CLI mysteriously log itself out.
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? input.refreshToken,
  }
}

/* ------------------------------------------------ the authorization URL */

export function authorizationUrl(input: {
  server: AuthorizationServer
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  scopes: readonly Scope[]
}): string {
  const url = new URL(input.server.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    // `offline_access` is what makes the CLI stay logged in past the access
    // token's lifetime; without it every expiry means another browser round.
    scope: `openid profile email offline_access ${formatScopeList(input.scopes)}`.trim(),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString()
  return url.toString()
}
