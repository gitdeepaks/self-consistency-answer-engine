import { afterAll, describe, expect, test } from "bun:test"
import { createRun, deleteRun, ensureTenant, type CandidateSeed } from "@sce/db"
import type { RunEvent } from "@sce/shared"
import { LocalRunBus, RedisRunBus, type BusMessage, type RunBus } from "./bus.ts"
import { closeRedis, redis } from "./connection.ts"
import { runStreamKey } from "./names.ts"

/**
 * The progress bus, tested against both transports.
 *
 * Every assertion below runs twice — once on the in-process bus and once on the
 * Redis-backed one — because the whole point of the abstraction is that they
 * are interchangeable. A property that holds for `local` but not for `redis` is
 * a bug that would only ever appear in production.
 *
 * The Redis half needs the real thing from `infra/docker-compose.yml`. A
 * mocked Redis would prove that the mock behaves as expected, which is not the
 * question: what is being tested here is the join between a Postgres backfill
 * and a live stream tail, and only a real stream can get that wrong.
 */

const tenantId = (await ensureTenant("test-bus", "Bus tests")).id

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "mock-openai", status: "PENDING" },
]

const createdRuns: string[] = []

async function seedRun(): Promise<string> {
  const run = await createRun({ tenantId, prompt: "bus test", candidates: SEEDS })
  createdRuns.push(run.id)
  return run.id
}

afterAll(async () => {
  for (const runId of createdRuns) {
    await redis().del(runStreamKey(runId))
    await deleteRun(tenantId, runId)
  }
  await closeRedis()
})

/** Collect messages until `stop` says so, or the deadline passes. */
async function collect(
  bus: RunBus,
  runId: string,
  afterSeq: number,
  stop: (message: BusMessage) => boolean,
  timeoutMs = 5_000,
): Promise<{ messages: BusMessage[]; controller: AbortController; done: Promise<void> }> {
  const controller = new AbortController()
  const messages: BusMessage[] = []
  const guard = setTimeout(() => controller.abort(), timeoutMs)

  const done = (async () => {
    try {
      for await (const message of bus.subscribe(tenantId, runId, {
        afterSeq,
        signal: controller.signal,
      })) {
        messages.push(message)
        if (stop(message)) return
      }
    } finally {
      clearTimeout(guard)
      controller.abort()
    }
  })()

  return { messages, controller, done }
}

function events(messages: readonly BusMessage[]): RunEvent[] {
  return messages.flatMap((message) => (message.kind === "event" ? [message.frame.event] : []))
}

const TRANSPORTS: { name: string; make: () => RunBus }[] = [
  { name: "local", make: () => new LocalRunBus() },
  { name: "redis", make: () => new RedisRunBus() },
]

for (const transport of TRANSPORTS) {
  describe(`run bus (${transport.name})`, () => {
    test("assigns gap-free sequence numbers and replays them in order", async () => {
      const bus = transport.make()
      const runId = await seedRun()

      const first = await bus.publish(tenantId, runId, {
        type: "run.status",
        runId,
        status: "QUEUED",
      })
      const second = await bus.publish(tenantId, runId, {
        type: "run.status",
        runId,
        status: "FANNING_OUT",
      })
      const third = await bus.publish(tenantId, runId, {
        type: "run.completed",
        runId,
        totalLatencyMs: 5,
      })

      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])

      // A subscriber joining after the fact still sees the whole timeline.
      const { messages, done } = await collect(
        bus,
        runId,
        0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )
      await done

      expect(events(messages).map((event) => event.type)).toEqual([
        "run.status",
        "run.status",
        "run.completed",
      ])
      await bus.close()
    })

    test("resumes from a cursor without a gap or a duplicate", async () => {
      const bus = transport.make()
      const runId = await seedRun()

      await bus.publish(tenantId, runId, { type: "run.status", runId, status: "QUEUED" })
      const second = await bus.publish(tenantId, runId, {
        type: "run.status",
        runId,
        status: "FANNING_OUT",
      })
      await bus.publish(tenantId, runId, { type: "run.completed", runId, totalLatencyMs: 7 })

      const { messages, done } = await collect(
        bus,
        runId,
        second.seq ?? 0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )
      await done

      // Exactly what was missed: not the two already seen, and no repeat.
      expect(events(messages).map((event) => event.type)).toEqual(["run.completed"])
      await bus.close()
    })

    test("delivers events published after the subscription started", async () => {
      const bus = transport.make()
      const runId = await seedRun()

      const { messages, done } = await collect(
        bus,
        runId,
        0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )

      // Let the subscriber reach its tail before anything is published, which
      // is the case the join between backfill and live tail has to survive.
      await Bun.sleep(150)
      await bus.publish(tenantId, runId, { type: "run.status", runId, status: "FANNING_OUT" })
      await bus.publish(tenantId, runId, { type: "run.completed", runId, totalLatencyMs: 9 })
      await done

      expect(events(messages).map((event) => event.type)).toEqual([
        "run.status",
        "run.completed",
      ])
      await bus.close()
    })

    test("does not deliver the same event twice across the backfill/tail join", async () => {
      const bus = transport.make()
      const runId = await seedRun()

      // Published before the subscriber exists: it is in Postgres *and*, for the
      // Redis transport, in the stream. Exactly one copy must come out.
      await bus.publish(tenantId, runId, { type: "run.status", runId, status: "QUEUED" })

      const { messages, done } = await collect(
        bus,
        runId,
        0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )

      await Bun.sleep(150)
      await bus.publish(tenantId, runId, { type: "run.completed", runId, totalLatencyMs: 3 })
      await done

      const seqs = messages.flatMap((message) =>
        message.kind === "event" && message.frame.seq !== null ? [message.frame.seq] : [],
      )
      expect(seqs).toEqual([...new Set(seqs)])
      expect(seqs).toEqual([1, 2])
      await bus.close()
    })

    test("passes ephemeral deltas through live but never persists them", async () => {
      const bus = transport.make()
      const runId = await seedRun()

      const { messages, done } = await collect(
        bus,
        runId,
        0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )

      await Bun.sleep(150)
      const delta = await bus.publish(tenantId, runId, {
        type: "candidate.delta",
        runId,
        candidateId: "c1",
        text: "hello",
      })
      await bus.publish(tenantId, runId, { type: "run.completed", runId, totalLatencyMs: 1 })
      await done

      // No sequence number, because it has no position in the durable log.
      expect(delta.seq).toBeNull()
      expect(events(messages).map((event) => event.type)).toEqual([
        "candidate.delta",
        "run.completed",
      ])

      // And a later subscriber replaying from scratch does not see it at all.
      const { messages: replayed, done: replayDone } = await collect(
        bus,
        runId,
        0,
        (message) => message.kind === "event" && message.frame.event.type === "run.completed",
      )
      await replayDone
      expect(events(replayed).map((event) => event.type)).toEqual(["run.completed"])
      await bus.close()
    })
  })
}

describe("run bus (cross-replica)", () => {
  test("a run published by one bus instance streams to a subscriber on another", async () => {
    // The whole reason Phase 2 exists: the publisher and the subscriber are
    // different objects holding different connections, exactly as an API
    // replica and a worker are different processes on different machines.
    const publisher = new RedisRunBus()
    const subscriber = new RedisRunBus()
    const runId = await seedRun()

    const { messages, done } = await collect(
      subscriber,
      runId,
      0,
      (message) => message.kind === "event" && message.frame.event.type === "run.completed",
    )

    await Bun.sleep(150)
    await publisher.publish(tenantId, runId, {
      type: "candidate.started",
      runId,
      candidateId: "c1",
    })
    await publisher.publish(tenantId, runId, { type: "run.completed", runId, totalLatencyMs: 4 })
    await done

    expect(events(messages).map((event) => event.type)).toEqual([
      "candidate.started",
      "run.completed",
    ])
  })
})
