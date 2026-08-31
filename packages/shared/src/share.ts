import { z } from "zod"
import { runSchema } from "./schemas.ts"

/**
 * Public, read-only share links.
 *
 * A share is a **capability URL**: possession of the link is the whole
 * authorization, and it grants exactly one thing — reading one already-finished
 * run, without the candidates' raw bodies and without any identity attached to
 * it. Nothing about it can be escalated: there is no route that accepts a share
 * token for anything but `GET /api/shared/:token`.
 *
 * ### Why the token is stored in plaintext
 *
 * Every other secret in this codebase is stored as a hash — `ApiKey` keeps a
 * SHA-256 and nothing else, and `apikey.ts` explains why. A share token is the
 * deliberate exception, and the argument is worth writing down rather than
 * leaving as an inconsistency somebody will "fix" later:
 *
 *   - A key's hash protects data the key can reach *beyond* the key row. A
 *     share token reaches exactly one run, and that run is sitting in the same
 *     database, in plaintext, one join away. Hashing the token would protect
 *     the door to a room whose wall is already glass.
 *   - The link has to stay retrievable. A share whose URL is shown once and
 *     then unrecoverable is a share nobody uses; people re-copy links months
 *     later, and the alternative is a graveyard of revoke-and-recreate.
 *
 * So the threat hashing would mitigate here is not one hashing mitigates. What
 * does the real work is that shares expire, revoke immediately, and are
 * enumerable by their owner — all three below.
 */

const PREFIX = "sce_share"

/** Bytes of randomness in a share token. 192 bits: unguessable, still short. */
const TOKEN_BYTES = 24

/**
 * `sce_share_<43 chars>`.
 *
 * Anchored and length-bounded because this string arrives in a URL path from an
 * anonymous caller and becomes a database predicate. base64url so it survives a
 * path segment, an email client and a chat app without escaping.
 */
const TOKEN = new RegExp(`^${PREFIX}_([A-Za-z0-9_-]{32})$`)

export const shareTokenSchema = z
  .string()
  .trim()
  .max(120, "Share link is malformed")
  .regex(TOKEN, "Share link is malformed")
export type ShareToken = z.infer<typeof shareTokenSchema>

/**
 * Mint a share token. The only place one comes into existence.
 *
 * Uses the Web Crypto global rather than `node:crypto`, and that is not a
 * stylistic choice: this module also defines `shareTokenSchema`, `shareIsLive`
 * and `shareUrl`, which the web app needs in the *browser*. A single
 * `node:crypto` import at the top of the file drags the whole module into a
 * client bundle that cannot resolve it — the module is the unit a bundler
 * includes, so one Node-only import poisons every pure export beside it.
 *
 * `crypto.getRandomValues` is a CSPRNG in every runtime this project targets
 * (Bun, Node 18+, and browsers), so nothing is given up for the portability.
 */
export function mintShareToken(): ShareToken {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return `${PREFIX}_${base64url(bytes)}`
}

/**
 * base64url, without padding.
 *
 * Written out because `Buffer` is Node-only and `btoa` takes a binary string
 * rather than bytes; the conversion through `String.fromCharCode` is the
 * portable spelling, and 24 bytes is far too small for the argument-length
 * limit that makes the spread form unsafe on large inputs.
 */
function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Does this string even look like one of ours? Cheap, allocation-free. */
export function looksLikeShareToken(value: string): boolean {
  return value.startsWith(`${PREFIX}_`)
}

/* ------------------------------------------------------------------ shapes */

/**
 * A share as its owner sees it.
 *
 * Carries the token, because the owner is allowed to copy the link again — see
 * the note above. `revokedAt` is a timestamp rather than a delete so that a
 * revoked link can still be explained ("you turned this off on Tuesday")
 * instead of simply ceasing to exist.
 */
export const runShareSchema = z.object({
  id: z.string(),
  runId: z.string(),
  token: shareTokenSchema,
  /** Optional human label, so a workspace with twenty links is navigable. */
  label: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  /** Reads served so far. The cheapest possible "did anyone actually open it". */
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: z.string().nullable(),
})
export type RunShare = z.infer<typeof runShareSchema>

export const createShareInputSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  /**
   * Days until the link stops working. Absent means it does not expire, which
   * is allowed and is why the UI states it in words rather than leaving a blank
   * field to be read as "safe by default".
   */
  expiresInDays: z.number().int().min(1).max(365).optional(),
})
export type CreateShareInput = z.infer<typeof createShareInputSchema>

/**
 * What an anonymous visitor is served.
 *
 * A deliberately narrower projection than `Run`, and the narrowing is the
 * security boundary rather than a UI preference:
 *
 *   - **no `createdByUserId`** — a share must not disclose who in a company
 *     asked the question,
 *   - **no candidate bodies or errors** — the published artefact is the
 *     synthesised answer, not three drafts and a stack trace from a provider,
 *   - **no cost, tokens or deadlines** — a competitor should not read a
 *     workspace's spend off a shared link,
 *   - **no idempotency key, no tenant** — nothing that identifies the
 *     workspace at all.
 *
 * Built by `toSharedRun` in the repository, so there is exactly one place the
 * projection happens and one place to audit it.
 */
export const sharedCandidateSchema = z.object({
  provider: runSchema.shape.candidates.element.shape.provider,
  label: z.string(),
  model: z.string(),
  status: runSchema.shape.candidates.element.shape.status,
})
export type SharedCandidate = z.infer<typeof sharedCandidateSchema>

export const sharedRunSchema = z.object({
  prompt: z.string(),
  status: runSchema.shape.status,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** Which panel answered, by name only — never their drafts. */
  panel: z.array(sharedCandidateSchema),
  finalAnswer: z.string(),
  agreements: z.array(z.string()),
  disagreements: z.array(z.string()),
  confidence: z.number(),
  /** Label of the workspace that published it, for provenance. Never its id. */
  sharedBy: z.string(),
})
export type SharedRun = z.infer<typeof sharedRunSchema>

/**
 * Why a share token did not resolve.
 *
 * Distinguished internally so an operator can tell "revoked" from "never
 * existed" in a log; the *response* collapses every one of them to 404, because
 * telling an anonymous caller that a link expired confirms it once existed.
 */
export const shareRejectionSchema = z.enum([
  "not-found",
  "revoked",
  "expired",
  /** The run was deleted, or never reached a shareable state. */
  "unavailable",
])
export type ShareRejection = z.infer<typeof shareRejectionSchema>

export type ShareResolution =
  | { ok: true; run: SharedRun }
  | { ok: false; reason: ShareRejection }

/** Is this share usable right now? Pure, so both the API and a UI can ask. */
export function shareIsLive(share: RunShare, now: Date = new Date()): boolean {
  if (share.revokedAt !== null) return false
  if (share.expiresAt === null) return true
  return new Date(share.expiresAt).getTime() > now.getTime()
}

/** The absolute URL a share resolves to, given the web app's origin. */
export function shareUrl(origin: string, token: ShareToken): string {
  return `${origin.replace(/\/$/, "")}/share/${token}`
}
