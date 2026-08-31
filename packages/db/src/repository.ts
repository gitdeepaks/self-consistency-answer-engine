import {
  candidateReviewSchema,
  isTerminalRunStatus,
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
    attempts: row.attempts,
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
    createdByUserId: row.createdByUserId,
    prompt: row.prompt,
    status: row.status,
    error: row.error,
    totalLatencyMs: row.totalLatencyMs,
    temperature: row.temperature,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    tags: row.tags,
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

export interface CreateRunInput {
  tenantId: string
  createdByUserId?: string | null
  prompt: string
  temperature?: number
  candidates: CandidateSeed[]
  /** Caller-supplied `Idempotency-Key`, if any. */
  idempotencyKey?: string | null
  /** Wall-clock deadline for the whole run. */
  deadlineAt?: Date | null
  /** Per-run ceilings the worker enforces before each model call. */
  maxTotalTokens?: number | null
  maxCostMicroCents?: number | null
}

export async function createRun(input: CreateRunInput): Promise<Run> {
  const row = await prisma.run.create({
    data: {
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId ?? null,
      prompt: input.prompt,
      temperature: input.temperature ?? null,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey ?? null,
      deadlineAt: input.deadlineAt ?? null,
      maxTotalTokens: input.maxTotalTokens ?? null,
      maxCostMicroCents:
        input.maxCostMicroCents === undefined || input.maxCostMicroCents === null
          ? null
          : BigInt(input.maxCostMicroCents),
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

/**
 * Find the run a previous request with this idempotency key created.
 *
 * The unique index is what actually prevents a duplicate; this lookup is the
 * fast path that avoids provoking a constraint violation on the overwhelmingly
 * common retry. `createRunIdempotent` handles the race the lookup cannot.
 */
export async function findRunByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<Run | null> {
  const row = await prisma.run.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    include: runInclude,
  })
  return row ? toRun(row) : null
}

/** A run creation attempt: either this call made it, or an earlier one did. */
export interface IdempotentRun {
  run: Run
  /** False when the run already existed under the same idempotency key. */
  created: boolean
}

/**
 * Create a run, or return the one an earlier identical request created.
 *
 * Two concurrent retries of the same request race here, and the loser gets a
 * unique-constraint violation rather than a duplicate row — because the
 * guarantee lives in the database index, not in the check above it. Catching
 * P2002 and re-reading is what turns that violation into the correct answer.
 */
export async function createRunIdempotent(input: CreateRunInput): Promise<IdempotentRun> {
  const key = input.idempotencyKey ?? null
  if (key === null) return { run: await createRun(input), created: true }

  const existing = await findRunByIdempotencyKey(input.tenantId, key)
  if (existing) return { run: existing, created: false }

  try {
    return { run: await createRun(input), created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await findRunByIdempotencyKey(input.tenantId, key)
    if (!raced) throw error
    return { run: raced, created: false }
  }
}

/**
 * Prisma's known-request errors arrive typed as `unknown` in a catch block.
 * Parsed with a schema rather than asserted — the one shape check that decides
 * whether a duplicate run is created is not a good place for a claim the
 * compiler cannot verify.
 */
const prismaErrorCodeSchema = z.object({ code: z.string() })

function isUniqueViolation(error: unknown): boolean {
  const parsed = prismaErrorCodeSchema.safeParse(error)
  return parsed.success && parsed.data.code === "P2002"
}

export async function setRunStatus(
  tenantId: string,
  runId: string,
  status: RunStatus,
): Promise<void> {
  await prisma.run.update({ where: { id: runId, tenantId }, data: { status } })
}

/**
 * Mark a candidate as in flight, counting the attempt.
 *
 * The increment happens here rather than in the worker's retry handler so the
 * count is durable: a job evicted from Redis still leaves behind the record of
 * how many times the panel member was tried.
 */
export async function setCandidateRunning(
  tenantId: string,
  runId: string,
  candidateId: string,
): Promise<Candidate> {
  const row = await prisma.candidate.update({
    where: { id: candidateId, run: { id: runId, tenantId } },
    data: { status: "RUNNING", attempts: { increment: 1 }, error: null },
  })
  return toCandidate(row)
}

/** How a candidate finished. Exactly one of these reaches the row. */
export type CandidateResult =
  | {
      status: "OK"
      content: string
      latencyMs: number
      inputTokens: number | null
      outputTokens: number | null
    }
  /**
   * `ERROR` is a call that was made and failed; `SKIPPED` is a call that was
   * never made (breaker open, budget exhausted, provider unconfigured);
   * `CANCELED` is a call the caller stopped paying for. Collapsing the three
   * into one status is how "we spent money and it failed" becomes
   * indistinguishable from "we correctly declined to spend money".
   */
  | { status: "ERROR" | "SKIPPED" | "CANCELED"; error: string; latencyMs?: number | null }

export async function settleCandidate(
  tenantId: string,
  runId: string,
  candidateId: string,
  result: CandidateResult,
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
      : {
          status: result.status,
          error: result.error,
          latencyMs: result.latencyMs ?? null,
        }

  const row = await prisma.candidate.update({
    where: { id: candidateId, run: { id: runId, tenantId } },
    data,
  })
  return toCandidate(row)
}

/**
 * Store a partial answer produced before a timeout or cancellation cut the call
 * short.
 *
 * Streaming makes this possible for the first time: a call that used to yield
 * nothing on timeout now yields whatever arrived, recorded next to the reason
 * it stopped. The status stays a failure — the text is evidence, not an answer.
 */
export async function settleCandidatePartial(
  tenantId: string,
  runId: string,
  candidateId: string,
  result: { status: "ERROR" | "CANCELED"; error: string; latencyMs: number; partial: string },
): Promise<Candidate> {
  const body = await storeBody(tenantId, runId, `candidate-${candidateId}.partial.md`, result.partial)
  const row = await prisma.candidate.update({
    where: { id: candidateId, run: { id: runId, tenantId } },
    data: {
      status: result.status,
      content: body.inline,
      contentRef: body.ref,
      contentBytes: body.bytes,
      error: result.error,
      latencyMs: result.latencyMs,
    },
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

/* --------------------------------------------------- queueing and cancelling */

/**
 * Record that the queue accepted this run's jobs.
 *
 * Written after the enqueue succeeds, so a run stuck at `PENDING` means the
 * enqueue itself failed — a different incident from a run at `QUEUED` that no
 * worker ever claimed, and one worth being able to tell apart at 3am.
 */
export async function markRunQueued(tenantId: string, runId: string): Promise<void> {
  await prisma.run.updateMany({
    where: { id: runId, tenantId, status: "PENDING" },
    data: { status: "QUEUED" },
  })
}

export interface RunControl {
  status: RunStatus
  canceledAt: Date | null
  cancelReason: string | null
  deadlineAt: Date | null
  maxTotalTokens: number | null
  maxCostMicroCents: number | null
}

/**
 * The small slice of a run the worker checks between steps.
 *
 * Deliberately a narrow projection rather than a full `getRun`: this is read
 * before every model call, and hydrating candidate bodies (possibly from object
 * storage) to answer "was this canceled?" would make the check cost more than
 * the thing it is protecting.
 */
export async function getRunControl(tenantId: string, runId: string): Promise<RunControl | null> {
  const row = await prisma.run.findUnique({
    where: { id: runId, tenantId },
    select: {
      status: true,
      canceledAt: true,
      cancelReason: true,
      deadlineAt: true,
      maxTotalTokens: true,
      maxCostMicroCents: true,
    },
  })
  if (!row) return null
  return {
    status: row.status,
    canceledAt: row.canceledAt,
    cancelReason: row.cancelReason,
    deadlineAt: row.deadlineAt,
    maxTotalTokens: row.maxTotalTokens,
    maxCostMicroCents: row.maxCostMicroCents === null ? null : Number(row.maxCostMicroCents),
  }
}

/** Outcome of a cancellation request, so the API can answer honestly. */
export type CancelOutcome =
  | { outcome: "canceled"; run: Run }
  | { outcome: "already-terminal"; run: Run }
  | { outcome: "not-found" }

/**
 * Cancel a run that has not already finished.
 *
 * The status filter is inside the `updateMany` predicate rather than in a
 * read-then-write above it, so a run that completes in the same instant is
 * never rewritten from `COMPLETE` back to `CANCELED` — the database arbitrates,
 * not a race between two application reads.
 */
export async function cancelRun(
  tenantId: string,
  runId: string,
  reason: string,
): Promise<CancelOutcome> {
  const now = new Date()
  const { count } = await prisma.run.updateMany({
    where: {
      id: runId,
      tenantId,
      status: { in: ["PENDING", "QUEUED", "FANNING_OUT", "SYNTHESIZING"] },
    },
    data: { status: "CANCELED", canceledAt: now, cancelReason: reason, completedAt: now },
  })

  const run = await getRun(tenantId, runId)
  if (!run) return { outcome: "not-found" }
  return count > 0 ? { outcome: "canceled", run } : { outcome: "already-terminal", run }
}

/**
 * Mark every candidate that never got to run as `CANCELED`.
 *
 * Called once the run itself is canceled, so the panel does not sit at
 * `PENDING` forever after its jobs are discarded.
 */
export async function cancelPendingCandidates(
  tenantId: string,
  runId: string,
  reason: string,
): Promise<number> {
  const { count } = await prisma.candidate.updateMany({
    where: { runId, run: { tenantId }, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELED", error: reason },
  })
  return count
}

/**
 * Runs that blew through their deadline without any worker finishing them.
 *
 * The reaper that consumes this is the backstop for the case no in-process
 * timeout can cover: the worker holding the run died between checkpoints, so
 * there is nobody left to notice the deadline passed.
 */
/**
 * Who a maintenance query runs on behalf of.
 *
 * The reaper is the one legitimate system-wide reader in the codebase, and
 * saying so is a discriminated union rather than an optional `tenantId?`
 * precisely because an omitted optional field looks identical to a forgotten
 * one in a diff. `{ kind: "every-tenant" }` has to be typed out.
 */
export type RunScope =
  | { kind: "tenant"; tenantId: string }
  | { kind: "every-tenant"; reason: "deadline reaper runs across the whole install" }

function scopeFilter(scope: RunScope): { tenantId?: string } {
  return scope.kind === "tenant" ? { tenantId: scope.tenantId } : {}
}

export async function listOverdueRuns(options: {
  scope: RunScope
  now?: Date
  limit?: number
}): Promise<{ id: string; tenantId: string; deadlineAt: Date | null }[]> {
  return prisma.run.findMany({
    where: {
      ...scopeFilter(options.scope),
      status: { in: ["PENDING", "QUEUED", "FANNING_OUT", "SYNTHESIZING"] },
      deadlineAt: { lt: options.now ?? new Date() },
    },
    select: { id: true, tenantId: true, deadlineAt: true },
    orderBy: { deadlineAt: "asc" },
    take: options.limit ?? 100,
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

/**
 * Filters a history query may carry, beyond the page it asks for.
 *
 * Every field is optional and an absent field means "do not constrain this",
 * which is what keeps `GET /api/runs` with no parameters meaning exactly what
 * it meant before search existed — the CLI's calls are unchanged.
 */
export interface RunFilters {
  /** Free text, matched case-insensitively against prompt and final answer. */
  q?: string
  status?: readonly RunStatus[]
  providers?: readonly ProviderId[]
  tags?: readonly string[]
  from?: Date
  /** Exclusive upper bound. The route widens a `YYYY-MM-DD` to the day's end. */
  to?: Date
  minConfidence?: number
  /** Only runs started by this person. */
  createdByUserId?: string
}

/**
 * Translate filters into a Prisma predicate.
 *
 * Two decisions worth naming:
 *
 * **Free text spans two tables.** A person searching their history means "the
 * question I asked, or the answer I got", so `q` is an OR across `Run.prompt`
 * and the related `Synthesis.finalAnswer`. The migration adds trigram GIN
 * indexes on both columns, because `contains` compiles to `ILIKE '%…%'` and a
 * leading wildcard makes a B-tree index inert.
 *
 * **Offloaded answers are searched by prompt only.** A body over
 * `LARGE_BODY_THRESHOLD_BYTES` lives in object storage and its column is null,
 * so no SQL predicate can see it. That is a real limitation rather than a bug
 * to hide: the alternative is either pulling every blob on every search, or a
 * second search index, and neither is worth it before there is a user asking
 * for it. The prompt still matches, which is how people find a run in practice.
 */
function runFilterWhere(tenantId: string, filters: RunFilters): Prisma.RunWhereInput {
  const where: Prisma.RunWhereInput = { tenantId }

  if (filters.q !== undefined && filters.q.length > 0) {
    where.OR = [
      { prompt: { contains: filters.q, mode: "insensitive" } },
      { synthesis: { finalAnswer: { contains: filters.q, mode: "insensitive" } } },
    ]
  }

  if (filters.status !== undefined && filters.status.length > 0) {
    where.status = { in: [...filters.status] }
  }

  // `some` rather than `every`: choosing OpenAI and Google means "runs that
  // asked either of them", which is what a multi-select filter reads as. An
  // `every` would return runs whose *entire* panel was inside the selection,
  // which is a different and much less useful question.
  if (filters.providers !== undefined && filters.providers.length > 0) {
    where.candidates = { some: { provider: { in: [...filters.providers] } } }
  }

  if (filters.tags !== undefined && filters.tags.length > 0) {
    where.tags = { hasSome: [...filters.tags] }
  }

  if (filters.from !== undefined || filters.to !== undefined) {
    where.createdAt = {
      ...(filters.from === undefined ? {} : { gte: filters.from }),
      ...(filters.to === undefined ? {} : { lt: filters.to }),
    }
  }

  // Implies the run has a synthesis at all, which is the intended reading:
  // "confidence at least 0" still excludes runs that never produced one. The
  // free-text clause above puts its own synthesis predicate inside `OR`, so
  // these two never contend for this field.
  if (filters.minConfidence !== undefined) {
    where.synthesis = { confidence: { gte: filters.minConfidence } }
  }

  if (filters.createdByUserId !== undefined) {
    where.createdByUserId = filters.createdByUserId
  }

  return where
}

export async function listRuns(options: {
  tenantId: string
  limit: number
  cursor?: string
  filters?: RunFilters
}): Promise<{ items: RunSummary[]; nextCursor: string | null }> {
  const rows = await prisma.run.findMany({
    where: runFilterWhere(options.tenantId, options.filters ?? {}),
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { candidates: true } },
      synthesis: { select: { id: true, confidence: true } },
    },
  })

  const page = rows.slice(0, options.limit)
  const nextCursor = rows.length > options.limit ? (page.at(-1)?.id ?? null) : null

  return {
    items: page.map((row) => ({
      id: row.id,
      createdByUserId: row.createdByUserId,
      prompt: row.prompt,
      status: row.status,
      error: row.error,
      totalLatencyMs: row.totalLatencyMs,
      temperature: row.temperature,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      deadlineAt: row.deadlineAt?.toISOString() ?? null,
      canceledAt: row.canceledAt?.toISOString() ?? null,
      tags: row.tags,
      candidateCount: row._count.candidates,
      hasSynthesis: row.synthesis !== null,
      confidence: row.synthesis?.confidence ?? null,
    })),
    nextCursor,
  }
}

/**
 * Replace a run's tags.
 *
 * Wholesale rather than add/remove, because the UI is a token field whose
 * contents *are* the desired state — a patch API would need the client to
 * compute a diff it does not have, and two people editing tags concurrently
 * would produce a union nobody asked for either way.
 *
 * Deduplicated here rather than trusted from the caller: `["a", "a"]` is a
 * plausible thing for a form to submit and a silly thing to store.
 */
export async function setRunTags(
  tenantId: string,
  runId: string,
  tags: readonly string[],
): Promise<string[] | null> {
  const unique = [...new Set(tags)]
  const result = await prisma.run.updateMany({
    where: { id: runId, tenantId },
    data: { tags: unique },
  })
  return result.count > 0 ? unique : null
}

/**
 * Every tag in use in a workspace, with how many runs carry it.
 *
 * Computed by reading the tag arrays of a bounded window of recent runs rather
 * than by unnesting the whole table: this feeds a filter menu, where the tags
 * somebody used this quarter are the useful ones and a complete historical
 * census is not worth a full scan.
 */
export async function listRunTags(options: {
  tenantId: string
  /** How many recent runs to consider. */
  scan?: number
}): Promise<{ tag: string; count: number }[]> {
  const rows = await prisma.run.findMany({
    where: { tenantId: options.tenantId, NOT: { tags: { isEmpty: true } } },
    select: { tags: true },
    orderBy: { createdAt: "desc" },
    take: options.scan ?? 500,
  })

  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
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

/** Tokens and money already spent on one run. */
export interface RunUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costMicroCents: number
}

/**
 * What a run has spent so far.
 *
 * Read by the worker before every model call so a per-run ceiling is enforced
 * *before* the spend, not reported after it. Summing the persisted
 * `UsageRecord` rows rather than tracking a counter in worker memory is what
 * makes the ceiling hold across retries, restarts and several workers sharing
 * one run's fan-out.
 */
export async function runUsage(tenantId: string, runId: string): Promise<RunUsage> {
  const aggregate = await prisma.usageRecord.aggregate({
    where: { tenantId, runId },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, costMicroCents: true },
  })

  const inputTokens = aggregate._sum.inputTokens ?? 0
  const outputTokens = aggregate._sum.outputTokens ?? 0
  return {
    calls: aggregate._count._all,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costMicroCents: Number(aggregate._sum.costMicroCents ?? 0n),
  }
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
