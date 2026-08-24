import {
  candidateReviewSchema,
  runEventSchema,
  toJson,
  type Candidate,
  type CandidateReview,
  type CandidateStatus,
  type ProviderId,
  type Run,
  type RunEvent,
  type RunEventRecord,
  type RunStatus,
  type RunSummary,
  type Synthesis,
  type UsageKind,
  type UsageRecord,
  type UsageTotals,
} from "@sce/shared"
import { z } from "zod"
import { blobKey, blobStore, LARGE_BODY_THRESHOLD_BYTES } from "./blob.ts"
import { prisma } from "./client.ts"
import type { Prisma } from "../generated/client.ts"

/*
 * Tenant scoping is not optional.
 *
 * Every exported function takes a `tenantId` and every query filters on it —
 * directly, or through the owning run's relation. There is no "internal"
 * variant that skips the filter, because the moment one exists it becomes the
 * one somebody calls by mistake. `repository.scoping.test.ts` re-checks this
 * statically on every commit, and `isolation.test.ts` checks it against a live
 * database.
 *
 * The only queries here that are not tenant-scoped are the `ModelPrice`
 * lookups: the price list is install-global reference data, owned by nobody.
 */

/* ------------------------------------------------------------------ types */

type CandidateRow = Awaited<ReturnType<typeof prisma.candidate.findFirstOrThrow>>
type SynthesisRow = Awaited<ReturnType<typeof prisma.synthesis.findFirstOrThrow>>
type RunRow = Awaited<ReturnType<typeof prisma.run.findFirstOrThrow>>
type UsageRow = Awaited<ReturnType<typeof prisma.usageRecord.findFirstOrThrow>>

const runInclude = {
  candidates: { orderBy: { position: "asc" } },
  synthesis: true,
} satisfies Prisma.RunInclude

/* -------------------------------------------------------- json boundaries */

const stringArraySchema = z.array(z.string())
const reviewArraySchema = z.array(candidateReviewSchema)

/**
 * Read a native `Json` column into a domain type.
 *
 * The column is `Json`, so the driver hands back `unknown` — exactly the shape
 * a Zod parser is for. A row written by an older schema version, or by hand in
 * psql, degrades to the fallback instead of poisoning the response with a
 * mistyped value.
 */
function fromJsonColumn<T>(raw: unknown, schema: z.ZodType<T>, fallback: T): T {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : fallback
}

/* ------------------------------------------------------------ large bodies */

interface StoredBody {
  inline: string | null
  ref: string | null
  bytes: number
}

/** Keep a body in its row, or offload it and keep a pointer. */
async function storeBody(
  tenantId: string,
  runId: string,
  name: string,
  body: string,
): Promise<StoredBody> {
  const bytes = Buffer.byteLength(body, "utf8")
  if (bytes < LARGE_BODY_THRESHOLD_BYTES) return { inline: body, ref: null, bytes }

  const key = blobKey(tenantId, runId, name)
  await blobStore().put(key, body)
  return { inline: null, ref: key, bytes }
}

/**
 * Resolve a body back to its text.
 *
 * A missing blob is reported in-band rather than thrown: losing one answer body
 * must not make the whole run unreadable.
 */
async function readBody(inline: string | null, ref: string | null): Promise<string | null> {
  if (inline !== null) return inline
  if (ref === null) return null
  const body = await blobStore().get(ref)
  return body ?? `[answer body unavailable — object ${ref} could not be read]`
}

async function deleteBodies(refs: (string | null)[]): Promise<void> {
  await Promise.all(
    refs.filter((ref): ref is string => ref !== null).map((ref) => blobStore().delete(ref)),
  )
}

/* ----------------------------------------------------------------- mappers */

export async function toCandidate(row: CandidateRow): Promise<Candidate> {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    status: row.status,
    content: await readBody(row.content, row.contentRef),
    error: row.error,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  }
}

export async function toSynthesis(row: SynthesisRow): Promise<Synthesis> {
  return {
    id: row.id,
    model: row.model,
    finalAnswer: (await readBody(row.finalAnswer, row.finalAnswerRef)) ?? "",
    agreements: fromJsonColumn(row.agreements, stringArraySchema, []),
    disagreements: fromJsonColumn(row.disagreements, stringArraySchema, []),
    reviews: fromJsonColumn<CandidateReview[]>(row.reviews, reviewArraySchema, []),
    confidence: row.confidence,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  }
}

export async function toRun(
  row: RunRow & { candidates: CandidateRow[]; synthesis: SynthesisRow | null },
): Promise<Run> {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    error: row.error,
    totalLatencyMs: row.totalLatencyMs,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    candidates: await Promise.all(row.candidates.map(toCandidate)),
    synthesis: row.synthesis ? await toSynthesis(row.synthesis) : null,
  }
}

function toUsageRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicroCents: Number(row.costMicroCents),
    priceId: row.priceId,
    createdAt: row.createdAt.toISOString(),
  }
}

/* --------------------------------------------------------------- mutations */

export interface CandidateSeed {
  provider: ProviderId
  label: string
  model: string
  status: CandidateStatus
  error?: string | null
}

export async function createRun(input: {
  tenantId: string
  createdByUserId?: string | null
  prompt: string
  temperature?: number
  candidates: CandidateSeed[]
}): Promise<Run> {
  const row = await prisma.run.create({
    data: {
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId ?? null,
      prompt: input.prompt,
      temperature: input.temperature ?? null,
      status: "PENDING",
      candidates: {
        create: input.candidates.map((c, position) => ({
          position,
          provider: c.provider,
          label: c.label,
          model: c.model,
          status: c.status,
          error: c.error ?? null,
        })),
      },
    },
    include: runInclude,
  })
  return toRun(row)
}

export async function setRunStatus(
  tenantId: string,
  runId: string,
  status: RunStatus,
): Promise<void> {
  await prisma.run.update({ where: { id: runId, tenantId }, data: { status } })
}

export async function setCandidateRunning(
  tenantId: string,
  runId: string,
  candidateId: string,
): Promise<Candidate> {
  const row = await prisma.candidate.update({
    where: { id: candidateId, run: { id: runId, tenantId } },
    data: { status: "RUNNING" },
  })
  return toCandidate(row)
}

export async function settleCandidate(
  tenantId: string,
  runId: string,
  candidateId: string,
  result:
    | {
        status: "OK"
        content: string
        latencyMs: number
        inputTokens: number | null
        outputTokens: number | null
      }
    | { status: "ERROR"; error: string; latencyMs: number },
): Promise<Candidate> {
  const data: Prisma.CandidateUpdateInput =
    result.status === "OK"
      ? await (async () => {
          const body = await storeBody(tenantId, runId, `candidate-${candidateId}.md`, result.content)
          return {
            status: "OK" as const,
            content: body.inline,
            contentRef: body.ref,
            contentBytes: body.bytes,
            error: null,
            latencyMs: result.latencyMs,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          }
        })()
      : { status: "ERROR" as const, error: result.error, latencyMs: result.latencyMs }

  const row = await prisma.candidate.update({
    where: { id: candidateId, run: { id: runId, tenantId } },
    data,
  })
  return toCandidate(row)
}

export async function saveSynthesis(
  tenantId: string,
  runId: string,
  input: {
    model: string
    finalAnswer: string
    agreements: string[]
    disagreements: string[]
    reviews: CandidateReview[]
    confidence: number
    latencyMs: number
    inputTokens: number | null
    outputTokens: number | null
  },
): Promise<Synthesis> {
  // The upsert is not itself tenant-filterable (`runId` is the unique key), so
  // ownership is proven first and the write is scoped to the run it returned.
  const run = await prisma.run.findUnique({ where: { id: runId, tenantId }, select: { id: true } })
  if (!run) throw new Error(`Run ${runId} not found for tenant ${tenantId}`)

  const body = await storeBody(tenantId, runId, "synthesis.md", input.finalAnswer)
  const payload = {
    model: input.model,
    finalAnswer: body.inline,
    finalAnswerRef: body.ref,
    finalAnswerBytes: body.bytes,
    agreements: toJson(input.agreements),
    disagreements: toJson(input.disagreements),
    reviews: toJson(input.reviews),
    confidence: input.confidence,
    latencyMs: input.latencyMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }

  const row = await prisma.synthesis.upsert({
    where: { runId: run.id },
    create: { runId: run.id, ...payload },
    update: payload,
  })
  return toSynthesis(row)
}

export async function completeRun(
  tenantId: string,
  runId: string,
  totalLatencyMs: number,
): Promise<void> {
  await prisma.run.update({
    where: { id: runId, tenantId },
    data: { status: "COMPLETE", totalLatencyMs, completedAt: new Date(), error: null },
  })
}

export async function failRun(tenantId: string, runId: string, error: string): Promise<void> {
  await prisma.run.update({
    where: { id: runId, tenantId },
    data: { status: "FAILED", error, completedAt: new Date() },
  })
}

export async function deleteRun(tenantId: string, runId: string): Promise<boolean> {
  // Offloaded bodies live outside the database, so the cascade cannot reach
  // them; collect the pointers before the rows go.
  const run = await prisma.run.findUnique({
    where: { id: runId, tenantId },
    select: {
      candidates: { select: { contentRef: true } },
      synthesis: { select: { finalAnswerRef: true } },
    },
  })
  if (!run) return false

  const { count } = await prisma.run.deleteMany({ where: { id: runId, tenantId } })
  if (count === 0) return false

  await deleteBodies([
    ...run.candidates.map((c) => c.contentRef),
    run.synthesis?.finalAnswerRef ?? null,
  ])
  return true
}

/* ----------------------------------------------------------------- queries */

export async function getRun(tenantId: string, runId: string): Promise<Run | null> {
  const row = await prisma.run.findUnique({ where: { id: runId, tenantId }, include: runInclude })
  return row ? toRun(row) : null
}

export async function listRuns(options: {
  tenantId: string
  limit: number
  cursor?: string
}): Promise<{ items: RunSummary[]; nextCursor: string | null }> {
  const rows = await prisma.run.findMany({
    where: { tenantId: options.tenantId },
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { candidates: true } }, synthesis: { select: { id: true } } },
  })

  const page = rows.slice(0, options.limit)
  const nextCursor = rows.length > options.limit ? (page.at(-1)?.id ?? null) : null

  return {
    items: page.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      error: row.error,
      totalLatencyMs: row.totalLatencyMs,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      candidateCount: row._count.candidates,
      hasSynthesis: row.synthesis !== null,
    })),
    nextCursor,
  }
}

export async function countRuns(tenantId: string): Promise<number> {
  return prisma.run.count({ where: { tenantId } })
}

/* ------------------------------------------------------- durable event log */

/**
 * Append one event to a run's durable stream.
 *
 * The sequence number is allocated by incrementing a counter on the run inside
 * the same transaction as the insert, so concurrent appenders serialise on the
 * run row and the stream stays gap-free — which is what makes cursor-based
 * replay safe across replicas and restarts.
 */
export async function appendRunEvent(
  tenantId: string,
  runId: string,
  event: RunEvent,
): Promise<RunEventRecord> {
  const payload = toJson(event)

  return prisma.$transaction(async (tx) => {
    const run = await tx.run.update({
      where: { id: runId, tenantId },
      data: { eventSeq: { increment: 1 } },
      select: { eventSeq: true },
    })
    const row = await tx.runEvent.create({
      data: { runId, seq: run.eventSeq, type: event.type, payload },
    })
    return { runId, seq: row.seq, event, createdAt: row.createdAt.toISOString() }
  })
}

/**
 * Replay a run's stream from a cursor.
 *
 * `afterSeq` is exclusive, so a reconnecting client passes the last sequence it
 * saw and gets exactly what it missed — no gap, no duplicate.
 */
export async function listRunEvents(
  tenantId: string,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<RunEventRecord[]> {
  const rows = await prisma.runEvent.findMany({
    where: { runId, run: { tenantId }, ...(options.afterSeq ? { seq: { gt: options.afterSeq } } : {}) },
    orderBy: { seq: "asc" },
    ...(options.limit ? { take: options.limit } : {}),
  })

  const records: RunEventRecord[] = []
  for (const row of rows) {
    const parsed = runEventSchema.safeParse(row.payload)
    // A row that no longer matches the union (an event type removed in a later
    // version) is skipped rather than crashing the replay.
    if (parsed.success) {
      records.push({
        runId: row.runId,
        seq: row.seq,
        event: parsed.data,
        createdAt: row.createdAt.toISOString(),
      })
    }
  }
  return records
}

export async function latestEventSeq(tenantId: string, runId: string): Promise<number> {
  const run = await prisma.run.findUnique({
    where: { id: runId, tenantId },
    select: { eventSeq: true },
  })
  return run?.eventSeq ?? 0
}

/* ------------------------------------------------------------ usage & cost */

/**
 * Price list lookups.
 *
 * `ModelPrice` is install-global reference data — it belongs to no tenant, so
 * these are the only intentionally unscoped queries in this file.
 */
export async function findPrice(
  model: string,
  at: Date = new Date(),
): Promise<{ id: string; inputPerMillion: bigint; outputPerMillion: bigint } | null> {
  return prisma.modelPrice.findFirst({
    where: { model, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: "desc" },
    select: { id: true, inputPerMillion: true, outputPerMillion: true },
  })
}

export async function upsertModelPrice(input: {
  provider: ProviderId
  model: string
  inputPerMillion: number
  outputPerMillion: number
  effectiveFrom: Date
  verified: boolean
}): Promise<void> {
  const data = {
    provider: input.provider,
    model: input.model,
    inputPerMillion: BigInt(input.inputPerMillion),
    outputPerMillion: BigInt(input.outputPerMillion),
    effectiveFrom: input.effectiveFrom,
    verified: input.verified,
  }
  await prisma.modelPrice.upsert({
    where: {
      provider_model_effectiveFrom: {
        provider: input.provider,
        model: input.model,
        effectiveFrom: input.effectiveFrom,
      },
    },
    create: data,
    update: data,
  })
}

/**
 * Record one metered model call.
 *
 * Cost is computed at write time from the price in force, so a later price
 * change never rewrites history. An unpriced model still produces a row — with
 * a zero cost and a null `priceId`, which is the signal Phase 8 alerts on.
 */
export async function recordUsage(input: {
  tenantId: string
  runId: string | null
  candidateId?: string | null
  kind: UsageKind
  provider: ProviderId
  model: string
  inputTokens: number | null
  outputTokens: number | null
  at?: Date
}): Promise<UsageRecord> {
  const at = input.at ?? new Date()
  const inputTokens = input.inputTokens ?? 0
  const outputTokens = input.outputTokens ?? 0

  const price = await findPrice(input.model, at)
  const costMicroCents = price
    ? (BigInt(inputTokens) * price.inputPerMillion + BigInt(outputTokens) * price.outputPerMillion) /
      1_000_000n
    : 0n

  const row = await prisma.usageRecord.create({
    data: {
      tenantId: input.tenantId,
      runId: input.runId,
      candidateId: input.candidateId ?? null,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      costMicroCents,
      priceId: price?.id ?? null,
      createdAt: at,
    },
  })
  return toUsageRecord(row)
}

export async function listUsage(options: {
  tenantId: string
  runId?: string
  limit?: number
}): Promise<UsageRecord[]> {
  const rows = await prisma.usageRecord.findMany({
    where: { tenantId: options.tenantId, ...(options.runId ? { runId: options.runId } : {}) },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 100,
  })
  return rows.map(toUsageRecord)
}

/** Spend and token totals for a tenant over a window. */
export async function usageTotals(options: {
  tenantId: string
  from?: Date
  to?: Date
}): Promise<UsageTotals> {
  // Every query below repeats `tenantId` inline rather than sharing a prebuilt
  // filter object: the scoping check reads the call site, and so does anyone
  // reviewing it.
  const window =
    options.from || options.to
      ? {
          createdAt: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {}

  const [aggregate, runs, unpriced, unverified] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { tenantId: options.tenantId, ...window },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costMicroCents: true },
    }),
    prisma.run.count({ where: { tenantId: options.tenantId, ...window } }),
    prisma.usageRecord.count({
      where: { tenantId: options.tenantId, ...window, priceId: null },
    }),
    prisma.usageRecord.count({
      where: { tenantId: options.tenantId, ...window, price: { verified: false } },
    }),
  ])

  return {
    runs,
    calls: aggregate._count._all,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    costMicroCents: Number(aggregate._sum.costMicroCents ?? 0n),
    hasUnpricedCalls: unpriced > 0,
    hasUnverifiedPricing: unverified > 0,
  }
}
