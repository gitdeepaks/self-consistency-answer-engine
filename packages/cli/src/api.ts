import type { AppType } from "@sce/server"
import {
  loadRootEnv,
  providerHealthSchema,
  readRunEventStream,
  runSchema,
  runSummarySchema,
  usageTotalsSchema,
  type AskInput,
  type ProviderHealth,
  type Run,
  type RunSummary,
  type StreamedRunEvent,
} from "@sce/shared"
import { hc } from "hono/client"
import { z } from "zod"
import { authHeaders } from "./auth/session.ts"

loadRootEnv()

export const serverUrl = (
  process.env.SCE_SERVER_URL ??
  process.env.SERVER_URL ??
  "http://localhost:8787"
).replace(/\/$/, "")

/**
 * Fully typed RPC client — the route types come straight from the Hono app.
 *
 * `headers` is a function, not an object, because the credential is not static:
 * an OAuth access token is refreshed shortly before it expires, and resolving
 * it per request is what makes that invisible to every call site below. An
 * absent credential yields no header at all, so the server answers 401 and the
 * UI can say "run `sce auth login`" instead of failing locally.
 */
export const client = hc<AppType>(serverUrl, {
  headers: () => authHeaders(serverUrl),
})

/**
 * Everything that crosses the wire is parsed.
 *
 * The route types from `hc<AppType>()` describe what the server *intends* to
 * send. They are a contract, not a guarantee: the process on the other end may
 * be a different build, a proxy may have replaced the body with an error page,
 * and an SSE frame is unvalidated network input by construction. So each
 * response is parsed against the shared schema that defined it, and a
 * mismatched shape becomes a handled error rather than a mistyped object
 * flowing into the UI.
 */

const errorEnvelopeSchema = z.object({ error: z.string() })

const runEnvelopeSchema = z.object({ run: runSchema })
const historyEnvelopeSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})
const providersEnvelopeSchema = z.object({
  panel: z.array(providerHealthSchema),
  evaluator: providerHealthSchema,
})
const okEnvelopeSchema = z.object({ ok: z.boolean() })
const cancelEnvelopeSchema = z.object({ run: runSchema, canceled: z.boolean() })
const usageEnvelopeSchema = z.object({ usage: usageTotalsSchema })

export interface ProviderStatus {
  panel: ProviderHealth[]
  evaluator: ProviderHealth
}

/** Structural subset of both `Response` and Hono's `ClientResponse`. */
interface JsonResponse {
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
 * Read a response body into a domain type, or throw something a user can act on.
 *
 * The body is read as text first so that a non-JSON error page — the shape a
 * proxy or a load balancer returns — still produces a readable message instead
 * of a parser exception about an unexpected `<`.
 */
async function unwrap<T>(
  response: JsonResponse,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const body = await response.text().catch(() => "")

  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(parseJson(body))
    const detail = envelope.success ? envelope.data.error : body.slice(0, 200)
    throw new Error(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
  }

  const parsed = schema.safeParse(parseJson(body))
  if (!parsed.success) {
    throw new Error(`${what} returned an unexpected response: ${parsed.error.issues[0]?.message}`)
  }
  return parsed.data
}

export async function fetchProviders(): Promise<ProviderStatus> {
  const res = await client.api.providers.$get()
  return unwrap(res, providersEnvelopeSchema, "Loading providers")
}

export async function createRun(input: AskInput, idempotencyKey?: string): Promise<Run> {
  const res = await client.api.runs.$post({
    json: input,
    // The header field is always present in the request type; the *value* is
    // what is optional, so it is left undefined rather than the object omitted.
    header: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
  })
  const { run } = await unwrap(res, runEnvelopeSchema, "Starting run")
  return run
}

export async function fetchRun(id: string): Promise<Run> {
  const res = await client.api.runs[":id"].$get({ param: { id } })
  const { run } = await unwrap(res, runEnvelopeSchema, "Loading run")
  return run
}

export async function fetchHistory(limit = 30): Promise<RunSummary[]> {
  const res = await client.api.runs.$get({ query: { limit: String(limit) } })
  const { items } = await unwrap(res, historyEnvelopeSchema, "Loading history")
  return items
}

export async function removeRun(id: string): Promise<void> {
  const res = await client.api.runs[":id"].$delete({ param: { id } })
  await unwrap(res, okEnvelopeSchema, "Deleting run")
}

/** Stop a run that is still in flight, so it stops costing tokens. */
export async function cancelRun(id: string, reason?: string): Promise<Run> {
  const res = await client.api.runs[":id"].cancel.$post({
    param: { id },
    json: reason === undefined ? {} : { reason },
  })
  const { run } = await unwrap(res, cancelEnvelopeSchema, "Canceling run")
  return run
}

export async function fetchUsage(): Promise<z.infer<typeof usageTotalsSchema>> {
  const res = await client.api.usage.$get()
  const { usage } = await unwrap(res, usageEnvelopeSchema, "Loading usage")
  return usage
}

/* ---------------------------------------------------------------- streaming */

/**
 * Follow a run's SSE stream, resuming from a cursor.
 *
 * The framing and parsing live in `@sce/shared` — the web app consumes the same
 * endpoint with the same three requirements `EventSource` cannot meet (a bearer
 * header, a cursor the client controls, an `AbortSignal`), and a decoder that
 * exists twice is a decoder whose two copies eventually disagree about
 * multi-byte characters or split frames. What stays here is the part that is
 * genuinely this client's: how it authenticates.
 */
export async function* streamRun(
  id: string,
  signal: AbortSignal,
  afterSeq = 0,
): AsyncGenerator<StreamedRunEvent> {
  const res = await client.api.runs[":id"].events.$get(
    { param: { id }, query: { afterSeq: afterSeq > 0 ? String(afterSeq) : undefined } },
    { init: { signal } },
  )
  if (!res.ok || !res.body) {
    throw new Error(`Could not subscribe to run ${id} (HTTP ${res.status})`)
  }

  yield* readRunEventStream(res.body)
}
