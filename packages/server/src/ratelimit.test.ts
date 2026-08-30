import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MemoryRateLimiter, setRateLimiter } from "@sce/queue"
import { apiErrorSchema, RATE_LIMIT_HEADERS, type Actor } from "@sce/shared"
import { Hono } from "hono"
import type { AuthEnv } from "./auth/middleware.ts"
import { isAppError } from "./errors.ts"
import { rateLimit } from "./ratelimit.ts"

/**
 * The rate-limit middleware.
 *
 * Mounted on a purpose-built app rather than the real one, because what is
 * under test is the middleware's contract — which budget a request is charged
 * to, what the headers say, and what a refusal looks like — and running it
 * behind the real routes would drag a database, a queue and an authentication
 * round trip into a test about counting.
 *
 * `enabled: true` is passed explicitly: the suite runs with `RATE_LIMIT_ENABLED
 * =false` (see `test-setup.ts`), because a sliding window keyed on a credential
 * outlives the suite that spent it.
 */

function actor(credentialId: string): Actor {
  return {
    credential: "api-key",
    tenantId: "tenant-rl",
    userId: null,
    role: "owner",
    scopes: [],
    credentialId,
  }
}

/** An app with one limited route, and the same error mapping the real one has. */
function appFor(budget: { bucket: string; limit: number; ipLimit?: number }, id: string) {
  const app = new Hono<AuthEnv>()
  app.use("*", async (c, next) => {
    c.set("actor", actor(id))
    await next()
  })
  app.get("/limited", rateLimit({ ...budget, enabled: true }), (c) => c.text("ok"))
  app.onError((error, c) =>
    isAppError(error) ? c.json(error.body(), error.status, error.headers()) : c.text("boom", 500),
  )
  return app
}

/** Distinct per test, so one test's spent window cannot fail the next. */
function bucketFor(label: string): string {
  return `test.${label}.${Math.random().toString(36).slice(2)}`
}

beforeAll(() => {
  // In-process, so the window is exactly what this test put in it.
  setRateLimiter(new MemoryRateLimiter())
})

afterAll(() => {
  setRateLimiter(null)
})

describe("rateLimit", () => {
  test("admits requests up to the budget", async () => {
    const app = appFor({ bucket: bucketFor("admits"), limit: 2 }, "cred-1")

    expect((await app.request("/limited")).status).toBe(200)
    expect((await app.request("/limited")).status).toBe(200)
  })

  test("describes the budget on a successful response", async () => {
    // A client that can see it has one request left can pace itself. One that
    // only learns about the limit by being refused cannot.
    const app = appFor({ bucket: bucketFor("headers"), limit: 3 }, "cred-2")
    const response = await app.request("/limited")

    expect(response.headers.get(RATE_LIMIT_HEADERS.limit)).toBe("3")
    expect(response.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("2")
    expect(Number(response.headers.get(RATE_LIMIT_HEADERS.reset))).toBeGreaterThan(0)
  })

  test("refuses with a typed 429 once the budget is spent", async () => {
    const bucket = bucketFor("refuses")
    const app = appFor({ bucket, limit: 1 }, "cred-3")

    await app.request("/limited")
    const response = await app.request("/limited")

    expect(response.status).toBe(429)
    const body = apiErrorSchema.parse(await response.json())
    expect(body.code).toBe("rate_limited")
    expect(body.rateLimit?.bucket).toBe(bucket)
    expect(body.rateLimit?.remaining).toBe(0)

    // A 429 without this leaves a client with nothing to do but guess.
    expect(Number(response.headers.get(RATE_LIMIT_HEADERS.retryAfter))).toBeGreaterThan(0)
  })

  test("the last admitted request is not itself refused", async () => {
    // `remaining` hits zero on the request that *used* the last slot as well as
    // on the one refused after it. Reading the count instead of the limiter's
    // verdict would give every caller one fewer request than their budget says.
    const app = appFor({ bucket: bucketFor("boundary"), limit: 1 }, "cred-4")
    const response = await app.request("/limited")

    expect(response.status).toBe(200)
    expect(response.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0")
  })

  test("budgets are per credential", async () => {
    const bucket = bucketFor("per-credential")
    const mine = appFor({ bucket, limit: 1 }, "cred-5")
    const yours = appFor({ bucket, limit: 1 }, "cred-6")

    await mine.request("/limited")
    expect((await mine.request("/limited")).status).toBe(429)
    // Somebody else exhausting their budget must not spend mine.
    expect((await yours.request("/limited")).status).toBe(200)
  })

  test("an IP budget refuses even when the credential has room", async () => {
    // The shape a credential-only limiter cannot see: one address minting fresh
    // credentials in a loop.
    const bucket = bucketFor("ip")
    const first = appFor({ bucket, limit: 100, ipLimit: 1 }, "cred-7")
    const second = appFor({ bucket, limit: 100, ipLimit: 1 }, "cred-8")
    const from = { "x-forwarded-for": "203.0.113.7" }

    expect((await first.request("/limited", { headers: from })).status).toBe(200)

    const response = await second.request("/limited", { headers: from })
    expect(response.status).toBe(429)
    expect(apiErrorSchema.parse(await response.json()).rateLimit?.bucket).toBe(`${bucket}.ip`)
  })

  test("the headers describe the tightest of the budgets in play", async () => {
    const app = appFor({ bucket: bucketFor("tightest"), limit: 100, ipLimit: 5 }, "cred-9")
    const response = await app.request("/limited", { headers: { "x-forwarded-for": "198.51.100.4" } })

    // Reporting the roomier limit would tell a caller it has ninety-nine
    // requests left when the next one will be refused.
    expect(response.headers.get(RATE_LIMIT_HEADERS.limit)).toBe("5")
    expect(response.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("4")
  })

  test("is a no-op when the budget is disabled", async () => {
    const app = new Hono<AuthEnv>()
    app.use("*", async (c, next) => {
      c.set("actor", actor("cred-10"))
      await next()
    })
    app.get(
      "/limited",
      rateLimit({ bucket: bucketFor("disabled"), limit: 1, enabled: false }),
      (c) => c.text("ok"),
    )

    expect((await app.request("/limited")).status).toBe(200)
    expect((await app.request("/limited")).status).toBe(200)
  })
})
