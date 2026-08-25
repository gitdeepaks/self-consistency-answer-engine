import { appendRunEvent, listRunEvents } from "@sce/db"
import {
  isEphemeralEvent,
  runEventFrameSchema,
  type RunEvent,
  type RunEventFrame,
} from "@sce/shared"
import type { Redis } from "ioredis"
import { z } from "zod"
import { createRedis, redis } from "./connection.ts"
import { queueConfig } from "./env.ts"
import { runStreamKey } from "./names.ts"

/**
 * The durable progress bus.
 *
 * Two stores, each doing the thing it is good at:
 *
 *   - **Postgres** holds the append-only `RunEvent` log with a gap-free `seq`.
 *     It is the archive, and the only thing that can answer "what happened
 *     before I connected" for a run that finished last week.
 *   - **Redis Streams** hold a short live tail. It is what lets a replica that
 *     never touched a run push its events to a client connected to *this*
 *     replica — the thing the old in-process buffer structurally could not do.
 *
 * The join between them is the reason the ordering below is not negotiable:
 *
 *   1. A subscriber records the stream's current tail id *before* it reads
 *      Postgres.
 *   2. It backfills from Postgres for everything after its cursor.
 *   3. It then follows the stream from the recorded id.
 *
 * and a publisher always writes Postgres *first*, then the stream. Together
 * those two orderings mean an event can be seen twice but never missed: if it
 * reached the stream before the recorded id, it was already in Postgres before
 * the backfill query ran. Duplicates are removed by `seq`, so the subscriber
 * sees each event exactly once, in order, with no gap — from any replica, after
 * any restart, at any point in the run.
 */

export type BusMessage =
  | { kind: "event"; frame: RunEventFrame }
  /** Nothing happened for a while. The SSE layer turns this into a keep-alive. */
  | { kind: "heartbeat" }

export interface SubscribeOptions {
  /** Exclusive cursor: deliver only events with a higher `seq`. */
  afterSeq: number
  signal: AbortSignal
}

export interface RunBus {
  /**
   * Persist (unless ephemeral) and publish one event.
   *
   * Returns the frame that was published, so a caller can record the `seq` it
   * reached — which is what a synchronous producer needs in order to know its
   * own position in the log.
   */
  publish(tenantId: string, runId: string, event: RunEvent): Promise<RunEventFrame>
  /** Follow a run from a cursor until the signal aborts or the caller stops. */
  subscribe(tenantId: string, runId: string, options: SubscribeOptions): AsyncGenerator<BusMessage>
  close(): Promise<void>
}

/* ------------------------------------------------------------ persistence */

/**
 * Write the event to the durable log and return the frame to publish.
 *
 * A failed durable write is logged and downgraded to an ephemeral frame rather
 * than thrown. The reasoning: the client is watching a run unfold, and a
 * transient database hiccup should cost them the ability to *replay* that
 * event, not the ability to *see* it. The gap is loud in the logs, which is
 * where an operator can act on it.
 */
async function toFrame(tenantId: string, runId: string, event: RunEvent): Promise<RunEventFrame> {
  const createdAt = new Date().toISOString()
  if (isEphemeralEvent(event)) return { runId, seq: null, event, createdAt }

  try {
    const record = await appendRunEvent(tenantId, runId, event)
    return { runId, seq: record.seq, event, createdAt: record.createdAt }
  } catch (error) {
    console.error("[bus] durable append failed; publishing without a sequence number", {
      runId,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    })
    return { runId, seq: null, event, createdAt }
  }
}

/**
 * Replay the durable log from a cursor.
 *
 * Paged, because a long run's log is unbounded and a reconnecting client with a
 * zero cursor would otherwise pull all of it into memory at once.
 */
async function* backfill(
  tenantId: string,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
): AsyncGenerator<RunEventFrame> {
  const pageSize = 200
  let cursor = afterSeq

  while (!signal.aborted) {
    const page = await listRunEvents(tenantId, runId, { afterSeq: cursor, limit: pageSize })
    for (const record of page) {
      cursor = record.seq
      yield { runId: record.runId, seq: record.seq, event: record.event, createdAt: record.createdAt }
    }
    if (page.length < pageSize) return
  }
}

/* ------------------------------------------------------------ redis wire */

const FRAME_FIELD = "frame"

/**
 * Redis replies are `unknown` at the type level and untrusted at the value
 * level — the entry may have been written by an older build. Both problems have
 * the same answer: parse the reply shape, then parse the payload.
 */
const streamEntrySchema = z.tuple([z.string(), z.array(z.string())])
const streamReplySchema = z.array(z.tuple([z.string(), z.array(streamEntrySchema)]))

function frameFromFields(fields: readonly string[]): RunEventFrame | null {
  const index = fields.indexOf(FRAME_FIELD)
  if (index === -1) return null
  const raw = fields[index + 1]
  if (raw === undefined) return null

  const parsed = runEventFrameSchema.safeParse(safeJsonParse(raw))
  return parsed.success ? parsed.data : null
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- redis bus */

export class RedisRunBus implements RunBus {
  readonly #publisher: Redis

  constructor(publisher: Redis = redis()) {
    this.#publisher = publisher
  }

  async publish(tenantId: string, runId: string, event: RunEvent): Promise<RunEventFrame> {
    const frame = await toFrame(tenantId, runId, event)
    const key = runStreamKey(runId)

    // `MAXLEN ~` trims at whole-node boundaries, which is far cheaper than an
    // exact trim and costs nothing but a handful of extra retained entries.
    await this.#publisher
      .multi()
      .xadd(
        key,
        "MAXLEN",
        "~",
        queueConfig.RUN_STREAM_MAX_LEN,
        "*",
        FRAME_FIELD,
        JSON.stringify(frame),
      )
      .pexpire(key, queueConfig.RUN_STREAM_TTL_MS)
      .exec()

    return frame
  }

  async *subscribe(
    tenantId: string,
    runId: string,
    options: SubscribeOptions,
  ): AsyncGenerator<BusMessage> {
    const key = runStreamKey(runId)
    // A connection parked in XREAD can serve nothing else, so the tail owns one.
    const connection = createRedis()
    // Aborting mid-block would otherwise wait out the full block timeout.
    const onAbort = (): void => {
      connection.disconnect()
    }
    options.signal.addEventListener("abort", onAbort, { once: true })

    try {
      let lastId = await this.#tailId(connection, key)
      let seen = options.afterSeq

      for await (const frame of backfill(tenantId, runId, options.afterSeq, options.signal)) {
        if (frame.seq !== null) seen = frame.seq
        yield { kind: "event", frame }
      }

      while (!options.signal.aborted) {
        const entries = await this.#read(connection, key, lastId, options.signal)
        if (entries === null) {
          if (options.signal.aborted) return
          yield { kind: "heartbeat" }
          continue
        }

        for (const [id, fields] of entries) {
          lastId = id
          const frame = frameFromFields(fields)
          if (frame === null) continue
          // Already delivered by the backfill — the overlap the join guarantees.
          if (frame.seq !== null && frame.seq <= seen) continue
          if (frame.seq !== null) seen = frame.seq
          yield { kind: "event", frame }
        }
      }
    } finally {
      options.signal.removeEventListener("abort", onAbort)
      connection.disconnect()
    }
  }

  /** The stream's current last id, or `0-0` when it has no entries yet. */
  async #tailId(connection: Redis, key: string): Promise<string> {
    const reply = await connection.xrevrange(key, "+", "-", "COUNT", 1)
    const parsed = z.array(streamEntrySchema).safeParse(reply)
    return parsed.success ? (parsed.data[0]?.[0] ?? "0-0") : "0-0"
  }

  /** One blocking read. `null` means the block elapsed with nothing new. */
  async #read(
    connection: Redis,
    key: string,
    lastId: string,
    signal: AbortSignal,
  ): Promise<[string, string[]][] | null> {
    let reply: unknown
    try {
      reply = await connection.xread(
        "COUNT",
        256,
        "BLOCK",
        queueConfig.RUN_STREAM_BLOCK_MS,
        "STREAMS",
        key,
        lastId,
      )
    } catch (error) {
      // The abort handler disconnects the socket, which surfaces here.
      if (signal.aborted) return null
      throw error
    }

    const parsed = streamReplySchema.safeParse(reply)
    if (!parsed.success) return null
    return parsed.data.flatMap(([, entries]) => entries)
  }

  async close(): Promise<void> {
    // The shared publisher's lifecycle belongs to `connection.ts`; a bus that
    // did not open it must not close it.
  }
}

/* --------------------------------------------------------------- local bus */

type LocalListener = (frame: RunEventFrame) => void

/**
 * Single-process bus: Postgres for durability, an in-process fan-out for the
 * live tail.
 *
 * This is the `RUN_TRANSPORT=local` path — the old in-process design, kept
 * behind a flag as Phase 2's migration escape hatch and used by tests that have
 * no reason to involve Redis. It is correct for one replica and *only* one:
 * a second instance cannot see this one's events, which is precisely the
 * limitation the Redis bus exists to remove.
 */
export class LocalRunBus implements RunBus {
  readonly #listeners = new Map<string, Set<LocalListener>>()

  async publish(tenantId: string, runId: string, event: RunEvent): Promise<RunEventFrame> {
    const frame = await toFrame(tenantId, runId, event)
    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(frame)
      } catch (error) {
        console.error("[bus] local listener threw", error)
      }
    }
    return frame
  }

  async *subscribe(
    tenantId: string,
    runId: string,
    options: SubscribeOptions,
  ): AsyncGenerator<BusMessage> {
    const pending: RunEventFrame[] = []
    let wake: (() => void) | null = null

    // Registered before the backfill, for the same reason the Redis bus records
    // its join id first: an event published during the backfill must land
    // somewhere rather than fall between the two reads.
    const listener: LocalListener = (frame) => {
      pending.push(frame)
      wake?.()
    }
    this.#subscribeListener(runId, listener)

    const onAbort = (): void => {
      wake?.()
    }
    options.signal.addEventListener("abort", onAbort)

    try {
      let seen = options.afterSeq

      for await (const frame of backfill(tenantId, runId, options.afterSeq, options.signal)) {
        if (frame.seq !== null) seen = frame.seq
        yield { kind: "event", frame }
      }

      while (!options.signal.aborted) {
        while (pending.length > 0) {
          const frame = pending.shift()
          if (frame === undefined) break
          if (frame.seq !== null && frame.seq <= seen) continue
          if (frame.seq !== null) seen = frame.seq
          yield { kind: "event", frame }
        }
        if (options.signal.aborted) return

        const woke = await this.#waitForEvent(options.signal, (resolve) => {
          wake = resolve
        })
        wake = null
        if (!woke && !options.signal.aborted) yield { kind: "heartbeat" }
      }
    } finally {
      options.signal.removeEventListener("abort", onAbort)
      this.#unsubscribeListener(runId, listener)
    }
  }

  /** Resolves true when woken by a publish, false when the idle timer elapsed. */
  #waitForEvent(signal: AbortSignal, register: (resolve: () => void) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), queueConfig.RUN_STREAM_BLOCK_MS)
      timer.unref?.()
      register(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  #subscribeListener(runId: string, listener: LocalListener): void {
    const set = this.#listeners.get(runId) ?? new Set<LocalListener>()
    set.add(listener)
    this.#listeners.set(runId, set)
  }

  #unsubscribeListener(runId: string, listener: LocalListener): void {
    const set = this.#listeners.get(runId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) this.#listeners.delete(runId)
  }

  async close(): Promise<void> {
    this.#listeners.clear()
  }
}

/* --------------------------------------------------------------- selection */

let bus: RunBus | null = null

/** The process-wide bus, built from `RUN_TRANSPORT` on first use. */
export function runBus(): RunBus {
  bus ??= queueConfig.RUN_TRANSPORT === "local" ? new LocalRunBus() : new RedisRunBus()
  return bus
}

/** Swap the implementation. Tests use this; production reads the env instead. */
export function setRunBus(next: RunBus): void {
  bus = next
}
