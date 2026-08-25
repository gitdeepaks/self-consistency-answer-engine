import { z } from "zod"
import type { Redis } from "ioredis"
import { createRedis, redis } from "./connection.ts"
import { queueConfig } from "./env.ts"
import { runCancelChannel } from "./names.ts"

/**
 * Fast-path cancellation.
 *
 * `Run.canceledAt` in Postgres is authoritative — a worker that misses this
 * signal entirely still stops at its next checkpoint, and a worker that starts
 * after the cancellation never begins. This channel exists purely for latency:
 * a candidate that is thirty seconds into a two-minute stream should abort when
 * the user closes the tab, not when the stream finishes.
 *
 * That division is what makes the design safe. The message is an optimisation,
 * so losing it (Redis restart, a subscriber that connected a millisecond late)
 * degrades cancellation from immediate to eventual rather than breaking it.
 */

const cancelMessageSchema = z.object({
  runId: z.string().min(1),
  reason: z.string(),
})
export type CancelMessage = z.infer<typeof cancelMessageSchema>

export interface CancellationBus {
  /** Announce that a run was canceled. Never throws into the caller's path. */
  request(runId: string, reason: string): Promise<void>
  /** Watch one run. Resolves to the unsubscribe function. */
  watch(runId: string, onCancel: (message: CancelMessage) => void): Promise<() => void>
}

export class RedisCancellationBus implements CancellationBus {
  readonly #publisher: Redis

  constructor(publisher: Redis = redis()) {
    this.#publisher = publisher
  }

  async request(runId: string, reason: string): Promise<void> {
    const message: CancelMessage = { runId, reason }
    await this.#publisher.publish(runCancelChannel(runId), JSON.stringify(message))
  }

  async watch(runId: string, onCancel: (message: CancelMessage) => void): Promise<() => void> {
    // A subscribed connection can issue no other commands, so it gets its own.
    const subscriber = createRedis()
    const channel = runCancelChannel(runId)

    subscriber.on("message", (received: string, payload: string) => {
      if (received !== channel) return
      const parsed = cancelMessageSchema.safeParse(parseJson(payload))
      if (parsed.success) onCancel(parsed.data)
    })
    await subscriber.subscribe(channel)

    return () => {
      subscriber.disconnect()
    }
  }
}

/** In-process cancellation, paired with `LocalRunBus` under `RUN_TRANSPORT=local`. */
export class LocalCancellationBus implements CancellationBus {
  readonly #watchers = new Map<string, Set<(message: CancelMessage) => void>>()

  async request(runId: string, reason: string): Promise<void> {
    for (const watcher of this.#watchers.get(runId) ?? []) {
      try {
        watcher({ runId, reason })
      } catch (error) {
        console.error("[cancellation] local watcher threw", error)
      }
    }
  }

  async watch(runId: string, onCancel: (message: CancelMessage) => void): Promise<() => void> {
    const set = this.#watchers.get(runId) ?? new Set<(message: CancelMessage) => void>()
    set.add(onCancel)
    this.#watchers.set(runId, set)

    return () => {
      const current = this.#watchers.get(runId)
      if (!current) return
      current.delete(onCancel)
      if (current.size === 0) this.#watchers.delete(runId)
    }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

let cancellation: CancellationBus | null = null

export function cancellationBus(): CancellationBus {
  cancellation ??=
    queueConfig.RUN_TRANSPORT === "local"
      ? new LocalCancellationBus()
      : new RedisCancellationBus()
  return cancellation
}

export function setCancellationBus(next: CancellationBus): void {
  cancellation = next
}
