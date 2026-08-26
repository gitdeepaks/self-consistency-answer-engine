import { bearerTokenOf, type Scope, type StoredCredential } from "@sce/shared"
import { z } from "zod"
import { discover, refreshTokens, type AuthorizationServer } from "./pkce.ts"
import { loadCredential, saveCredential, type StorageBackend } from "./store.ts"

/**
 * The credential the CLI presents, kept current.
 *
 * Two kinds reach here and they behave differently on purpose. An **API key**
 * is static: it works until it is revoked, which is what makes it right for CI.
 * An **OAuth token** expires, so it is refreshed transparently shortly before
 * it does — a user who logged in last week should not be told to log in again
 * because an hour passed.
 */

/** `/api/auth/config` — what the server says about signing in. */
const authConfigSchema = z.object({
  interactiveLoginAvailable: z.boolean(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  discoveryUrl: z.string().nullable(),
  tenantHeader: z.string(),
})
export type AuthConfig = z.infer<typeof authConfigSchema>

/**
 * Ask the server how to authenticate against it.
 *
 * Served unauthenticated, because a client that has no credential yet is
 * exactly who needs it. Cached for the process: it changes at deploy time, not
 * during a session.
 */
let cachedConfig: Promise<AuthConfig> | null = null

export function authConfig(serverUrl: string): Promise<AuthConfig> {
  cachedConfig ??= (async () => {
    const response = await fetch(`${serverUrl}/api/auth/config`, {
      headers: { accept: "application/json" },
    })
    if (!response.ok) {
      throw new Error(
        `Could not read auth configuration from ${serverUrl} (HTTP ${response.status}). ` +
          "Is the server running?",
      )
    }
    const parsed = authConfigSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new Error(`${serverUrl} returned an unusable auth configuration`)
    }
    return parsed.data
  })().catch((error: unknown) => {
    cachedConfig = null
    throw error
  })

  return cachedConfig
}

/** Resolve the authorization server, given the config the API advertises. */
export async function authorizationServer(config: AuthConfig): Promise<AuthorizationServer> {
  if (config.discoveryUrl === null) {
    throw new Error("This deployment has no interactive sign-in configured")
  }
  return discover(config.discoveryUrl)
}

export interface CurrentSession {
  credential: StoredCredential
  backend: StorageBackend | "environment"
}

/**
 * The credential in force, if any.
 *
 * `SCE_API_KEY` wins over anything stored, which is what makes CI predictable:
 * a runner that sets the variable does not depend on whatever a cached home
 * directory happens to contain.
 */
export function currentSession(serverUrl: string): CurrentSession | null {
  const fromEnv = process.env.SCE_API_KEY?.trim()
  if (fromEnv !== undefined && fromEnv !== "") {
    const tenant = process.env.SCE_TENANT?.trim()
    return {
      credential: {
        kind: "api-key",
        token: fromEnv,
        tenant: tenant === undefined || tenant === "" ? null : tenant,
      },
      backend: "environment",
    }
  }

  const loaded = loadCredential(serverUrl)
  return loaded === null ? null : { credential: loaded.credential, backend: loaded.backend }
}

/** Refresh this far ahead of expiry, so a slow request cannot straddle it. */
const REFRESH_SKEW_MS = 60_000

function expiresSoon(expiresAt: string | null): boolean {
  if (expiresAt === null) return false
  const at = Date.parse(expiresAt)
  return !Number.isNaN(at) && at - Date.now() <= REFRESH_SKEW_MS
}

/**
 * The credential to present on the next request, refreshing it if needed.
 *
 * A failed refresh returns the existing token rather than throwing: it may
 * still be valid, and if it is not the request will come back 401 — which is a
 * far better error for a user than an exception raised while assembling a
 * header.
 */
export async function activeCredential(serverUrl: string): Promise<StoredCredential | null> {
  const session = currentSession(serverUrl)
  if (session === null) return null

  const { credential } = session
  if (credential.kind === "api-key") return credential
  if (!expiresSoon(credential.expiresAt) || credential.refreshToken === null) return credential

  try {
    const config = await authConfig(serverUrl)
    if (config.clientId === null) return credential

    const refreshed = await refreshTokens({
      server: await authorizationServer(config),
      clientId: config.clientId,
      refreshToken: credential.refreshToken,
      scopes: credential.scopes satisfies readonly Scope[],
    })

    const updated: StoredCredential = {
      kind: "oauth",
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scopes,
      tenant: credential.tenant,
    }

    // Only persist what came from a store. An environment-provided credential
    // is the environment's business, and writing a file for it would leave a
    // token behind on a runner that expected to be stateless.
    if (session.backend !== "environment") saveCredential(serverUrl, updated)
    return updated
  } catch {
    return credential
  }
}

/**
 * Headers for an authenticated request.
 *
 * Empty when there is no credential — the request then gets a 401 from the
 * server, which is the honest outcome and produces a message that tells the
 * user to run `sce auth login` rather than a client-side exception.
 */
export async function authHeaders(serverUrl: string): Promise<Record<string, string>> {
  const credential = await activeCredential(serverUrl)
  if (credential === null) return {}

  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerTokenOf(credential)}`,
  }
  if (credential.tenant !== null) headers["x-sce-tenant"] = credential.tenant
  return headers
}
