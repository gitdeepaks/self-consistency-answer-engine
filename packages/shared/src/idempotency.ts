import { z } from "zod"

/**
 * Idempotent writes, for every POST rather than only for run creation.
 *
 * `POST /v1/runs` has had an `Idempotency-Key` since Phase 2, enforced by a
 * unique index on the run row — the right design for that route, because the
 * thing being deduplicated is a domain object with a natural home for the key.
 * It does not generalise: publishing a share or registering a webhook endpoint
 * has no such column, and adding one to every table is how a system ends up
 * with five subtly different implementations of the same guarantee.
 *
 * So the general mechanism is a record of the *request*: its key, a fingerprint
 * of what it asked for, and the response it produced. A retry with the same key
 * gets that response back verbatim. A retry with the same key and a *different*
 * body gets a 409, because the alternative — quietly returning the first
 * response — is how a client discovers, in production, that its retry logic has
 * been sending the wrong payload for a month.
 *
 * The fingerprint is a hash rather than the body itself: the request may
 * contain a prompt, the record outlives the request, and storing user content
 * twice for the sake of a comparison is a needless second copy to protect.
 */

/** Where an idempotent request got to. */
export const idempotencyStatusSchema = z.enum([
  /** Claimed by an in-flight request. A concurrent retry is told to wait. */
  "IN_FLIGHT",
  /** Settled. The stored response is replayed for any further retry. */
  "COMPLETED",
])
export type IdempotencyStatus = z.infer<typeof idempotencyStatusSchema>

/**
 * The stored response, as bytes plus the status that framed them.
 *
 * Replayed verbatim, so a retry is indistinguishable from the original — which
 * is the entire promise. Bodies above the cap are not stored and the retry is
 * re-executed instead; a replay mechanism that becomes a document store is a
 * worse failure than the occasional honest re-execution.
 */
export const idempotentResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  /** The JSON body, as it was sent. */
  body: z.string(),
})
export type IdempotentResponse = z.infer<typeof idempotentResponseSchema>

/** Largest response replayed from the record. Beyond it, the retry re-runs. */
export const IDEMPOTENT_RESPONSE_MAX_BYTES = 256 * 1024

/**
 * How long a key is remembered.
 *
 * Twenty-four hours is the industry's settled answer, and the reasoning is
 * worth keeping: it has to outlast every retry a client will make (minutes)
 * and every backoff schedule a queue will run (hours), and it must not outlast
 * the point at which reusing a key is a mistake rather than a retry.
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000

/** The outcome of claiming a key, and what the route should do about it. */
export type IdempotencyClaim =
  /** Nobody has used this key. Proceed, then record the response. */
  | { kind: "fresh" }
  /** Settled earlier with the same request. Replay `response` and do nothing. */
  | { kind: "replay"; response: IdempotentResponse }
  /** Claimed by a request still running. Answer 409; the client should retry. */
  | { kind: "in-flight" }
  /** The same key, a different request. Answer 409 and do not proceed. */
  | { kind: "mismatch" }
  /**
   * Settled earlier, but the response was too large to retain.
   *
   * A distinct outcome rather than a silent re-execution, because the two are
   * not interchangeable: the original request succeeded and re-running it would
   * perform the write twice. The route answers 409 saying exactly that, which
   * is the only answer that is both honest and safe.
   */
  | { kind: "unrecoverable" }

/**
 * Fingerprint what a request asked for.
 *
 * Method and path are included alongside the body because an idempotency key is
 * scoped to an *operation*: the same key sent to `POST /v1/runs` and to
 * `POST /v1/webhooks/endpoints` describes two different intentions, and a
 * fingerprint over the body alone would let a client's key-generation bug turn
 * one into a replay of the other.
 *
 * Web Crypto rather than `node:crypto`, so this module stays importable from
 * the browser build of the SDK.
 */
export async function fingerprintRequest(input: {
  method: string
  path: string
  body: string
}): Promise<string> {
  const content = `${input.method.toUpperCase()} ${input.path}\n${input.body}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
