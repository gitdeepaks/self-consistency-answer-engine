import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { computeCostMicroCents, MODEL_PRICES, usdPerMillionToMicroCents } from "@sce/shared"
import { prisma } from "./client.ts"
import { setBlobStore, type BlobStore } from "./blob.ts"
import {
  appendRunEvent,
  completeRun,
  createRun,
  deleteRun,
  getRun,
  latestEventSeq,
  listRunEvents,
  listRuns,
  recordUsage,
  saveSynthesis,
  settleCandidate,
  upsertModelPrice,
  usageTotals,
  type CandidateSeed,
} from "./repository.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * Repository tests run against the real Postgres from
 * `infra/docker-compose.yml` — the point of this phase is that the database
 * enforces things (enums, uniqueness, cascades), and a mocked client cannot
 * prove any of that.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
  { provider: "anthropic", label: "Claude", model: "claude-sonnet-5", status: "PENDING" },
]

/** In-memory blob store, so large-body tests leave nothing on disk. */
class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, string>()
  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body)
  }
  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

const blobs = new MemoryBlobStore()
let tenantId = ""
const runIds: string[] = []

async function newRun(prompt = "a test prompt"): Promise<string> {
  const run = await createRun({ tenantId, prompt, candidates: SEEDS })
  runIds.push(run.id)
  return run.id
}

beforeAll(async () => {
  setBlobStore(blobs)
  tenantId = (await ensureTenant("test-repository", "Repository tests")).id
})

afterAll(async () => {
  for (const id of runIds) await deleteRun(tenantId, id).catch(() => {})
  await prisma.usageRecord.deleteMany({ where: { tenantId } })
})

describe("runs", () => {
  test("createRun seeds candidates and reads back through getRun", async () => {
    const runId = await newRun("what is a monad?")
    const run = await getRun(tenantId, runId)

    expect(run?.status).toBe("PENDING")
    expect(run?.candidates.map((c) => c.provider)).toEqual(["openai", "anthropic"])
    expect(run?.candidates.every((c) => c.status === "PENDING")).toBe(true)
  })

  test("candidates keep panel order across reads", async () => {
    // All the candidates of a run are inserted in one statement and share a
    // createdAt to the millisecond, so ordering has to come from an explicit
    // column — otherwise the panel shuffles between reads.
    const runId = await newRun()
    for (let i = 0; i < 5; i++) {
      const run = await getRun(tenantId, runId)
      expect(run?.candidates.map((c) => c.provider)).toEqual(["openai", "anthropic"])
    }
  })

  test("the database rejects a status outside the enum", async () => {
    const runId = await newRun()
    // Wrapped so the assertion sees a plain promise, not a lazy PrismaPromise.
    await expect(
      (async () => {
        await prisma.$executeRaw`UPDATE "Run" SET status = 'NOT_A_STATUS' WHERE id = ${runId}`
      })(),
    ).rejects.toThrow()
  })

  test("listRuns paginates newest-first within the tenant", async () => {
    await newRun("first")
    await newRun("second")

    const page = await listRuns({ tenantId, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()

    const next = await listRuns({ tenantId, limit: 1, cursor: page.nextCursor ?? undefined })
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id)
  })
})

describe("json columns", () => {
  test("agreements, disagreements and reviews round-trip as native JSON", async () => {
    const runId = await newRun()
    const reviews = [
      { provider: "openai" as const, score: 8, strengths: ["clear"], weaknesses: [] },
      { provider: "anthropic" as const, score: 9, strengths: [], weaknesses: ["terse"] },
    ]

    await saveSynthesis(tenantId, runId, {
      model: "claude-opus-5",
      finalAnswer: "the merged answer",
      agreements: ["both said yes"],
      disagreements: ["one said maybe"],
      reviews,
      confidence: 0.9,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    })

    const run = await getRun(tenantId, runId)
    expect(run?.synthesis?.agreements).toEqual(["both said yes"])
    expect(run?.synthesis?.disagreements).toEqual(["one said maybe"])
    expect(run?.synthesis?.reviews).toEqual(reviews)

    // Stored as real JSON, not a JSON-encoded string.
    const row = await prisma.synthesis.findUniqueOrThrow({ where: { runId } })
    expect(Array.isArray(row.agreements)).toBe(true)
  })

  test("a malformed JSON column degrades to the fallback instead of throwing", async () => {
    const runId = await newRun()
    await saveSynthesis(tenantId, runId, {
      model: "claude-opus-5",
      finalAnswer: "answer",
      agreements: [],
      disagreements: [],
      reviews: [],
      confidence: 0.5,
      latencyMs: 1,
      inputTokens: null,
      outputTokens: null,
    })
    await prisma.$executeRaw`UPDATE "Synthesis" SET agreements = '{"not":"an array"}'::jsonb WHERE "runId" = ${runId}`

    const run = await getRun(tenantId, runId)
    expect(run?.synthesis?.agreements).toEqual([])
  })
})

describe("large bodies", () => {
  test("an oversized answer is offloaded and transparently hydrated", async () => {
    const runId = await newRun()
    const run = await getRun(tenantId, runId)
    const candidateId = run?.candidates[0]?.id ?? ""
    const body = "x".repeat(64 * 1024)

    await settleCandidate(tenantId, runId, candidateId, {
      status: "OK",
      content: body,
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 2,
    })

    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } })
    expect(row.content).toBeNull()
    expect(row.contentRef).toContain(`tenants/${tenantId}/runs/${runId}/`)
    expect(row.contentBytes).toBe(body.length)

    const hydrated = await getRun(tenantId, runId)
    expect(hydrated?.candidates[0]?.content).toBe(body)
  })

  test("deleting a run removes its offloaded bodies", async () => {
    const runId = await newRun()
    const run = await getRun(tenantId, runId)
    const candidateId = run?.candidates[0]?.id ?? ""

    await settleCandidate(tenantId, runId, candidateId, {
      status: "OK",
      content: "y".repeat(64 * 1024),
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 2,
    })
    const key = blobKeyOf(blobs, runId)
    expect(key).not.toBeNull()

    expect(await deleteRun(tenantId, runId)).toBe(true)
    expect(blobs.objects.has(key ?? "")).toBe(false)
  })
})

function blobKeyOf(store: MemoryBlobStore, runId: string): string | null {
  for (const key of store.objects.keys()) if (key.includes(runId)) return key
  return null
}

describe("durable event log", () => {
  test("sequence numbers are 1-based, gap-free and replayable from a cursor", async () => {
    const runId = await newRun()

    const first = await appendRunEvent(tenantId, runId, {
      type: "run.status",
      runId,
      status: "FANNING_OUT",
    })
    const second = await appendRunEvent(tenantId, runId, {
      type: "candidate.started",
      runId,
      candidateId: "c1",
    })
    const third = await appendRunEvent(tenantId, runId, {
      type: "run.completed",
      runId,
      totalLatencyMs: 42,
    })

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
    expect(await latestEventSeq(tenantId, runId)).toBe(3)

    const all = await listRunEvents(tenantId, runId)
    expect(all.map((r) => r.event.type)).toEqual([
      "run.status",
      "candidate.started",
      "run.completed",
    ])

    // A client that saw seq 1 gets exactly what it missed.
    const resumed = await listRunEvents(tenantId, runId, { afterSeq: 1 })
    expect(resumed.map((r) => r.seq)).toEqual([2, 3])
  })

  test("concurrent appends do not collide on a sequence number", async () => {
    const runId = await newRun()
    const events = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendRunEvent(tenantId, runId, { type: "candidate.started", runId, candidateId: `c${i}` }),
      ),
    )

    const seqs = events.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  test("events survive as rows, so a replica that never saw the run can replay it", async () => {
    const runId = await newRun()
    await appendRunEvent(tenantId, runId, { type: "run.status", runId, status: "SYNTHESIZING" })

    // Reading straight from the table is what a second replica would do.
    const rows = await prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe("run.status")
  })

  test("deleting a run cascades its events away", async () => {
    const runId = await newRun()
    await appendRunEvent(tenantId, runId, { type: "run.failed", runId, error: "nope" })
    await deleteRun(tenantId, runId)

    expect(await prisma.runEvent.count({ where: { runId } })).toBe(0)
  })
})

describe("usage and cost", () => {
  const model = "test-model-for-pricing"
  const effectiveFrom = new Date("2020-01-01T00:00:00.000Z")

  beforeAll(async () => {
    await upsertModelPrice({
      provider: "anthropic",
      model,
      // $5 / $25 per 1M tokens.
      inputPerMillion: usdPerMillionToMicroCents(5),
      outputPerMillion: usdPerMillionToMicroCents(25),
      effectiveFrom,
      verified: true,
    })
  })

  test("a metered call is priced from the registry", async () => {
    const runId = await newRun()
    const record = await recordUsage({
      tenantId,
      runId,
      kind: "CANDIDATE",
      provider: "anthropic",
      model,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })

    // $30 = 3,000 cents = 3e9 micro-cents.
    expect(record.costMicroCents).toBe(3_000_000_000)
    expect(record.priceId).not.toBeNull()
  })

  test("an unpriced model records zero cost and a null price id", async () => {
    const runId = await newRun()
    const record = await recordUsage({
      tenantId,
      runId,
      kind: "EVALUATOR",
      provider: "google",
      model: "a-model-nobody-has-priced",
      inputTokens: 500,
      outputTokens: 500,
    })

    expect(record.costMicroCents).toBe(0)
    expect(record.priceId).toBeNull()

    const totals = await usageTotals({ tenantId })
    expect(totals.hasUnpricedCalls).toBe(true)
  })

  test("totals aggregate tokens and spend for the tenant", async () => {
    const totals = await usageTotals({ tenantId })
    expect(totals.calls).toBeGreaterThan(0)
    expect(totals.inputTokens).toBeGreaterThan(0)
    expect(totals.costMicroCents).toBeGreaterThan(0)
  })

  test("usage outlives the run it belongs to", async () => {
    const runId = await newRun()
    await recordUsage({
      tenantId,
      runId,
      kind: "CANDIDATE",
      provider: "anthropic",
      model,
      inputTokens: 10,
      outputTokens: 10,
    })
    await deleteRun(tenantId, runId)

    const orphaned = await prisma.usageRecord.findMany({ where: { tenantId, runId: null } })
    expect(orphaned.length).toBeGreaterThan(0)
  })

  test("the in-code price registry agrees with the storage unit", () => {
    const opus = MODEL_PRICES.find((p) => p.model === "claude-opus-5")
    expect(opus?.inputPerMillion).toBe(usdPerMillionToMicroCents(5))
    expect(
      computeCostMicroCents({ inputTokens: 1_000_000, outputTokens: 0 }, opus ?? null),
    ).toBe(usdPerMillionToMicroCents(5))
  })
})

describe("lifecycle", () => {
  test("completeRun and deleteRun are tenant-scoped and idempotent-safe", async () => {
    const runId = await newRun()
    await completeRun(tenantId, runId, 1234)

    const run = await getRun(tenantId, runId)
    expect(run?.status).toBe("COMPLETE")
    expect(run?.totalLatencyMs).toBe(1234)

    expect(await deleteRun(tenantId, runId)).toBe(true)
    expect(await deleteRun(tenantId, runId)).toBe(false)
  })
})
