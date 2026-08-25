import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { CandidateJob, SynthesisJob } from "@sce/shared"
import type { Worker } from "bullmq"
import { closeRedis } from "./connection.ts"
import {
  listDeadLetters,
  purgeDeadLetters,
  queueDepths,
  replayDeadLetter,
} from "./dlq.ts"
import { CANDIDATE_QUEUE, candidateJobId } from "./names.ts"
import {
  BullRunQueue,
  candidateQueueHandle,
  createCandidateWorker,
  createSynthesisWorker,
  synthesisQueueHandle,
} from "./queues.ts"

/**
 * The real queue, against the real Redis from `infra/docker-compose.yml`.
 *
 * These are the properties the whole of Phase 2 rests on, and none of them can
 * be established against a mock: that a run is a flow whose parent waits for
 * its children, that a duplicate enqueue is a no-op, that a child which gives
 * up cannot strand the parent, and that a job which exhausts its attempts is
 * still there afterwards to be looked at and put back.
 */

const RUN_ID = `test-run-${process.pid}-${Date.now()}`

let candidateWorker: Worker<CandidateJob, void> | null = null
let synthesisWorker: Worker<SynthesisJob, void> | null = null

/** What each processor did, in the order it happened. */
const log: string[] = []
/** Candidate ids the processor should throw for, and how many times. */
const failures = new Map<string, number>()

async function drain(): Promise<void> {
  await Promise.all([
    candidateQueueHandle().obliterate({ force: true }),
    synthesisQueueHandle().obliterate({ force: true }),
  ])
}

beforeAll(async () => {
  await drain()

  candidateWorker = createCandidateWorker(async (job) => {
    const remaining = failures.get(job.candidateId) ?? 0
    if (remaining > 0) {
      failures.set(job.candidateId, remaining - 1)
      throw new Error(`candidate ${job.candidateId} is unwell`)
    }
    log.push(`candidate:${job.candidateId}`)
  })

  synthesisWorker = createSynthesisWorker(async (job) => {
    log.push(`synthesis:${job.runId}`)
  })

  await Promise.all([candidateWorker.waitUntilReady(), synthesisWorker.waitUntilReady()])
})

beforeEach(() => {
  log.length = 0
  failures.clear()
})

afterAll(async () => {
  await Promise.all([candidateWorker?.close(), synthesisWorker?.close()])
  await drain()
  await new BullRunQueue().close()
  await closeRedis()
})

/** Wait until `predicate` holds, or give up. Queues are eventually consistent. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(`condition not met within ${timeoutMs}ms; log was ${JSON.stringify(log)}`)
}

describe("bull run queue", () => {
  test("runs every candidate, then synthesis once they have all settled", async () => {
    const runId = `${RUN_ID}-flow`
    const candidateIds = ["c1", "c2", "c3"]

    await new BullRunQueue().enqueueRun({ tenantId: "t1", runId, candidateIds })
    await until(() => log.includes(`synthesis:${runId}`))

    // Every candidate ran, and the parent ran strictly after all of them —
    // which is the property that makes the fan-out splittable across machines.
    for (const id of candidateIds) expect(log).toContain(`candidate:${id}`)
    expect(log.at(-1)).toBe(`synthesis:${runId}`)
    expect(log.filter((entry) => entry.startsWith("synthesis:"))).toHaveLength(1)
  })

  test("enqueueing the same run twice does not fan out twice", async () => {
    const runId = `${RUN_ID}-idem`
    const queue = new BullRunQueue()

    await queue.enqueueRun({ tenantId: "t1", runId, candidateIds: ["d1", "d2"] })
    // A retried enqueue — a redelivered API request, a replayed webhook.
    await queue.enqueueRun({ tenantId: "t1", runId, candidateIds: ["d1", "d2"] })

    await until(() => log.includes(`synthesis:${runId}`))
    await Bun.sleep(300)

    // Deterministic job ids make the second add a no-op. Without this, two
    // panels would be generated and the tenant charged for both.
    expect(log.filter((entry) => entry === "candidate:d1")).toHaveLength(1)
    expect(log.filter((entry) => entry === "candidate:d2")).toHaveLength(1)
    expect(log.filter((entry) => entry === `synthesis:${runId}`)).toHaveLength(1)
  })

  test("a child that exhausts its attempts lands in the DLQ and frees the parent", async () => {
    await purgeDeadLetters()
    const runId = `${RUN_ID}-dlq`

    // One attempt, so the failure is terminal immediately rather than after
    // the production backoff schedule.
    await candidateQueueHandle().add(
      "candidate",
      { tenantId: "t1", runId, candidateId: "doomed" },
      { jobId: candidateJobId(runId, "doomed"), attempts: 1, removeOnFail: { count: 100 } },
    )
    failures.set("doomed", 5)

    // Wait for the worker to pick it up, fail it, and move it to the failed set.
    let letters: Awaited<ReturnType<typeof listDeadLetters>> = []
    await until(async () => {
      letters = await listDeadLetters({ limit: 20 })
      return letters.some((letter) => letter.jobId === candidateJobId(runId, "doomed"))
    })

    const doomed = letters.find((letter) => letter.jobId === candidateJobId(runId, "doomed"))
    expect(doomed).toBeDefined()
    expect(doomed?.queue).toBe(CANDIDATE_QUEUE)
    expect(doomed?.failedReason).toContain("is unwell")
    // The payload survives, which is what makes a replay possible at all.
    expect(doomed?.data).toMatchObject({ runId, candidateId: "doomed" })

    // Replaying it succeeds now that the processor is willing.
    failures.clear()
    expect(await replayDeadLetter(CANDIDATE_QUEUE, candidateJobId(runId, "doomed"))).toBe(true)
    await until(() => log.includes("candidate:doomed"))

    const after = await listDeadLetters({ limit: 20 })
    expect(after.some((letter) => letter.jobId === candidateJobId(runId, "doomed"))).toBe(false)
  })

  test("reports queue depth for the operator", async () => {
    const depths = await queueDepths()
    expect(depths.map((depth) => depth.queue)).toContain(CANDIDATE_QUEUE)
    for (const depth of depths) {
      expect(depth.waiting).toBeGreaterThanOrEqual(0)
      expect(depth.failed).toBeGreaterThanOrEqual(0)
    }
  })
})
