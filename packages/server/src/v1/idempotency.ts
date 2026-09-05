import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from "@sce/db"
import {
  assertNever,
  fingerprintRequest,
  idempotencyKeySchema,
  REQUEST_ID_HEADER,
} from "@sce/shared"
import type { MiddlewareHandler } from "hono"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requestIdOf } from "../request-id.ts"
import { conflict, invalid } from "./errors.ts"

/**
 * `Idempotency-Key`, for every POST rather than only for run creation.
 *
 * The header is optional and heavily recommended, which is the settled industry
 * position and the right one: making it mandatory breaks `curl`, and a client
 * that does not retry does not need it. What it buys the clients that do send
 * it is that a network timeout — the case where the request certainly arrived
 * and the response certainly did not — stops being a coin flip between "do
 * nothing and lose the work" and "retry and pay twice".
 *
 * `POST /v1/runs` keeps its own mechanism as well, the unique index on
 * `Run.idempotencyKey` from Phase 2. The two agree rather than compete: the run
 * row's index is what makes deduplication survive this record expiring, and
 * this middleware is what makes the *response* identical rather than merely
 * equivalent.
 *
 * Header name: `Idempotency-Key`, not `X-Idempotency-Key`. The `X-` convention
 * was deprecated by RFC 6648 in 2012 and every API that matters has moved.
 */

/** Set on a replayed response, so a client can see the retry did nothing. */
export const REPLAYED_HEADER = "Idempotent-Replay"

/**
 * Claim the key, run the handler, remember what it answered.
 *
 * The ordering is the whole design and every step of it is load-bearing:
 *
 *   1. **Claim before doing the work.** A check-then-act would let two retries
 *      landing on two replicas in the same millisecond both proceed. The claim
 *      is an insert against a unique index, so exactly one of them wins.
 *   2. **Release if the handler threw.** A claim left in flight by a crashed
 *      handler would refuse every retry of that key for twenty-four hours,
 *      turning one transient failure into a day-long outage for that caller.
 *   3. **Do not remember a 5xx.** Replaying "the server broke" forever is worse
 *      than re-running the request, which is the thing the caller wanted when
 *      they retried.
 */
export function idempotent(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const supplied = c.req.header("idempotency-key")
    if (supplied === undefined) {
      await next()
      return
    }

    const parsed = idempotencyKeySchema.safeParse(supplied)
    if (!parsed.success) invalid(parsed.error)
    const key = parsed.data

    const tenantId = actorOf(c).tenantId
    // The route *template*, so `POST /v1/runs/{runId}/cancel` scopes as one
    // operation. The concrete path goes into the fingerprint below instead,
    // which is what makes the same key against two different runs a mismatch
    // rather than a silent replay of the first.
    const endpoint = `${c.req.method} ${c.req.routePath}`

    // Reading the body caches it on the request, so the validator that runs
    // after this middleware still gets to parse it. That is a documented
    // property of Hono's request rather than a happy accident, and the tests
    // in `v1.idempotency.test.ts` hold it.
    const body = await c.req.text()
    const fingerprint = await fingerprintRequest({ method: c.req.method, path: c.req.path, body })

    const claim = await claimIdempotencyKey({ tenantId, endpoint, key, fingerprint })

    switch (claim.kind) {
      case "replay":
        return new Response(claim.response.body, {
          status: claim.response.status,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            [REPLAYED_HEADER]: "true",
            // The *current* request's id, not the original's: this response is
            // being produced now, and an operator tracing this call needs the
            // id that appears in this call's log lines.
            [REQUEST_ID_HEADER]: requestIdOf(c),
          },
        })

      case "in-flight":
        conflict("A request with this Idempotency-Key is still in progress. Retry in a moment.")
        break

      case "mismatch":
        conflict(
          "This Idempotency-Key was already used for a different request. " +
            "Generate a new key for a new request.",
        )
        break

      case "unrecoverable":
        conflict(
          "This Idempotency-Key was already used and its response is no longer available. " +
            "The original request succeeded; fetch the resource rather than retrying.",
        )
        break

      case "fresh":
        break

      default:
        return assertNever(claim, "idempotent")
    }

    try {
      await next()
    } catch (error) {
      // The boundary middleware above renders it; all this has to do is make
      // the key usable again first.
      await releaseIdempotencyKey({ tenantId, endpoint, key })
      throw error
    }

    const status = c.res.status

    // A server error is not an outcome worth remembering — the caller retried
    // precisely because they want it attempted again.
    if (status >= 500) {
      await releaseIdempotencyKey({ tenantId, endpoint, key })
      return
    }

    // Cloned, because the original body is on its way to the client and a
    // `ReadableStream` can only be consumed once.
    const recorded = await c.res
      .clone()
      .text()
      .catch(() => null)
    if (recorded === null) return

    await completeIdempotencyKey({
      tenantId,
      endpoint,
      key,
      response: { status, body: recorded },
    })
  }
}
