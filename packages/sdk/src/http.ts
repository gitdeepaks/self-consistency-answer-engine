import type { z } from "zod"
import {
  SceConnectionError,
  SceResponseError,
  SceTimeoutError,
  isSceApiError,
  readRateLimit,
  toApiError,
} from "./errors.ts"
import { REQUEST_ID_HEADER, type RateLimitState } from "./vendor/shared.ts"

/**
 * The transport: one request, retried sensibly, parsed strictly.
 *
 * Three behaviours live here because getting any of them wrong is invisible
 * until it is expensive:
 *
 * **Full jitter, not exponential backoff.** Plain doubling synchronises every
 * client that failed at the same moment, so the retry storm arrives together
 * and knocks the service over again — the thundering herd. Sleeping a random
 * amount *up to* the backoff spreads them out, and it is one line different.
 *
 * **`Retry-After` outranks the schedule.** When the server has said when to come
 * back, guessing is worse than obeying, and ignoring it is what gets a client's
 * IP range blocked.
 *
 * **Only idempotent-safe failures are retried.** A 4xx that is not 408 or 429
 * will fail identically the second time; retrying it wastes the caller's
 * latency budget to reach the same conclusion. A POST is retried only when it
 * carried an `Idempotency-Key`, because without one a retry after a timeout can
 * fan out a second panel — and paying twice for one question is precisely the
 * failure the header exists to prevent.
 */

export interface RequestOptions {
  /** Aborts the request, and any retry still pending. */
  signal?: AbortSignal | undefined
  /** Sent on writes; makes a retry replay rather than repeat. */
  idempotencyKey?: string | undefined
  /** Echoed back and written to the server's logs. */
  requestId?: string | undefined
  /** Overrides the client-wide timeout for this call. */
  timeoutMs?: number | undefined
}

/**
 * Any fetch-shaped function.
 *
 * Structural rather than `typeof globalThis.fetch`, because that type is not
 * the same in every runtime — Bun's carries a `preconnect` method, Node's and
 * the browser's do not — so a consumer passing a perfectly good wrapper, a test
 * double or an instrumented client would fail to typecheck for a reason that
 * has nothing to do with them. What this code actually needs is a function that
 * takes a request and returns a response, so that is what it asks for.
 */
export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export interface HttpConfig {
  baseUrl: string
  apiKey: string
  fetch: FetchLike
  maxRetries: number
  timeoutMs: number
  userAgent: string
  onRateLimit: (state: RateLimitState) => void
}

interface Attempt {
  method: string
  path: string
  query?: URLSearchParams | undefined
  body?: unknown
  options: RequestOptions
}

/** Statuses worth a second attempt. Everything else is a durable answer. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501)
}

/** Sleep, unless the caller gives up first. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new SceTimeoutError("The request was aborted while waiting to retry"))
    }

    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Full jitter: a random wait in `[0, base × 2^attempt]`, capped.
 *
 * The cap matters as much as the jitter. Without it the sixth retry of a long
 * outage waits half a minute, which no caller expected and no timeout budget
 * accounts for.
 */
function backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 60_000)
  const ceiling = Math.min(500 * 2 ** attempt, 8_000)
  return Math.random() * ceiling
}

export class Http {
  readonly #config: HttpConfig

  constructor(config: HttpConfig) {
    this.#config = config
  }

  /** Issue a request and parse its body, retrying what is worth retrying. */
  async request<T>(attempt: Attempt, schema: z.ZodType<T>): Promise<T> {
    const response = await this.send(attempt)
    const raw = await response.text()

    // Strict rather than structural: a response this build cannot parse is a
    // deployment newer than this SDK, and surfacing that as a clear error beats
    // handing the caller an object whose fields silently do not exist.
    let parsed: unknown = null
    try {
      parsed = raw === "" ? {} : JSON.parse(raw)
    } catch {
      throw new SceResponseError(response.status, raw)
    }

    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new SceResponseError(
        response.status,
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      )
    }
    return result.data
  }

  /** Issue a request and hand back the raw response. Used by the SSE reader. */
  async send(attempt: Attempt): Promise<Response> {
    const url = new URL(
      `${this.#config.baseUrl}${attempt.path}`.replace(/([^:]\/)\/+/g, "$1"),
    )
    if (attempt.query !== undefined) url.search = attempt.query.toString()

    // A POST without an idempotency key is not safe to repeat: a retry after a
    // timeout can create a second run, and model calls cost money.
    const idempotent =
      attempt.method === "GET" ||
      attempt.method === "PUT" ||
      attempt.method === "DELETE" ||
      attempt.options.idempotencyKey !== undefined

    const maxAttempts = idempotent ? this.#config.maxRetries + 1 : 1
    let lastError: unknown = null

    for (let index = 0; index < maxAttempts; index += 1) {
      if (index > 0) {
        const wait = backoffMs(
          index - 1,
          isSceApiError(lastError) ? lastError.retryAfterSeconds : undefined,
        )
        await delay(wait, attempt.options.signal)
      }

      try {
        const response = await this.#once(url, attempt)

        if (response.ok) return response

        const error = await toApiError(response)
        if (!retryableStatus(response.status) || index === maxAttempts - 1) throw error
        lastError = error
      } catch (error: unknown) {
        // A refusal we decided to retry comes back round; anything else is
        // either final or a transport failure worth one more go.
        if (error === lastError) continue
        if (isSceApiError(error)) throw error
        if (error instanceof SceResponseError) throw error
        if (error instanceof SceTimeoutError) throw error

        if (index === maxAttempts - 1) {
          throw new SceConnectionError(
            `Could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
            error,
          )
        }
        lastError = error
      }
    }

    // Unreachable: the loop either returns or throws on its final pass. Thrown
    // rather than asserted, because a silent `undefined` escaping here would be
    // far harder to diagnose than a loud impossible-state error.
    throw new SceConnectionError("The request loop exited without a response", lastError)
  }

  async #once(url: URL, attempt: Attempt): Promise<Response> {
    const timeoutMs = attempt.options.timeoutMs ?? this.#config.timeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal =
      attempt.options.signal === undefined
        ? timeout
        : AbortSignal.any([timeout, attempt.options.signal])

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#config.apiKey}`,
      accept: "application/json",
      "user-agent": this.#config.userAgent,
    }
    if (attempt.body !== undefined) headers["content-type"] = "application/json"
    if (attempt.options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = attempt.options.idempotencyKey
    }
    if (attempt.options.requestId !== undefined) {
      headers[REQUEST_ID_HEADER] = attempt.options.requestId
    }

    const response = await this.#config.fetch(url, {
      method: attempt.method,
      headers,
      ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }),
      signal,
    })

    // Reported on every response, not only on a 429, so a caller can slow down
    // *before* being refused. That is the whole reason the headers are sent on
    // success as well.
    const state = readRateLimit(response.headers, attempt.path)
    if (state !== null) this.#config.onRateLimit(state)

    return response
  }
}

/** A random `Idempotency-Key`, for callers that do not want to invent one. */
export function newIdempotencyKey(): string {
  return `sdk_${crypto.randomUUID().replace(/-/g, "")}`
}
