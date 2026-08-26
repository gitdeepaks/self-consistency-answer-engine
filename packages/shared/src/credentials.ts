import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { scopeSchema } from "./auth.ts"

/**
 * Where a credential lives on disk, and what it looks like.
 *
 * This is the fallback store. The CLI prefers the OS keychain — macOS Keychain,
 * Windows Credential Manager, the Secret Service on Linux — and only lands here
 * when there is not one, which is the normal case on a CI runner or a headless
 * container. The file is `0600` and the directory `0700`, because a token in a
 * world-readable dotfile is a credential in name only.
 *
 * It lives in `@sce/shared` rather than in the CLI so the bootstrap script can
 * write the same file the CLI reads, without the CLI having to depend on the
 * database package or the script having to reimplement the format.
 */

/** One deployment's credential. Exactly one of the two halves is present. */
export const storedCredentialSchema = z.union([
  z.object({
    kind: z.literal("api-key"),
    token: z.string().min(1),
    /** Tenant slug or id to send as the tenant header, when one was chosen. */
    tenant: z.string().min(1).nullable().default(null),
  }),
  z.object({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    /** Absent when the authorization server issued no `offline_access` grant. */
    refreshToken: z.string().min(1).nullable().default(null),
    /** Absolute expiry, ISO 8601. The CLI refreshes shortly before it. */
    expiresAt: z.string().nullable().default(null),
    scopes: z.array(scopeSchema).default([]),
    tenant: z.string().min(1).nullable().default(null),
  }),
])
export type StoredCredential = z.infer<typeof storedCredentialSchema>

/**
 * The whole file: one credential per server URL.
 *
 * Keyed by server so a developer with a local stack, a staging deployment and
 * production does not have to log out of one to use another — and so a token
 * for one can never be sent to another by accident.
 */
export const credentialFileSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), storedCredentialSchema).default({}),
})
export type CredentialFile = z.infer<typeof credentialFileSchema>

const EMPTY: CredentialFile = { version: 1, profiles: {} }

/**
 * The credentials path, honouring the XDG spec where it applies.
 *
 * `SCE_CREDENTIALS_PATH` overrides everything, which is what makes this
 * testable without touching a real home directory.
 */
export function credentialsPath(): string {
  const override = process.env.SCE_CREDENTIALS_PATH?.trim()
  if (override !== undefined && override !== "") return override

  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(homedir(), ".config")
  return path.join(base, "sce", "credentials.json")
}

/**
 * Read the credential file.
 *
 * A missing, unreadable or malformed file is "no credentials" rather than an
 * error: the only thing a caller can do about a corrupt store is log in again,
 * and making them delete a file by hand first helps nobody.
 */
export function readCredentialFile(): CredentialFile {
  try {
    const parsed = credentialFileSchema.safeParse(JSON.parse(readFileSync(credentialsPath(), "utf8")))
    return parsed.success ? parsed.data : EMPTY
  } catch {
    return EMPTY
  }
}

/** Write the file back with private permissions, creating the directory if needed. */
export function writeCredentialFile(file: CredentialFile): void {
  const target = credentialsPath()
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })

  // Written first, then narrowed: `writeFileSync`'s mode is masked by the
  // process umask, so an explicit chmod is what actually guarantees 0600 —
  // and it has to happen before the token is useful to anyone else.
  writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(target, 0o600)
}

/** Normalise a server URL so `http://x:8787` and `http://x:8787/` are one key. */
export function credentialKey(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "")
}

export function readCredential(serverUrl: string): StoredCredential | null {
  return readCredentialFile().profiles[credentialKey(serverUrl)] ?? null
}

export function writeCredential(serverUrl: string, credential: StoredCredential): void {
  const file = readCredentialFile()
  writeCredentialFile({
    version: 1,
    profiles: { ...file.profiles, [credentialKey(serverUrl)]: credential },
  })
}

/** Forget one deployment's credential, or the whole file when it empties. */
export function clearCredential(serverUrl: string): void {
  const file = readCredentialFile()
  const key = credentialKey(serverUrl)
  if (!(key in file.profiles)) return

  const remaining = Object.fromEntries(
    Object.entries(file.profiles).filter(([name]) => name !== key),
  )

  if (Object.keys(remaining).length === 0) {
    rmSync(credentialsPath(), { force: true })
    return
  }
  writeCredentialFile({ version: 1, profiles: remaining })
}

/** The bearer token a stored credential presents, whichever kind it is. */
export function bearerTokenOf(credential: StoredCredential): string {
  return credential.kind === "api-key" ? credential.token : credential.accessToken
}
