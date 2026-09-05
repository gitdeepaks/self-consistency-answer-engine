import {
  IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENT_RESPONSE_MAX_BYTES,
  type IdempotencyClaim,
  type IdempotentResponse,
} from "@sce/shared"
import { z } from "zod"
import { prisma } from "./client.ts"

/**
 * The record that makes a retried POST safe.
 *
 * Everything here turns on one property: **the claim is an insert, not a read
 * followed by a write.** Two retries of the same request arrive on two API
 * replicas at the same millisecond; a check-then-act would find nothing, both
 * would proceed, and the client would be billed twice for the run the mechanism
 * exists to deduplicate. The unique index on `(tenantId, endpoint, key)` is the
 * arbiter, and the loser of that race learns it lost by catching P2002 — the
 * same discipline `createRunIdempotent` follows in `repository.ts`.
 *
 * The lifecycle is three calls, and a route that uses fewer has a bug:
 *
 *   `claimIdempotencyKey`     before the work, to decide whether to do it;
 *   `completeIdempotencyKey`  after it succeeds, to record what to replay;
 *   `releaseIdempotencyKey`   if it threw, so the key is usable again.
 *
 * The third is the one that is easy to forget and expensive to omit: a claim
 * left `IN_FLIGHT` by a handler that crashed would refuse every retry for
 * twenty-four hours, turning one transient failure into a day-long outage for
 * that key.
 */

type RecordRow = Awaited<ReturnType<typeof prisma.idempotencyRecord.findFirstOrThrow>>

/** The stored response, read back out of two nullable columns. */
const storedResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string(),
})

function storedResponse(row: RecordRow): IdempotentResponse | null {
  const parsed = storedResponseSchema.safeParse({
    status: row.responseStatus,
    body: row.responseBody,
  })
  return parsed.success ? parsed.data : null
}

export interface IdempotencyClaimInput {
  tenantId: string
  /** The operation, as `POST /v1/runs`. Part of the key's uniqueness. */
  endpoint: string
  /** The caller's `Idempotency-Key`, verbatim. */
  key: string
  /** SHA-256 of the method, path and body — from `fingerprintRequest`. */
  fingerprint: string
  now?: Date
}

/**
 * Claim a key, or discover what the last request under it did.
 *
 * An expired record is *replaced* rather than honoured, because the retention
 * window is the whole of the promise: after it, the key means nothing and
 * reusing it is a new request. The replacement is itself racy — two retries can
 * both find the record expired — and the loser falls back through the same
 * P2002 path as any other contention, which is why that path re-reads instead
 * of assuming it knows what it will find.
 */
export async function claimIdempotencyKey(
  input: IdempotencyClaimInput,
): Promise<IdempotencyClaim> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS)

  try {
    await prisma.idempotencyRecord.create({
      data: {
        tenantId: input.tenantId,
        endpoint: input.endpoint,
        key: input.key,
        fingerprint: input.fingerprint,
        status: "IN_FLIGHT",
        expiresAt,
      },
    })
    return { kind: "fresh" }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  const existing = await prisma.idempotencyRecord.findFirst({
    where: { tenantId: input.tenantId, endpoint: input.endpoint, key: input.key },
  })

  // Deleted between the failed insert and this read: whoever removed it has
  // freed the key, and the caller may go round again.
  if (existing === null) return { kind: "fresh" }

  if (existing.expiresAt <= now) {
    const reclaimed = await prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, tenantId: input.tenantId, expiresAt: { lte: now } },
      data: {
        fingerprint: input.fingerprint,
        status: "IN_FLIGHT",
        responseStatus: null,
        responseBody: null,
        expiresAt,
      },
    })
    // The `expiresAt` predicate is the compare-and-swap: a concurrent reclaim
    // that got there first leaves this update matching nothing, and the loser
    // is told to wait rather than proceeding alongside the winner.
    return reclaimed.count > 0 ? { kind: "fresh" } : { kind: "in-flight" }
  }

  // Checked before the status, so a client whose retry logic is sending the
  // wrong body hears about it whether the first request has finished or not.
  if (existing.fingerprint !== input.fingerprint) return { kind: "mismatch" }

  if (existing.status === "IN_FLIGHT") return { kind: "in-flight" }

  const response = storedResponse(existing)
  return response === null ? { kind: "unrecoverable" } : { kind: "replay", response }
}

/**
 * Record what to replay.
 *
 * A response above the cap is settled *without* a body rather than not settled
 * at all: the write happened, so the key must not become reusable, and a later
 * retry gets an honest 409 saying the original succeeded and its response is no
 * longer available. Silently re-running it would be the one outcome the whole
 * mechanism exists to prevent.
 */
export async function completeIdempotencyKey(input: {
  tenantId: string
  endpoint: string
  key: string
  response: IdempotentResponse
}): Promise<void> {
  const retainable = input.response.body.length <= IDEMPOTENT_RESPONSE_MAX_BYTES

  await prisma.idempotencyRecord.updateMany({
    where: { tenantId: input.tenantId, endpoint: input.endpoint, key: input.key },
    data: {
      status: "COMPLETED",
      responseStatus: input.response.status,
      responseBody: retainable ? input.response.body : null,
    },
  })
}

/**
 * Give a key back after a failed attempt.
 *
 * Only ever called for a claim this request made and then could not honour, so
 * it deletes rather than expires: the request produced nothing, and a client
 * retrying with the same key should get a clean attempt rather than a 409 about
 * a request that never happened.
 */
export async function releaseIdempotencyKey(input: {
  tenantId: string
  endpoint: string
  key: string
}): Promise<void> {
  await prisma.idempotencyRecord.deleteMany({
    where: {
      tenantId: input.tenantId,
      endpoint: input.endpoint,
      key: input.key,
      status: "IN_FLIGHT",
    },
  })
}

/**
 * Delete records past their retention window, across the install.
 *
 * Cross-tenant by construction — a sweep that had to be told which workspace to
 * clean would never run for the ones nobody remembered — so it takes an
 * explicit reason at the call site, the discipline `MeteringScope` imposes on
 * the cost aggregates for the same reason.
 */
export async function sweepIdempotencyRecords(options: {
  now?: Date
  scope: { kind: "every-tenant"; reason: string }
}): Promise<number> {
  const result = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lte: options.now ?? new Date() } },
  })
  return result.count
}

/** Prisma's known-request errors arrive as `unknown`; parsed, never asserted. */
const prismaErrorCodeSchema = z.object({ code: z.string() })

function isUniqueViolation(error: unknown): boolean {
  const parsed = prismaErrorCodeSchema.safeParse(error)
  return parsed.success && parsed.data.code === "P2002"
}
