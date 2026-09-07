import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fingerprint, type CacheKeyInput } from "@sce/shared"
import { setBlobStore, type BlobStore } from "./blob.ts"
import { createCachedRun, findCachedRun } from "./cache.ts"
import { prisma } from "./client.ts"
import {
  completeRun,
  createRun,
  deleteRun,
  getRun,
  saveSynthesis,
  settleCandidate,
  type CandidateSeed,
} from "./repository.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * The answer cache, against the real Postgres.
 *
 * What matching *means* is pure and is tested in
 * `packages/shared/src/answer-cache.test.ts`. What is tested here is everything
 * that only a database can get wrong, and every one of these is a failure mode
 * that would be invisible until a customer saw somebody else's answer:
 *
 *   - a hit never crosses a tenant boundary;
 *   - a hit never returns an unfinished, failed or synthesis-less run;
 *   - a hit expires;
 *   - a copy is independent of its source, so deleting either leaves the other
 *     readable — including the offloaded answer bodies; and
 *   - a copy records no tokens, because nothing was spent.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
  { provider: "anthropic", label: "Claude", model: "claude-sonnet-5", status: "PENDING" },
]

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
let otherTenantId = ""
const runIds: { tenantId: string; runId: string }[] = []

const SEATS: CacheKeyInput["seats"] = [
  { provider: "openai", model: "gpt-5.5" },
  { provider: "anthropic", model: "claude-sonnet-5" },
]

function marks(prompt: string): Promise<Awaited<ReturnType<typeof fingerprint>>> {
  return fingerprint({ prompt, seats: SEATS, temperature: null, promptSetId: "prompts.v1" })
}

/** A finished, cacheable run: two answered candidates and a synthesis. */
async function seedCompleted(
  owner: string,
  prompt: string,
  options: { answer?: string } = {},
): Promise<string> {
  const fingerprints = await marks(prompt)
  const run = await createRun({
    tenantId: owner,
    prompt,
    candidates: SEEDS,
    provenance: {
      promptSetId: "prompts.v1",
      panelId: "trio",
      cacheKey: fingerprints.key,
      cacheScope: fingerprints.scope,
      promptSimhash: fingerprints.simhash,
    },
  })
  runIds.push({ tenantId: owner, runId: run.id })

  for (const candidate of run.candidates) {
    await settleCandidate(owner, run.id, candidate.id, {
      status: "OK",
      content: `${candidate.label} says: ${prompt}`,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    })
  }

  await saveSynthesis(owner, run.id, {
    model: "claude-opus-5",
    finalAnswer: options.answer ?? `The merged answer to: ${prompt}`,
    agreements: ["they agreed"],
    disagreements: [],
    reviews: [],
    confidence: 0.9,
    calibratedConfidence: 0.82,
    calibrationId: "test-map",
    latencyMs: 500,
    inputTokens: 30,
    outputTokens: 40,
  })
  await completeRun(owner, run.id, 900)
  return run.id
}

async function lookup(
  owner: string,
  prompt: string,
  overrides: { ttlMs?: number; nearDuplicates?: boolean } = {},
): Promise<Awaited<ReturnType<typeof findCachedRun>>> {
  const fingerprints = await marks(prompt)
  return findCachedRun({
    tenantId: owner,
    key: fingerprints.key,
    scope: fingerprints.scope,
    prompt,
    ttlMs: overrides.ttlMs ?? 60 * 60_000,
    nearDuplicates: overrides.nearDuplicates ?? true,
  })
}

beforeAll(async () => {
  setBlobStore(blobs)
  tenantId = (await ensureTenant("test-answer-cache", "Answer cache tests")).id
  otherTenantId = (await ensureTenant("test-answer-cache-other", "Answer cache tests, elsewhere")).id
})

afterAll(async () => {
  for (const entry of runIds) await deleteRun(entry.tenantId, entry.runId).catch(() => {})
})

describe("findCachedRun", () => {
  test("finds the same question asked again", async () => {
    const prompt = `cache exact ${Date.now()}`
    const source = await seedCompleted(tenantId, prompt)

    const hit = await lookup(tenantId, prompt)
    expect(hit?.runId).toBe(source)
    expect(hit?.outcome).toBe("exact")
  })

  test("normalisation means case and padding still hit", async () => {
    const prompt = `Cache Normalised ${Date.now()}`
    const source = await seedCompleted(tenantId, prompt)

    const hit = await lookup(tenantId, `   ${prompt.toLowerCase()}   `)
    expect(hit?.runId).toBe(source)
  })

  test("never crosses a tenant boundary", async () => {
    const prompt = `cache isolation ${Date.now()}`
    await seedCompleted(tenantId, prompt)

    // The same question, the same panel, a different workspace. This is the one
    // failure this feature is not allowed to have.
    expect(await lookup(otherTenantId, prompt)).toBeNull()
  })

  test("ignores a run that never finished", async () => {
    const prompt = `cache pending ${Date.now()}`
    const fingerprints = await marks(prompt)
    const run = await createRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      provenance: {
        cacheKey: fingerprints.key,
        cacheScope: fingerprints.scope,
        promptSimhash: fingerprints.simhash,
      },
    })
    runIds.push({ tenantId, runId: run.id })

    expect(await lookup(tenantId, prompt)).toBeNull()
  })

  test("ignores a completed run that produced no synthesis", async () => {
    const prompt = `cache no synthesis ${Date.now()}`
    const fingerprints = await marks(prompt)
    const run = await createRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      provenance: {
        cacheKey: fingerprints.key,
        cacheScope: fingerprints.scope,
        promptSimhash: fingerprints.simhash,
      },
    })
    runIds.push({ tenantId, runId: run.id })
    await completeRun(tenantId, run.id, 10)

    // Reusing this would turn a cheap hit into an answer-less run.
    expect(await lookup(tenantId, prompt)).toBeNull()
  })

  test("expires: a run older than the TTL is not reused", async () => {
    const prompt = `cache ttl ${Date.now()}`
    await seedCompleted(tenantId, prompt)

    expect(await lookup(tenantId, prompt, { ttlMs: 60_000 })).not.toBeNull()
    // A window that has already closed.
    expect(await lookup(tenantId, prompt, { ttlMs: 1 })).toBeNull()
  })

  test("a zero TTL disables the cache entirely", async () => {
    const prompt = `cache disabled ${Date.now()}`
    await seedCompleted(tenantId, prompt)

    expect(await lookup(tenantId, prompt, { ttlMs: 0 })).toBeNull()
  })

  test("finds a genuinely reworded question", async () => {
    const stamp = Date.now()
    const prompt =
      "explain how the transformer attention mechanism works in plain terms for a software " +
      `engineer who has never read the original paper ${stamp}`
    const source = await seedCompleted(tenantId, prompt)

    const near = await lookup(tenantId, `${prompt} please`)
    expect(near?.runId).toBe(source)
    expect(near?.outcome).toBe("near")
  })

  test("refuses a question that swapped a decisive word", async () => {
    const stamp = Date.now()
    const prompt = `how do i reverse a linked list in rust ${stamp}`
    await seedCompleted(tenantId, prompt)

    expect(await lookup(tenantId, `how do i reverse a linked list in python ${stamp}`)).toBeNull()
  })

  test("refuses a question that reordered the same words", async () => {
    const stamp = Date.now()
    const prompt = `does caching improve latency more than batching for run ${stamp}`
    await seedCompleted(tenantId, prompt)

    // Identical words, opposite question. Nothing but the phrase check sees it.
    expect(
      await lookup(tenantId, `does batching improve latency more than caching for run ${stamp}`),
    ).toBeNull()
  })

  test("near matching can be switched off, leaving exact matches", async () => {
    const stamp = Date.now()
    const prompt =
      `explain the cap theorem in distributed systems as carefully as you can for run ${stamp}`
    await seedCompleted(tenantId, prompt)

    const reworded = `${prompt} please`
    expect(await lookup(tenantId, reworded, { nearDuplicates: false })).toBeNull()
    expect((await lookup(tenantId, reworded))?.outcome).toBe("near")
    expect((await lookup(tenantId, prompt, { nearDuplicates: false }))?.outcome).toBe("exact")
  })
})

describe("createCachedRun", () => {
  test("copies the answer, attributes the source, and spends nothing", async () => {
    const prompt = `cache copy ${Date.now()}`
    const source = await seedCompleted(tenantId, prompt)
    const fingerprints = await marks(prompt)

    const copy = await createCachedRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      sourceRunId: source,
      provenance: {
        promptSetId: "prompts.v1",
        panelId: "trio",
        cacheKey: fingerprints.key,
        cacheScope: fingerprints.scope,
        promptSimhash: fingerprints.simhash,
      },
    })

    expect(copy).not.toBeNull()
    if (copy === null) return
    runIds.push({ tenantId, runId: copy.id })

    expect(copy.id).not.toBe(source)
    expect(copy.status).toBe("COMPLETE")
    expect(copy.cachedFromRunId).toBe(source)
    expect(copy.synthesis?.finalAnswer).toBe(`The merged answer to: ${prompt}`)
    expect(copy.synthesis?.calibratedConfidence).toBe(0.82)
    expect(copy.candidates.map((candidate) => candidate.label)).toEqual(["OpenAI", "Claude"])

    // Nothing was generated, so nothing is claimed. A copy reporting tokens it
    // never bought would put the run's own numbers out of step with the invoice.
    expect(copy.candidates.every((candidate) => candidate.inputTokens === null)).toBe(true)
    expect(copy.synthesis?.inputTokens).toBeNull()
    expect(copy.totalLatencyMs).toBe(0)

    // And no usage was metered against it.
    const metered = await prisma.usageRecord.count({ where: { runId: copy.id } })
    expect(metered).toBe(0)
  })

  test("a copy of a copy points at the run that actually paid", async () => {
    const prompt = `cache chain ${Date.now()}`
    const source = await seedCompleted(tenantId, prompt)
    const fingerprints = await marks(prompt)

    const first = await createCachedRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      sourceRunId: source,
      provenance: { cacheKey: fingerprints.key },
    })
    expect(first).not.toBeNull()
    if (first === null) return
    runIds.push({ tenantId, runId: first.id })

    const second = await createCachedRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      sourceRunId: first.id,
      provenance: { cacheKey: fingerprints.key },
    })
    expect(second?.cachedFromRunId).toBe(source)
    if (second !== null) runIds.push({ tenantId, runId: second.id })
  })

  test("a copy is never itself served as a cache hit", async () => {
    const prompt = `cache no chaining ${Date.now()}`
    const source = await seedCompleted(tenantId, prompt)
    const fingerprints = await marks(prompt)

    const copy = await createCachedRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      sourceRunId: source,
      provenance: {
        cacheKey: fingerprints.key,
        cacheScope: fingerprints.scope,
        promptSimhash: fingerprints.simhash,
      },
    })
    if (copy !== null) runIds.push({ tenantId, runId: copy.id })

    // The newest matching run is now the copy, and the lookup still returns the
    // original — so a long-lived question does not accumulate copies of copies.
    expect((await lookup(tenantId, prompt))?.runId).toBe(source)
  })

  test("the copy survives the deletion of its source, body and all", async () => {
    const prompt = `cache independence ${Date.now()}`
    // Comfortably past the inline threshold, so the body is offloaded and the
    // copy has to store its own rather than aliasing the source's object.
    const answer = "x".repeat(80_000)
    const source = await seedCompleted(tenantId, prompt, { answer })

    const copy = await createCachedRun({
      tenantId,
      prompt,
      candidates: SEEDS,
      sourceRunId: source,
      provenance: { cacheKey: (await marks(prompt)).key },
    })
    expect(copy).not.toBeNull()
    if (copy === null) return
    runIds.push({ tenantId, runId: copy.id })

    await deleteRun(tenantId, source)

    const reread = await getRun(tenantId, copy.id)
    expect(reread?.synthesis?.finalAnswer).toBe(answer)
    expect(reread?.candidates.every((candidate) => (candidate.content ?? "").length > 0)).toBe(true)
  })

  test("refuses a source in another tenant", async () => {
    const prompt = `cache foreign source ${Date.now()}`
    const foreign = await seedCompleted(otherTenantId, prompt)

    // Even asked directly, with the id in hand: the source is read back under
    // the copying tenant, so it is simply not there.
    expect(
      await createCachedRun({
        tenantId,
        prompt,
        candidates: SEEDS,
        sourceRunId: foreign,
        provenance: {},
      }),
    ).toBeNull()
  })

  test("refuses a source that has gone", async () => {
    expect(
      await createCachedRun({
        tenantId,
        prompt: "no such source",
        candidates: SEEDS,
        sourceRunId: "run_that_never_existed",
        provenance: {},
      }),
    ).toBeNull()
  })
})
