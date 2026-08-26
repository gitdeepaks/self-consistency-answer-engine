import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

/**
 * API key format, minting and verification.
 *
 * A key is what CI, the SDK and any non-interactive caller uses; humans at a
 * terminal get an OAuth token from the PKCE flow instead. The shape below is
 * the one every provider has converged on, and each part of it earns its place:
 *
 *     sce_live_a1b2c3d4e5f6_JHR3aXN0ZWQtc2VjcmV0LWJ5dGVz…
 *     └┬┘ └─┬┘ └─────┬────┘ └──────────────┬───────────┘
 *      │    │        │                     └ secret: 32 random bytes, never stored
 *      │    │        └ public id: indexed, so verification is one keyed lookup
 *      │    └ environment: a test key pasted into production fails loudly
 *      └ vendor tag: makes the string greppable in a leaked repo scan
 *
 * The database stores the prefix and a SHA-256 of the secret. It never stores
 * anything that can be replayed, so a dump of the `ApiKey` table authenticates
 * nobody.
 *
 * SHA-256 rather than a password hash on purpose: the secret is 256 bits of
 * CSPRNG output, so there is no dictionary to attack and no work factor worth
 * paying on a credential that is verified on every single request. That
 * argument holds *only* because the secret is generated here — never derive a
 * key from something a human chose.
 */

const VENDOR = "sce"

export const apiKeyEnvironmentSchema = z.enum(["live", "test"])
export type ApiKeyEnvironment = z.infer<typeof apiKeyEnvironmentSchema>

/** Bytes of randomness in the secret half. 256 bits — not negotiable downward. */
const SECRET_BYTES = 32
/** Bytes in the public id. Six gives 12 hex characters and ample room. */
const PUBLIC_ID_BYTES = 6

/**
 * A parsed key: the half that identifies it, and the half that proves it.
 *
 * Kept as a type rather than a string so that no call site can accidentally log
 * or persist the whole token — the parts have to be reached for by name.
 */
export interface ParsedApiKey {
  environment: ApiKeyEnvironment
  /** `sce_live_a1b2c3d4e5f6` — safe to store, index, display and log. */
  prefix: string
  /** The unhashed secret. Never persist, never log, never return in a response. */
  secret: string
}

/** A freshly minted key. `token` exists exactly once, in this object. */
export interface MintedApiKey extends ParsedApiKey {
  /** The full credential, shown to the user once and then unrecoverable. */
  token: string
  /** SHA-256 of the secret, hex encoded. This is what the row stores. */
  hash: string
}

/**
 * The token's structure, as one anchored expression with capture groups.
 *
 * Capturing rather than splitting on `_` matters more than it looks: base64url
 * uses `-` and `_` as its last two characters, so roughly half of all secrets
 * contain an underscore. Splitting truncates those at the first one and rejects
 * a perfectly valid key — a bug that reproduces about half the time, which is
 * the worst frequency there is.
 */
const TOKEN = new RegExp(`^${VENDOR}_(live|test)_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$`)

/**
 * The token itself, as it arrives in an `Authorization` header.
 *
 * Parsed rather than pattern-matched inline because this is network input that
 * decides who someone is, and the bound on its length is what stops a
 * megabyte-long "key" from reaching the hash function at all.
 */
export const apiKeyTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(200, "API key is malformed")
  .regex(TOKEN, "API key is malformed")

/** Does this string even look like one of our keys? Cheap, allocation-free. */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(`${VENDOR}_`)
}

/**
 * Split a token into its parts, or null if it is not one of ours.
 *
 * Returns null rather than throwing: an unparseable credential is an
 * authentication failure, which the caller already has to handle, not an
 * exceptional condition worth unwinding the stack for.
 */
export function parseApiKey(token: string): ParsedApiKey | null {
  const parsed = apiKeyTokenSchema.safeParse(token)
  if (!parsed.success) return null

  const match = TOKEN.exec(parsed.data)
  if (match === null) return null

  const [, environment, publicId, secret] = match
  if (publicId === undefined || secret === undefined) return null

  const env = apiKeyEnvironmentSchema.safeParse(environment)
  if (!env.success) return null

  return { environment: env.data, prefix: `${VENDOR}_${env.data}_${publicId}`, secret }
}

/** Hash a secret the same way `mintApiKey` does. Hex, lowercase, 64 chars. */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** Create a new key. The only place a full token ever comes into existence. */
export function mintApiKey(environment: ApiKeyEnvironment = "live"): MintedApiKey {
  const publicId = randomBytes(PUBLIC_ID_BYTES).toString("hex")
  const secret = randomBytes(SECRET_BYTES).toString("base64url")
  const prefix = `${VENDOR}_${environment}_${publicId}`

  return {
    environment,
    prefix,
    secret,
    token: `${prefix}_${secret}`,
    hash: hashApiKeySecret(secret),
  }
}

/**
 * Compare a presented secret against a stored hash without leaking timing.
 *
 * The comparison is over fixed-length hex digests, so a length mismatch means
 * the stored value is corrupt rather than that the secret is a different
 * length — no information about the secret leaks from the early return.
 */
export function apiKeySecretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKeySecret(secret), "hex")
  const stored = Buffer.from(storedHash, "hex")
  if (presented.length !== stored.length || stored.length === 0) return false
  return timingSafeEqual(presented, stored)
}

/**
 * A key rendered for a human: enough to recognise it, not enough to use it.
 *
 * This is what a `GET /api/keys` listing returns and what the CLI prints.
 */
export function maskApiKey(prefix: string): string {
  return `${prefix}_${"•".repeat(8)}`
}
