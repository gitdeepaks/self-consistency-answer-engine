import type { AppType } from "@sce/server"
import { apiErrorSchema, type ApiError } from "@sce/shared"
import { hc } from "hono/client"
import type { z } from "zod"
import { config } from "@/env"
import { errorEnvelopeSchema } from "./envelopes"

/**
 * The typed RPC client, and the one place a response becomes a domain value.
 *
 * The route types come straight from the Hono app — `import type { AppType }`
 * is erased at compile time, so nothing of the server package reaches this
 * bundle, and the contract stays single-sourced exactly as the CLI's does.
 *
 * What this module adds on top of `hc()` is the part `hc()` deliberately does
 * not do: turn a non-2xx response into something a UI can *render*. A quota
 * refusal, an unpaid subscription and the spend kill switch are all ordinary
 * traffic for this product, and each one carries a typed body saying which
 * limit, how much is left and when it resets. Collapsing them into
 * `new Error("Request failed")` throws that away, so `ApiRequestError` keeps
 * the parsed envelope.
 */

/** Resolves the bearer credential for a request, or null when there is none. */
export type TokenProvider = () => Promise<string | null>

/**
 * A refusal from the API, with its machine-readable body intact.
 *
 * `apiError` is present whenever the server produced a typed refusal — which is
 * every deliberate one. It is null for the responses that are not refusals so
 * much as failures: a proxy's HTML error page, a gateway timeout, a body that
 * did not parse.
 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly apiError: ApiError | null

  constructor(message: string, status: number, apiError: ApiError | null) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.apiError = apiError
  }

  /** The stable code a UI branches on, or null when there is nothing to branch on. */
  get code(): ApiError["code"] | null {
    return this.apiError?.code ?? null
  }
}

/** A response body that did not match the schema that defines it. */
export class ApiShapeError extends Error {
  constructor(what: string, detail: string) {
    super(`${what} returned an unexpected response: ${detail}`)
    this.name = "ApiShapeError"
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError
}

/**
 * Build a client bound to a credential source.
 *
 * `headers` is a function rather than an object because the credential is not
 * static: a Clerk session token is short-lived and refreshed underneath, and
 * resolving it per request is what keeps that invisible to every call site. An
 * absent credential sends no header at all, so the API answers 401 and the UI
 * can say "sign in" rather than failing locally in a way that looks like a bug.
 */
export function createClient(getToken: TokenProvider): ReturnType<typeof hc<AppType>> {
  return hc<AppType>(config.apiUrl, {
    headers: async (): Promise<Record<string, string>> => {
      const token = await getToken()
      return token === null ? {} : { Authorization: `Bearer ${token}` }
    },
  })
}

/** Structural subset of both `Response` and Hono's `ClientResponse`. */
export interface JsonResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Read a response into a domain type, or throw something a UI can act on.
 *
 * The body is read as text first so a non-JSON error page — the shape a load
 * balancer returns — still produces a readable message rather than a parser
 * exception about an unexpected `<`.
 */
export async function unwrap<T>(
  response: JsonResponse,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const body = await response.text().catch(() => "")

  if (!response.ok) {
    const payload = parseJson(body)

    // The typed envelope first: it is what every deliberate refusal carries,
    // and it is the difference between "429" and "you have used 50 of 50 runs
    // this month, which resets on the 1st".
    const typed = apiErrorSchema.safeParse(payload)
    if (typed.success) {
      throw new ApiRequestError(typed.data.error, response.status, typed.data)
    }

    // Older or simpler refusals — `{ error: "Run not found" }` — still carry a
    // sentence, which is better than the status alone.
    const plain = errorEnvelopeSchema.safeParse(payload)
    const message = plain.success ? plain.data.error : body.slice(0, 200)
    throw new ApiRequestError(
      message.length > 0 ? message : `${what} failed`,
      response.status,
      null,
    )
  }

  const parsed = schema.safeParse(parseJson(body))
  if (!parsed.success) {
    throw new ApiShapeError(what, parsed.error.issues[0]?.message ?? "shape mismatch")
  }
  return parsed.data
}
