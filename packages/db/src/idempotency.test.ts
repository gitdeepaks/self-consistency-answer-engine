import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { IDEMPOTENCY_RETENTION_MS, fingerprintRequest } from "@sce/shared"
import { prisma } from "./client.ts"
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
  sweepIdempotencyRecords,
} from "./idempotency.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * Idempotent writes, against the real database.
 *
 * The guarantee this file exists to prove cannot be proved anywhere else: the
 * claim is an **insert against a unique index**, not a read followed by a
 * write. Two retries of the same request land on two API replicas in the same
 * millisecond; a check-then-act would find nothing, both would proceed, and the
 * caller would be billed twice for the run the mechanism exists to deduplicate.
 * Only Postgres can adjudicate that, so only Postgres can test it.
 *
 * Everything else here is the lifecycle around that: a retry replays, a
 * *different* body under the same key is a 409 rather than a silent replay of
 * somebody else's response, a crashed handler gives its key back, and an
 * expired record is reclaimed rather than honoured.
 */

const PREFIX = "test-idempotency"
const ENDPOINT = "POST /v1/runs"

let tenantId = ""
let otherTenantId = ""

beforeAll(async () => {
  await cleanup()
  tenantId = (await ensureTenant(`${PREFIX}-a`, "Idempotency A")).id
  otherTenantId = (await ensureTenant(`${PREFIX}-b`, "Idempotency B")).id
})

afterAll(cleanup)

async function cleanup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
}

/** The fingerprint the middleware would compute for a request. */
function print(body: string, path = "/v1/runs"): Promise<string> {
  return fingerprintRequest({ method: "POST", path, body })
}

let counter = 0
/** A key nobody else in this file is using. */
function nextKey(): string {
  counter += 1
  return `test-key-${counter}-${Date.now()}`
}

describe("claiming", () => {
  test("an unused key is fresh", async () => {
    const claim = await claimIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key: nextKey(),
      fingerprint: await print('{"prompt":"hello"}'),
    })
    expect(claim).toEqual({ kind: "fresh" })
  })

  test("a second claim while the first is in flight is told to wait", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"hello"}')

    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "fresh",
    })
    // 409, not a replay: there is no response to replay yet, and proceeding
    // would perform the write twice.
    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "in-flight",
    })
  })

  test("concurrent claims of one key produce exactly one winner", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"race"}')

    /*
     * The property the whole design rests on. These eight claims are issued
     * without awaiting in between, so they reach Postgres together — the shape
     * of two API replicas handling a client's retry at the same instant. The
     * unique index is the arbiter; the losers catch P2002 and re-read.
     */
    const claims = await Promise.all(
      Array.from({ length: 8 }, async () =>
        claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint }),
      ),
    )

    const fresh = claims.filter((claim) => claim.kind === "fresh")
    expect(fresh).toHaveLength(1)
    // Everyone else is told to wait, rather than being handed a half-written
    // record or an exception.
    expect(claims.filter((claim) => claim.kind === "in-flight")).toHaveLength(7)
  })

  test("the same key under a different body is a conflict, not a replay", async () => {
    const key = nextKey()

    await claimIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      fingerprint: await print('{"prompt":"the original"}'),
    })

    // A client whose retry logic is sending the wrong payload finds out here,
    // rather than a month later when somebody notices the responses never
    // matched the requests.
    expect(
      await claimIdempotencyKey({
        tenantId,
        endpoint: ENDPOINT,
        key,
        fingerprint: await print('{"prompt":"something else entirely"}'),
      }),
    ).toEqual({ kind: "mismatch" })
  })

  test("a key is scoped to its operation and to its workspace", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"scoped"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })

    // The same key against a different route is a different intention, not a
    // retry — so it is free.
    expect(
      await claimIdempotencyKey({
        tenantId,
        endpoint: "POST /v1/webhooks/endpoints",
        key,
        fingerprint,
      }),
    ).toEqual({ kind: "fresh" })

    // And another workspace's identical key cannot collide with, or observe,
    // this one.
    expect(
      await claimIdempotencyKey({ tenantId: otherTenantId, endpoint: ENDPOINT, key, fingerprint }),
    ).toEqual({ kind: "fresh" })
  })
})

describe("completing", () => {
  test("a settled key replays its response byte for byte", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"replay me"}')
    const body = JSON.stringify({ id: "run_1", status: "QUEUED" })

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await completeIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      response: { status: 201, body },
    })

    const claim = await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    expect(claim).toEqual({ kind: "replay", response: { status: 201, body } })
  })

  test("a response too large to retain settles the key anyway", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"enormous"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await completeIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      response: { status: 201, body: "x".repeat(300 * 1024) },
    })

    /*
     * `unrecoverable`, never `fresh`. The write happened, so re-running it would
     * perform it twice — which is the one outcome this whole mechanism exists to
     * prevent. An honest 409 saying "the original succeeded, go and fetch it"
     * is the only safe answer.
     */
    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "unrecoverable",
    })
  })

  test("a mismatched body is caught even after the first request settled", async () => {
    const key = nextKey()

    await claimIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      fingerprint: await print('{"prompt":"first"}'),
    })
    await completeIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      response: { status: 201, body: "{}" },
    })

    expect(
      await claimIdempotencyKey({
        tenantId,
        endpoint: ENDPOINT,
        key,
        fingerprint: await print('{"prompt":"second"}'),
      }),
    ).toEqual({ kind: "mismatch" })
  })
})

describe("releasing", () => {
  test("a crashed handler gives its key back", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"boom"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await releaseIdempotencyKey({ tenantId, endpoint: ENDPOINT, key })

    /*
     * The step that is easy to forget and expensive to omit: a claim left
     * `IN_FLIGHT` by a handler that threw would refuse every retry of that key
     * for twenty-four hours, turning one transient failure into a day-long
     * outage for that caller.
     */
    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "fresh",
    })
  })

  test("releasing does not discard a response that was already recorded", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"settled"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await completeIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      response: { status: 200, body: '{"ok":true}' },
    })
    // Only `IN_FLIGHT` rows are released, so a late or duplicated release
    // cannot un-settle a completed request.
    await releaseIdempotencyKey({ tenantId, endpoint: ENDPOINT, key })

    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "replay",
      response: { status: 200, body: '{"ok":true}' },
    })
  })
})

describe("expiry", () => {
  test("an expired record is reclaimed rather than honoured", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"stale"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await completeIdempotencyKey({
      tenantId,
      endpoint: ENDPOINT,
      key,
      response: { status: 201, body: "{}" },
    })
    await prisma.idempotencyRecord.updateMany({
      where: { tenantId, endpoint: ENDPOINT, key },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    // After the retention window the key means nothing, and reusing it is a new
    // request rather than a retry.
    expect(await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })).toEqual({
      kind: "fresh",
    })
  })

  test("only one of two racing reclaims wins", async () => {
    const key = nextKey()
    const fingerprint = await print('{"prompt":"reclaim race"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint })
    await prisma.idempotencyRecord.updateMany({
      where: { tenantId, endpoint: ENDPOINT, key },
      data: { status: "COMPLETED", expiresAt: new Date(Date.now() - 1_000) },
    })

    // The `expiresAt` predicate on the reclaiming update is a compare-and-swap:
    // the loser matches nothing and is told to wait, rather than proceeding
    // alongside the winner.
    const claims = await Promise.all(
      Array.from({ length: 4 }, async () =>
        claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key, fingerprint }),
      ),
    )
    expect(claims.filter((claim) => claim.kind === "fresh")).toHaveLength(1)
  })

  test("the sweep removes expired records and leaves live ones", async () => {
    const live = nextKey()
    const dead = nextKey()
    const fingerprint = await print('{"prompt":"sweep"}')

    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key: live, fingerprint })
    await claimIdempotencyKey({ tenantId, endpoint: ENDPOINT, key: dead, fingerprint })
    await prisma.idempotencyRecord.updateMany({
      where: { tenantId, endpoint: ENDPOINT, key: dead },
      data: { expiresAt: new Date(Date.now() - IDEMPOTENCY_RETENTION_MS) },
    })

    const removed = await sweepIdempotencyRecords({
      scope: { kind: "every-tenant", reason: "test" },
    })
    expect(removed).toBeGreaterThan(0)

    expect(
      await prisma.idempotencyRecord.count({ where: { tenantId, endpoint: ENDPOINT, key: dead } }),
    ).toBe(0)
    expect(
      await prisma.idempotencyRecord.count({ where: { tenantId, endpoint: ENDPOINT, key: live } }),
    ).toBe(1)
  })
})

describe("fingerprints", () => {
  test("are stable for the same request and differ for anything else", async () => {
    const body = '{"prompt":"why is the sky blue?"}'

    expect(await print(body)).toBe(await print(body))
    // Method and path are part of it, so one key sent to two operations cannot
    // become a replay of the wrong one.
    expect(await print(body)).not.toBe(await print(body, "/v1/webhooks/endpoints"))
    expect(await print(body)).not.toBe(await print('{"prompt":"a different question"}'))
  })
})
