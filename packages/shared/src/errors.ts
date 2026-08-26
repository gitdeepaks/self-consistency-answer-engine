import { z } from "zod"

/**
 * Reading errors that arrive as `unknown`.
 *
 * `useUnknownInCatchVariables` is on, and provider SDKs throw a zoo of shapes:
 * `Error` subclasses with an HTTP status hung off them, plain objects from a
 * `fetch` wrapper, occasionally a string. That is exactly the situation the
 * type policy's one carve-out describes — `unknown` in, a domain type out, and
 * a schema doing the work in between rather than an assertion claiming the
 * shape is whatever was convenient.
 */

/** The bits of an HTTP-ish provider error worth surfacing. */
const httpErrorShapeSchema = z.object({
  statusCode: z.number().int().optional(),
  status: z.number().int().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
})

/** A retry hint, in either of the two forms RFC 9110 allows. */
const retryAfterSchema = z.union([
  z.coerce.number().nonnegative(),
  z.iso.datetime({ offset: true }),
  z.string(),
])

export interface ErrorFacts {
  message: string
  name: string
  /** HTTP status, when the thrown value carried one. */
  status: number | null
  /** `Retry-After`, normalised to milliseconds, when the provider sent one. */
  retryAfterMs: number | null
}

function parseRetryAfter(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const parsed = retryAfterSchema.safeParse(raw.trim())
  if (!parsed.success) return null

  // delta-seconds
  if (typeof parsed.data === "number") return Math.round(parsed.data * 1000)

  // HTTP-date
  const at = Date.parse(parsed.data)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - Date.now())
}

/**
 * Wrapper errors that carry the error that actually happened underneath.
 *
 * The AI SDK's `AI_RetryError` is the one that matters: when every internal
 * attempt fails it throws a wrapper whose own `statusCode` is undefined and
 * hangs the real `APICallError`s off `errors` / `lastError`. Reading only the
 * outer value turns a 429 with a `retry-after` into an anonymous, statusless
 * error — which then classifies as permanent, never trips the breaker, and
 * throws away the provider's own retry hint.
 */
const wrapperShapeSchema = z.object({
  cause: z.unknown().optional(),
  lastError: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
})

/** Deepest nesting worth walking; also the guard against a cyclic `cause`. */
const MAX_UNWRAP_DEPTH = 8

function statusOf(error: unknown): number | null {
  const shape = httpErrorShapeSchema.safeParse(error)
  if (!shape.success) return null
  return shape.data.statusCode ?? shape.data.status ?? null
}

/**
 * Walk a wrapped error down to the first link that carries an HTTP status.
 *
 * Falls back to the value it was given, so an error that was never wrapped —
 * and one whose chain says nothing useful — behaves exactly as before.
 */
function unwrapToStatus(error: unknown, depth = 0): unknown {
  if (depth >= MAX_UNWRAP_DEPTH) return error
  if (statusOf(error) !== null) return error

  const shape = wrapperShapeSchema.safeParse(error)
  if (!shape.success) return error

  // `lastError` first: for a retry wrapper it is the attempt whose failure
  // actually ended the call, and so the one whose `retry-after` is current.
  const attempts = (shape.data.errors ?? []).slice().reverse()
  const links = [shape.data.lastError, ...attempts, shape.data.cause]
  for (const link of links) {
    if (link === undefined || link === null) continue
    const found = unwrapToStatus(link, depth + 1)
    if (statusOf(found) !== null) return found
  }
  return error
}

/** Everything structured that can be recovered from a thrown value. */
export function errorFacts(value: unknown): ErrorFacts {
  const error = unwrapToStatus(value)
  const shape = httpErrorShapeSchema.safeParse(error)
  const status = shape.success ? (shape.data.statusCode ?? shape.data.status ?? null) : null
  const headers = shape.success ? shape.data.responseHeaders : undefined

  const retryAfterMs = parseRetryAfter(headers?.["retry-after"] ?? headers?.["Retry-After"])

  if (error instanceof Error) {
    return { message: error.message || error.name, name: error.name, status, retryAfterMs }
  }
  if (typeof error === "string") {
    return { message: error, name: "Error", status, retryAfterMs }
  }
  return { message: "Unknown error", name: "Error", status, retryAfterMs }
}

/** Longest error message that is worth persisting or showing in a UI. */
const MAX_MESSAGE_LENGTH = 500

/**
 * Turn anything thrown by a provider SDK into a single short line that is safe
 * to persist and show to a user. The useful signal is almost always `message`
 * plus an HTTP status.
 */
export function describeError(error: unknown): string {
  const facts = errorFacts(error)

  if (facts.name === "AbortError" || facts.name === "TimeoutError") {
    return facts.status === null ? "Timed out" : `HTTP ${facts.status}: timed out`
  }

  const line = facts.status === null ? facts.message : `HTTP ${facts.status}: ${facts.message}`
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : line
}
