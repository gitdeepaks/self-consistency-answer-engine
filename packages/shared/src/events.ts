import { z } from "zod"
import { assertNever } from "./assert.ts"
import { candidateSchema, runSchema, runStatusSchema, synthesisSchema } from "./schemas.ts"

/**
 * Events emitted while a run is in flight.
 *
 * Defined as a Zod discriminated union rather than a bare TypeScript union so
 * that the same definition covers both halves: `z.infer` gives the compile-time
 * type, and `.parse()` gives the runtime guarantee needed wherever an event
 * crosses a trust boundary — a `RunEvent` row read back out of Postgres, an SSE
 * frame arriving over the network, or a Redis Stream entry written by another
 * replica.
 */
export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.snapshot"), run: runSchema }),
  z.object({ type: z.literal("run.status"), runId: z.string(), status: runStatusSchema }),
  z.object({ type: z.literal("candidate.started"), runId: z.string(), candidateId: z.string() }),
  /**
   * A chunk of a candidate's answer as it is generated.
   *
   * Deliberately **ephemeral**: deltas are published to the live bus but never
   * written to the durable log. A run produces thousands of them, and the
   * `candidate.settled` event that follows carries the complete text — so a
   * client that reconnects mid-candidate loses nothing but animation.
   */
  z.object({
    type: z.literal("candidate.delta"),
    runId: z.string(),
    candidateId: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("candidate.settled"), runId: z.string(), candidate: candidateSchema }),
  z.object({ type: z.literal("synthesis.started"), runId: z.string(), model: z.string() }),
  z.object({ type: z.literal("synthesis.settled"), runId: z.string(), synthesis: synthesisSchema }),
  z.object({ type: z.literal("run.completed"), runId: z.string(), totalLatencyMs: z.number() }),
  z.object({ type: z.literal("run.failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("run.canceled"), runId: z.string(), reason: z.string() }),
])

/** The wire and storage shape of every in-flight run event. */
export type RunEvent = z.infer<typeof runEventSchema>

export const runEventTypeSchema = z.enum([
  "run.snapshot",
  "run.status",
  "candidate.started",
  "candidate.delta",
  "candidate.settled",
  "synthesis.started",
  "synthesis.settled",
  "run.completed",
  "run.failed",
  "run.canceled",
])
export type RunEventType = z.infer<typeof runEventTypeSchema>

/**
 * An event as it travels the progress bus.
 *
 * `seq` is the position in the run's durable log, and is what a reconnecting
 * client sends back as its cursor. Ephemeral events carry `null` — they were
 * never written to the log, so they have no position in it and are simply
 * dropped by a subscriber that is still catching up.
 */
export const runEventFrameSchema = z.object({
  runId: z.string(),
  seq: z.number().int().positive().nullable(),
  event: runEventSchema,
  createdAt: z.string(),
})
export type RunEventFrame = z.infer<typeof runEventFrameSchema>

/**
 * One row of the durable run event log: the event itself plus the sequence
 * number that makes replay ordered, gap-free and resumable from a cursor.
 */
export const runEventRecordSchema = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  event: runEventSchema,
  createdAt: z.string(),
})
export type RunEventRecord = z.infer<typeof runEventRecordSchema>

/**
 * Events after which no further event can arrive for a run.
 *
 * A subscriber closes its stream on one of these, so the set has to stay in
 * step with the union — hence the exhaustive switch below rather than a literal
 * list that would silently go stale when a variant is added.
 */
export function isTerminalEvent(event: RunEvent): boolean {
  switch (event.type) {
    case "run.completed":
    case "run.failed":
    case "run.canceled":
      return true
    case "run.snapshot":
    case "run.status":
    case "candidate.started":
    case "candidate.delta":
    case "candidate.settled":
    case "synthesis.started":
    case "synthesis.settled":
      return false
    default:
      return assertNever(event, "isTerminalEvent")
  }
}

export const TERMINAL_EVENT_TYPES: readonly RunEventType[] = [
  "run.completed",
  "run.failed",
  "run.canceled",
]

/**
 * True for events that are published live but never persisted.
 *
 * The durable log is what makes replay across replicas possible; writing one
 * row per generated token would make it the bottleneck instead. Ephemeral
 * events are the explicit, named exception to "everything goes in the log".
 */
export function isEphemeralEvent(event: RunEvent): boolean {
  return event.type === "candidate.delta"
}
