import {
  findNearDuplicate,
  DEFAULT_NEAR_DUPLICATE_OPTIONS,
  type CacheOutcome,
  type NearDuplicateOptions,
  type Run,
} from "@sce/shared"
import { prisma } from "./client.ts"
import { getRun, storeBody, type CreateRunInput } from "./repository.ts"

/**
 * The answer cache.
 *
 * A panel run costs three model calls and an evaluator every time, including
 * the fourth time somebody asks the same question this week. This module is
 * what turns that into a lookup, and it is written under one constraint that
 * dominates every other consideration: **a cache hit must never serve an answer
 * to a different question, or another workspace's answer to the same one.**
 *
 * Which is why:
 *
 *   - every query here is tenant-scoped, like the rest of this layer, and the
 *     cache key already contains the panel and prompt set, so a hit that
 *     crossed a workspace boundary would have to get past both;
 *   - the near-duplicate path confirms a fingerprint match with a token-overlap
 *     check before it will reuse anything (see `answer-cache.ts`), because
 *     Hamming distance alone will happily equate "in Rust" with "in Python";
 *   - a hit **copies** the answer into a new run rather than returning the old
 *     one. The copy carries its own id, its own tenant, its own timestamps and
 *     a pointer to the run that paid for it, so history, sharing, deletion and
 *     the cache hit rate all keep working with no special cases; and
 *   - the copy writes **no usage records and no token counts**. Nothing was
 *     spent, and a run that reported tokens it never bought would put the
 *     product's own cost dashboard out of step with the invoice.
 */

/** How the cache is allowed to match, and how far back it may look. */
export interface CacheLookupOptions {
  tenantId: string
  /** Exact-match digest from `fingerprint()` in @sce/shared. */
  key: string
  /** Panel digest, which bounds the near-duplicate search. */
  scope: string
  /** The prompt as asked, for the token-overlap confirmation. */
  prompt: string
  ttlMs: number
  /** Off leaves only exact matches, which is the conservative configuration. */
  nearDuplicates: boolean
  nearDuplicateOptions?: NearDuplicateOptions
  /** How many recent runs of the same panel the fingerprint search considers. */
  poolSize?: number
  now?: Date
}

export interface CacheHit {
  /** The run whose answer would be reused. Always one that paid for itself. */
  runId: string
  outcome: Exclude<CacheOutcome, "miss">
  /** Token overlap with the cached prompt. Null on an exact-key match. */
  similarity: number | null
}

const CACHEABLE = {
  status: "COMPLETE",
  // A run with no synthesis has nothing worth reusing, and a cache that served
  // one would turn a cheap hit into an answer-less run.
  synthesis: { isNot: null },
  // Never chain: a hit copies from the run that actually generated the answer,
  // so a long-lived question does not accumulate a chain of copies of copies.
  cachedFromRunId: null,
} as const

/**
 * Find a reusable answer, preferring an exact match.
 *
 * Two queries at worst, both index-only on `[tenantId, cacheKey, createdAt]` and
 * `[tenantId, cacheScope, createdAt]`. The near-duplicate pass is bounded by
 * `poolSize` rather than by the TTL alone: the comparison happens in the
 * application, and an unbounded pool would make a busy workspace's cache lookup
 * slower than the model call it is trying to avoid.
 */
export async function findCachedRun(options: CacheLookupOptions): Promise<CacheHit | null> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - options.ttlMs)
  if (options.ttlMs <= 0) return null

  const exact = await prisma.run.findFirst({
    where: { tenantId: options.tenantId, cacheKey: options.key, createdAt: { gte: since }, ...CACHEABLE },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })
  if (exact !== null) return { runId: exact.id, outcome: "exact", similarity: 1 }

  if (!options.nearDuplicates) return null

  const pool = await prisma.run.findMany({
    where: {
      tenantId: options.tenantId,
      cacheScope: options.scope,
      createdAt: { gte: since },
      promptSimhash: { not: null },
      ...CACHEABLE,
    },
    orderBy: { createdAt: "desc" },
    take: options.poolSize ?? 200,
    select: { id: true, prompt: true, promptSimhash: true },
  })

  const match = findNearDuplicate(
    options.prompt,
    pool.flatMap((row) =>
      row.promptSimhash === null ? [] : [{ runId: row.id, prompt: row.prompt, simhash: row.promptSimhash }],
    ),
    options.nearDuplicateOptions ?? DEFAULT_NEAR_DUPLICATE_OPTIONS,
  )

  return match === null ? null : { runId: match.runId, outcome: "near", similarity: match.similarity }
}

export interface CreateCachedRunInput extends CreateRunInput {
  /**
   * Restated from `CreateRunInput`, because it is the load-bearing field here:
   * the source is read back under this tenant, so a cache hit cannot reach
   * another workspace's answer even if the lookup that produced it were wrong.
   */
  tenantId: string
  /** The run to copy, which must belong to that same tenant. */
  sourceRunId: string
}

/**
 * Materialise a cache hit as a run of its own.
 *
 * One `create`, so the run never exists in a half-copied state: there is no
 * worker coming to finish it, and a partially written cached run would sit at
 * `PENDING` until the reaper failed it — a cache that produced broken runs
 * under load.
 *
 * Returns null when the source has gone or is not reusable after all, which the
 * caller treats as a miss. That is a real race: a source run can be deleted
 * between the lookup and this call, and the correct response is to generate the
 * answer rather than to fail the request.
 *
 * The seeded candidate list is ignored in favour of the source's own panel.
 * Reusing an answer means reusing the panel that produced it, and a copy that
 * claimed a different one would be a lie about where the words came from.
 */
export async function createCachedRun(input: CreateCachedRunInput): Promise<Run | null> {
  const source = await getRun(input.tenantId, input.sourceRunId)
  if (source === null || source.synthesis === null) return null

  const synthesis = source.synthesis
  const answered = source.candidates.filter(
    (candidate) => candidate.status === "OK" && candidate.content !== null,
  )
  if (answered.length === 0) return null

  // The id is generated here rather than left to the schema's `cuid()` default,
  // because the answer bodies are written to object storage under a key derived
  // from it and that has to happen before the row exists. The consequence is
  // visible and worth stating: a cached run's id is a UUID where a generated
  // run's is a cuid. Both are opaque strings to every caller, and inventing a
  // cuid-shaped value to hide the difference would be worse than the difference.
  const id = crypto.randomUUID()
  const now = new Date()

  // Bodies are re-stored under the new run's own keys rather than pointing at
  // the source's blobs, so deleting either run leaves the other readable.
  const bodies = await Promise.all(
    answered.map((candidate) =>
      storeBody(input.tenantId, id, `candidate-${candidate.provider}-${candidate.id}.md`, candidate.content ?? ""),
    ),
  )
  const answerBody = await storeBody(input.tenantId, id, "synthesis.md", synthesis.finalAnswer)

  const row = await prisma.run.create({
    data: {
      id,
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId ?? null,
      prompt: input.prompt,
      status: "COMPLETE",
      temperature: input.temperature ?? null,
      // Zero, honestly: nothing was generated, and reporting the original's
      // latency would make cache hits invisible in the latency dashboards that
      // are meant to show them.
      totalLatencyMs: 0,
      completedAt: now,
      idempotencyKey: input.idempotencyKey ?? null,
      deadlineAt: input.deadlineAt ?? null,
      maxTotalTokens: input.maxTotalTokens ?? null,
      maxCostMicroCents:
        input.maxCostMicroCents === undefined || input.maxCostMicroCents === null
          ? null
          : BigInt(input.maxCostMicroCents),
      promptSetId: input.provenance?.promptSetId ?? null,
      panelId: input.provenance?.panelId ?? null,
      experimentId: input.provenance?.experimentId ?? null,
      variantId: input.provenance?.variantId ?? null,
      cacheKey: input.provenance?.cacheKey ?? null,
      cacheScope: input.provenance?.cacheScope ?? null,
      promptSimhash: input.provenance?.promptSimhash ?? null,
      cachedFromRunId: source.cachedFromRunId ?? source.id,
      candidates: {
        create: answered.map((candidate, position) => ({
          position,
          provider: candidate.provider,
          label: candidate.label,
          model: candidate.model,
          status: "OK",
          content: bodies[position]?.inline ?? null,
          contentRef: bodies[position]?.ref ?? null,
          contentBytes: bodies[position]?.bytes ?? null,
          latencyMs: 0,
          // Null, not copied: no tokens were bought, and a number here would
          // put the run's own token count out of step with its usage records.
          inputTokens: null,
          outputTokens: null,
        })),
      },
      synthesis: {
        create: {
          model: synthesis.model,
          finalAnswer: answerBody.inline,
          finalAnswerRef: answerBody.ref,
          finalAnswerBytes: answerBody.bytes,
          agreements: synthesis.agreements,
          disagreements: synthesis.disagreements,
          reviews: synthesis.reviews,
          confidence: synthesis.confidence,
          calibratedConfidence: synthesis.calibratedConfidence,
          latencyMs: 0,
          inputTokens: null,
          outputTokens: null,
        },
      },
    },
    include: { candidates: { orderBy: { position: "asc" } }, synthesis: true },
  })

  return (await getRun(input.tenantId, row.id)) ?? null
}
