import type { AppType } from "@sce/server"
import type { AskInput, ProviderHealth, Run, RunEvent, RunSummary } from "@sce/shared"
import { loadRootEnv } from "@sce/shared"
import { hc } from "hono/client"

loadRootEnv()

export const serverUrl = (
  process.env.SCE_SERVER_URL ??
  process.env.SERVER_URL ??
  "http://localhost:8787"
).replace(/\/$/, "")

/** Fully typed RPC client — the route types come straight from the Hono app. */
export const client = hc<AppType>(serverUrl)

export interface ProviderStatus {
  panel: ProviderHealth[]
  evaluator: ProviderHealth
}

/** Structural subset of both `Response` and Hono's `ClientResponse`. */
interface JsonResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

async function unwrap<T>(response: JsonResponse, what: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    let detail = body.slice(0, 200)
    try {
      const parsed = JSON.parse(body) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch {
      /* keep the raw body */
    }
    throw new Error(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return (await response.json()) as T
}

export async function fetchProviders(): Promise<ProviderStatus> {
  const res = await client.api.providers.$get()
  return unwrap<ProviderStatus>(res, "Loading providers")
}

export async function createRun(input: AskInput): Promise<Run> {
  const res = await client.api.runs.$post({ json: input })
  const { run } = await unwrap<{ run: Run }>(res, "Starting run")
  return run
}

export async function fetchRun(id: string): Promise<Run> {
  const res = await client.api.runs[":id"].$get({ param: { id } })
  const { run } = await unwrap<{ run: Run }>(res, "Loading run")
  return run
}

export async function fetchHistory(limit = 30): Promise<RunSummary[]> {
  const res = await client.api.runs.$get({ query: { limit: String(limit) } })
  const { items } = await unwrap<{ items: RunSummary[] }>(res, "Loading history")
  return items
}

export async function removeRun(id: string): Promise<void> {
  const res = await client.api.runs[":id"].$delete({ param: { id } })
  await unwrap<{ ok: boolean }>(res, "Deleting run")
}

const KNOWN_EVENTS = new Set<RunEvent["type"]>([
  "run.snapshot",
  "run.status",
  "candidate.started",
  "candidate.settled",
  "synthesis.started",
  "synthesis.settled",
  "run.completed",
  "run.failed",
])

/**
 * Follow a run's SSE stream.
 *
 * Frames are split on the blank-line delimiter rather than per chunk, because a
 * single TCP read can carry a partial frame or several frames at once.
 */
export async function* streamRun(id: string, signal: AbortSignal): AsyncGenerator<RunEvent> {
  const res = await client.api.runs[":id"].events.$get({ param: { id } }, { init: { signal } })
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
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue

        try {
          const parsed = JSON.parse(data) as RunEvent
          // Heartbeats and anything a newer server adds are ignored.
          if (KNOWN_EVENTS.has(parsed.type)) yield parsed
        } catch {
          /* skip malformed frame */
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
