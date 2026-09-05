import {
  v1ErrorSchema,
  type ErrorCode,
  type RateLimitState,
  type V1Error,
  type V1ErrorDetails,
} from "./vendor/shared.ts"

/**
 * What can go wrong, as types a caller can branch on.
 *
 * The distinction that earns its keep is between a request the *server*
 * refused and one that never got an answer at all. Almost every SDK collapses
 * both into a generic error, and the caller then has no way to tell "your quota
 * is exhausted, stop retrying" from "the connection dropped, please retry" —
 * which are the two situations where retrying matters most and where getting it
 * backwards is most expensive.
 */

/** Anything this SDK throws deliberately. */
export abstract class SceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The API answered, and refused.
 *
 * `code` is the field to branch on — never the status alone. A 429 is both "you
 * are out of monthly runs" (`quota_exceeded`) and "you are sending too many
 * requests a minute" (`rate_limited`), and the right response to each is
 * different: one means wait for the reset, the other means slow down.
 */
export class SceApiError extends SceError {
  readonly status: number
  readonly code: ErrorCode
  /** The typed specifics: which quota, which limit, which fields. */
  readonly details: V1ErrorDetails | undefined
  /** Quote this in a support conversation; it is in the server's logs. */
  readonly requestId: string
  /** Whole seconds the server asked us to wait, when it said. */
  readonly retryAfterSeconds: number | undefined

  constructor(input: {
    status: number
    body: V1Error
    retryAfterSeconds?: number | undefined
  }) {
    super(input.body.message)
    this.status = input.status
    this.code = input.body.code
    this.details = input.body.details
    this.requestId = input.body.requestId
    this.retryAfterSeconds = input.retryAfterSeconds
  }

  /** True while retrying could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

/**
 * The API answered with something this SDK cannot interpret.
 *
 * A proxy's HTML error page, a gateway timeout with an empty body, a response
 * from a deployment newer than this SDK. Kept separate from `SceApiError`
 * because there is no `code` to branch on and pretending otherwise would make
 * every caller's error handling silently wrong.
 */
export class SceResponseError extends SceError {
  readonly status: number
  /** The first bytes of whatever came back, for a human to look at. */
  readonly snippet: string

  constructor(status: number, snippet: string) {
    super(`The API returned an unexpected ${status} response: ${snippet.slice(0, 200)}`)
    this.status = status
    this.snippet = snippet
  }
}

/** The request never completed: DNS, TLS, a dropped socket, a refused port. */
export class SceConnectionError extends SceError {
  override readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.cause = cause
  }
}

/** The request exceeded the client's own timeout, or the caller aborted it. */
export class SceTimeoutError extends SceError {}

/** A configuration mistake, thrown at construction rather than at first call. */
export class SceConfigError extends SceError {}

export function isSceApiError(error: unknown): error is SceApiError {
  return error instanceof SceApiError
}

/**
 * Turn a non-2xx response into the right error.
 *
 * Reads the body as text first, so a load balancer's HTML page produces a
 * readable message rather than a parser exception about an unexpected `<`.
 */
export async function toApiError(response: Response): Promise<SceError> {
  const raw = await response.text().catch(() => "")

  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }

  const envelope = v1ErrorSchema.safeParse(parsed)
  if (!envelope.success) return new SceResponseError(response.status, raw)

  const header = response.headers.get("retry-after")
  const retryAfterSeconds = header === null ? undefined : parseRetryAfter(header)

  return new SceApiError({
    status: response.status,
    body: envelope.data,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  })
}

/**
 * `Retry-After` is either whole seconds or an HTTP date (RFC 9110 §10.2.3).
 *
 * Both forms appear in the wild — ours sends seconds, an intermediary may
 * rewrite it — and a client that understands only one silently ignores the
 * other, which is how a well-behaved retry turns into a hot loop.
 */
function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** The rate-limit headers, parsed. Absent when the response carried none. */
export function readRateLimit(headers: Headers, bucket: string): RateLimitState | null {
  const limit = Number(headers.get("x-ratelimit-limit"))
  const remaining = Number(headers.get("x-ratelimit-remaining"))
  const reset = Number(headers.get("x-ratelimit-reset"))

  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return null
  }

  const resetAtMs = reset * 1000
  return {
    bucket,
    limit,
    remaining: Math.max(0, remaining),
    resetAt: new Date(resetAtMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)),
  }
}
