import type { AppType } from "@sce/server"
import {
  loadRootEnv,
  providerHealthSchema,
  runEventSchema,
  runSchema,
  runSummarySchema,
  usageTotalsSchema,
  type AskInput,
  type ProviderHealth,
  type Run,
  type RunEvent,
  type RunSummary,
} from "@sce/shared"
import { hc } from "hono/client"
import { z } from "zod"

loadRootEnv()

export const serverUrl = (
  process.env.SCE_SERVER_URL ??
  process.env.SERVER_URL ??
  "http://localhost:8787"
).replace(/\/$/, "")

/** Fully typed RPC client — the route types come straight from the Hono app. */
export const client = hc<AppType>(serverUrl)

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

/** One decoded SSE frame: the event, plus the cursor to resume from. */
export interface StreamedEvent {
  event: RunEvent
  /** Durable sequence number, or null for an ephemeral event such as a delta. */
  seq: number | null
}

interface RawFrame {
  id: string | null
  data: string
}

/** Split a complete SSE frame into the fields this client cares about. */
function decodeFrame(frame: string): RawFrame | null {
  const dataLines: string[] = []
  let id: string | null = null

  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    else if (line.startsWith("id:")) id = line.slice(3).trim()
  }
  if (dataLines.length === 0) return null
  return { id, data: dataLines.join("\n") }
}

const seqSchema = z.coerce.number().int().positive()

/**
 * Follow a run's SSE stream, resuming from a cursor.
 *
 * Frames are split on the blank-line delimiter rather than per chunk, because a
 * single TCP read can carry a partial frame or several frames at once.
 *
 * Every frame is parsed against `runEventSchema`. A frame that does not match —
 * a keep-alive ping, an event type a newer server added, a truncated body — is
 * skipped, which is the only safe thing to do with input that arrived over a
 * network and does not fit the contract.
 */
export async function* streamRun(
  id: string,
  signal: AbortSignal,
  afterSeq = 0,
): AsyncGenerator<StreamedEvent> {
  const res = await client.api.runs[":id"].events.$get(
    { param: { id }, query: { afterSeq: afterSeq > 0 ? String(afterSeq) : undefined } },
    { init: { signal } },
  )
  if (!res.ok || !res.body) {
    throw new Error(`Could not subscribe to run ${id} (HTTP ${res.status})`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += value

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")

        const frame = decodeFrame(raw)
        if (!frame) continue

        const parsed = runEventSchema.safeParse(parseJson(frame.data))
        if (!parsed.success) continue

        const seq = frame.id === null ? null : seqSchema.safeParse(frame.id)
        yield {
          event: parsed.data,
          seq: seq === null ? null : seq.success ? seq.data : null,
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
