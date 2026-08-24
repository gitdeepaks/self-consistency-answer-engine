import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { prisma } from "./client.ts"
import {
  appendRunEvent,
  completeRun,
  createRun,
  deleteRun,
  failRun,
  getRun,
  latestEventSeq,
  listRunEvents,
  listRuns,
  recordUsage,
  saveSynthesis,
  setCandidateRunning,
  setRunStatus,
  settleCandidate,
  usageTotals,
  type CandidateSeed,
} from "./repository.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * Cross-tenant isolation, checked against a live database.
 *
 * Phase 3 owns the route-level version of this suite; this one covers the layer
 * underneath it, where a missing filter would be invisible to any HTTP test. If
 * a repository function ever stops scoping its query, one of these fails.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
]

let alice = ""
let mallory = ""
let aliceRun = ""
let aliceCandidate = ""

beforeAll(async () => {
  alice = (await ensureTenant("test-isolation-a", "Tenant A")).id
  mallory = (await ensureTenant("test-isolation-b", "Tenant B")).id

  const run = await createRun({ tenantId: alice, prompt: "alice's private prompt", candidates: SEEDS })
  aliceRun = run.id
  aliceCandidate = run.candidates[0]?.id ?? ""
})

afterAll(async () => {
  await deleteRun(alice, aliceRun).catch(() => {})
  await prisma.usageRecord.deleteMany({ where: { tenantId: { in: [alice, mallory] } } })
})

describe("tenant isolation", () => {
  test("reads: another tenant cannot fetch the run", async () => {
    expect(await getRun(alice, aliceRun)).not.toBeNull()
    expect(await getRun(mallory, aliceRun)).toBeNull()
  })

  test("lists: another tenant's history does not contain the run", async () => {
    const mine = await listRuns({ tenantId: alice, limit: 50 })
    const theirs = await listRuns({ tenantId: mallory, limit: 50 })

    expect(mine.items.some((r) => r.id === aliceRun)).toBe(true)
    expect(theirs.items.some((r) => r.id === aliceRun)).toBe(false)
  })

  test("writes: every mutation refuses a foreign tenant", async () => {
    await expect(setRunStatus(mallory, aliceRun, "FAILED")).rejects.toThrow()
    await expect(completeRun(mallory, aliceRun, 1)).rejects.toThrow()
    await expect(failRun(mallory, aliceRun, "pwned")).rejects.toThrow()
    await expect(setCandidateRunning(mallory, aliceRun, aliceCandidate)).rejects.toThrow()
    await expect(
      settleCandidate(mallory, aliceRun, aliceCandidate, {
        status: "ERROR",
        error: "pwned",
        latencyMs: 1,
      }),
    ).rejects.toThrow()
    await expect(
      saveSynthesis(mallory, aliceRun, {
        model: "m",
        finalAnswer: "pwned",
        agreements: [],
        disagreements: [],
        reviews: [],
        confidence: 1,
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
      }),
    ).rejects.toThrow()

    // None of that touched the run.
    const run = await getRun(alice, aliceRun)
    expect(run?.status).toBe("PENDING")
    expect(run?.synthesis).toBeNull()
  })

  test("deletes: another tenant cannot delete the run", async () => {
    expect(await deleteRun(mallory, aliceRun)).toBe(false)
    expect(await getRun(alice, aliceRun)).not.toBeNull()
  })

  test("event streams: another tenant cannot read or append", async () => {
    await appendRunEvent(alice, aliceRun, { type: "run.status", runId: aliceRun, status: "PENDING" })

    expect(await listRunEvents(alice, aliceRun)).toHaveLength(1)
    expect(await listRunEvents(mallory, aliceRun)).toHaveLength(0)
    expect(await latestEventSeq(mallory, aliceRun)).toBe(0)
    await expect(
      appendRunEvent(mallory, aliceRun, { type: "run.failed", runId: aliceRun, error: "pwned" }),
    ).rejects.toThrow()
  })

  test("usage: spend is attributed to the tenant that incurred it", async () => {
    await recordUsage({
      tenantId: alice,
      runId: aliceRun,
      kind: "CANDIDATE",
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 100,
      outputTokens: 100,
    })

    expect((await usageTotals({ tenantId: alice })).calls).toBeGreaterThan(0)
    expect((await usageTotals({ tenantId: mallory })).calls).toBe(0)
  })
})
