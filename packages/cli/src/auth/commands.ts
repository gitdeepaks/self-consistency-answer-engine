import {
  apiKeyCreatedSchema,
  apiKeySummarySchema,
  DEFAULT_SCOPES,
  maskApiKey,
  scopeSchema,
  type Scope,
  type StoredCredential,
} from "@sce/shared"
import { z } from "zod"
import { openBrowser, startLoopback } from "./loopback.ts"
import { authorizationUrl, createPkcePair, createState, exchangeCode } from "./pkce.ts"
import { authConfig, authHeaders, authorizationServer, currentSession } from "./session.ts"
import { describeStorage, forgetCredential, saveCredential } from "./store.ts"

/**
 * `sce auth …` and `sce keys …`.
 *
 * These run before the TUI starts and print plain text: they are the commands
 * you reach for when something is wrong, and a full-screen renderer is the last
 * thing you want in that situation. Each returns a process exit code.
 */

const whoamiSchema = z.object({
  credential: z.enum(["session", "oauth", "api-key"]),
  tenantId: z.string(),
  userId: z.string().nullable(),
  role: z.string(),
  scopes: z.array(scopeSchema),
})

const keysEnvelopeSchema = z.object({ keys: z.array(apiKeySummarySchema) })

/** A short, actionable failure. Stack traces help nobody at a prompt. */
function fail(message: string): number {
  console.error(`\n  ${message}\n`)
  return 1
}

async function authenticatedFetch(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = await authHeaders(serverUrl)
  return fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...headers, ...init.headers },
  })
}

/* ----------------------------------------------------------------- login */

/**
 * Sign in through the browser.
 *
 * The whole exchange, in order: discover the authorization server, invent a
 * PKCE verifier and a `state`, start a one-shot listener on a random loopback
 * port, send the user to their browser, catch the redirect, and redeem the code
 * with the verifier. The secret half of the proof never leaves this process,
 * which is what lets a public client do this safely at all.
 */
export async function login(serverUrl: string, args: readonly string[]): Promise<number> {
  const tenant = flagValue(args, "--org") ?? flagValue(args, "--tenant") ?? null
  const scopes = parseScopes(flagValue(args, "--scopes")) ?? DEFAULT_SCOPES

  const config = await authConfig(serverUrl).catch((error: unknown) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
    return null
  })
  if (config === null) return 1

  if (!config.interactiveLoginAvailable || config.clientId === null) {
    return fail(
      `${serverUrl} has no interactive sign-in configured.\n` +
        "  Use an API key instead: export SCE_API_KEY=… (or `bun run auth:bootstrap`).",
    )
  }

  const server = await authorizationServer(config)
  const pkce = createPkcePair()
  const state = createState()
  const loopback = startLoopback(state)

  try {
    const url = authorizationUrl({
      server,
      clientId: config.clientId,
      redirectUri: loopback.redirectUri,
      challenge: pkce.challenge,
      state,
      scopes,
    })

    console.log(
      [
        "",
        "  Opening your browser to sign in…",
        "",
        `  If it does not open, visit:\n\n    ${url}`,
        "",
        "  Waiting for the callback…",
        "",
      ].join("\n"),
    )
    openBrowser(url)

    const { code } = await loopback.waitForCode()

    const tokens = await exchangeCode({
      server,
      clientId: config.clientId,
      code,
      verifier: pkce.verifier,
      redirectUri: loopback.redirectUri,
      scopes,
    })

    const credential: StoredCredential = {
      kind: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      tenant,
    }
    const backend = saveCredential(serverUrl, credential)

    console.log(
      [
        `  Signed in to ${serverUrl}.`,
        `  Credential stored in ${backend === "keychain" ? "the OS keychain" : describeStorage()}.`,
        tokens.scopes.length > 0 ? `  Scopes: ${tokens.scopes.join(", ")}` : "",
        tokens.refreshToken === null
          ? "  Note: no refresh token was issued, so this session ends when the token expires."
          : "",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    return 0
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error))
  } finally {
    // Always: a listener left bound to a loopback port after a failed login is
    // a port nobody can reuse and a handle that keeps the process alive.
    loopback.close()
  }
}

export function logout(serverUrl: string): number {
  forgetCredential(serverUrl)
  console.log(`\n  Signed out of ${serverUrl}.\n`)
  return 0
}

/** Report who the current credential is, by asking the server rather than guessing. */
export async function status(serverUrl: string): Promise<number> {
  const session = currentSession(serverUrl)
  if (session === null) {
    console.log(
      `\n  Not signed in to ${serverUrl}.\n\n` +
        "  Run `sce auth login`, or set SCE_API_KEY for a non-interactive session.\n",
    )
    return 1
  }

  const response = await authenticatedFetch(serverUrl, "/api/auth/whoami")
  if (response.status === 401) {
    return fail("The stored credential was rejected. Run `sce auth login` again.")
  }
  if (!response.ok) {
    return fail(`Could not reach ${serverUrl} (HTTP ${response.status}).`)
  }

  const parsed = whoamiSchema.safeParse(await response.json())
  if (!parsed.success) return fail("The server returned an unexpected response.")

  const who = parsed.data
  const source =
    session.backend === "environment"
      ? "SCE_API_KEY"
      : session.backend === "keychain"
        ? "OS keychain"
        : describeStorage()

  console.log(
    [
      "",
      `  Server      ${serverUrl}`,
      `  Credential  ${who.credential} (from ${source})`,
      `  Tenant      ${who.tenantId}`,
      `  User        ${who.userId ?? "— (tenant credential)"}`,
      `  Role        ${who.role}`,
      `  Scopes      ${who.scopes.join(", ")}`,
      "",
    ].join("\n"),
  )
  return 0
}

/* ------------------------------------------------------------------ keys */

export async function listKeys(serverUrl: string): Promise<number> {
  const response = await authenticatedFetch(serverUrl, "/api/keys")
  if (!response.ok) return fail(`Could not list keys (HTTP ${response.status}).`)

  const parsed = keysEnvelopeSchema.safeParse(await response.json())
  if (!parsed.success) return fail("The server returned an unexpected response.")

  if (parsed.data.keys.length === 0) {
    console.log("\n  No API keys. Create one with `sce keys create <name>`.\n")
    return 0
  }

  console.log("")
  for (const key of parsed.data.keys) {
    const state =
      key.revokedAt !== null
        ? "revoked"
        : key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now()
          ? "expired"
          : "active"
    console.log(`  ${maskApiKey(key.prefix)}  ${state.padEnd(8)}${key.name}`)
    console.log(`    ${key.scopes.join(", ")}`)
    console.log(`    created ${key.createdAt}  ·  last used ${key.lastUsedAt ?? "never"}`)
    console.log("")
  }
  return 0
}

export async function createKey(serverUrl: string, args: readonly string[]): Promise<number> {
  const name = args.find((arg) => !arg.startsWith("--"))
  if (name === undefined) return fail("Usage: sce keys create <name> [--scopes a,b] [--days 90]")

  const scopes = parseScopes(flagValue(args, "--scopes"))
  const days = flagValue(args, "--days")

  const response = await authenticatedFetch(serverUrl, "/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(scopes === null ? {} : { scopes }),
      ...(days === null ? {} : { expiresInDays: Number(days) }),
    }),
  })

  if (!response.ok) return fail(`Could not create the key (HTTP ${response.status}).`)

  const parsed = apiKeyCreatedSchema.safeParse(await response.json())
  if (!parsed.success) return fail("The server returned an unexpected response.")

  console.log(
    [
      "",
      `  Created ${parsed.data.key.name} (${parsed.data.key.scopes.join(", ")})`,
      "",
      "  This secret is shown once and cannot be recovered:",
      "",
      `    ${parsed.data.token}`,
      "",
    ].join("\n"),
  )
  return 0
}

export async function revokeKey(serverUrl: string, args: readonly string[]): Promise<number> {
  const id = args.find((arg) => !arg.startsWith("--"))
  if (id === undefined) return fail("Usage: sce keys revoke <key-id>")

  const response = await authenticatedFetch(serverUrl, `/api/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  if (!response.ok) return fail(`Could not revoke the key (HTTP ${response.status}).`)

  console.log("\n  Revoked. It stops working immediately.\n")
  return 0
}

/* --------------------------------------------------------------- parsing */

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1) return null
  return args[index + 1] ?? null
}

/** `--scopes runs:read,runs:write`, validated against the closed set. */
function parseScopes(raw: string | null): Scope[] | null {
  if (raw === null) return null
  const scopes = raw
    .split(",")
    .map((value) => value.trim())
    .flatMap((value) => scopeSchema.safeParse(value).data ?? [])
  return scopes.length === 0 ? null : scopes
}
