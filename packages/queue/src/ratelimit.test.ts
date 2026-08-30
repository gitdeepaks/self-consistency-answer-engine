import { afterAll, describe, expect, test } from "bun:test"
import { closeRedis } from "./connection.ts"
import { rateLimitKey } from "./names.ts"
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit.ts"

/**
 * The limiter's behaviour, proved against both implementations.
 *
 * The same suite runs twice — once in memory, once against Redis — because the
 * in-process limiter is not a mock: it is the code that actually runs under
 * `RUN_TRANSPORT=local`. Two implementations of one contract that are only ever
 * tested separately drift, and the one that drifts is always the one nobody
 * looks at.
 *
 * The property that matters most is the *sliding* window: a fixed window lets a
 * caller spend a full budget at the end of one window and another at the start
 * of the next, which for `POST /runs` is twice the model spend in two seconds.
 */

const WINDOW_MS = 60_000

/** A key nobody else is using, so re-runs cannot inherit a spent window. */
function freshKey(label: string): string {
  return rateLimitKey("test", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

afterAll(async () => {
  await closeRedis()
})

const implementations: [string, () => RateLimiter][] = [
  ["memory", () => new MemoryRateLimiter()],
  ["redis", () => new RedisRateLimiter()],
]

for (const [name, make] of implementations) {
  describe(`${name} limiter`, () => {
    test("admits requests up to the limit and refuses the next", async () => {
      const limiter = make()
      const key = freshKey("basic")
      const now = Date.now()

      const first = await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, now })
      expect(first.allowed).toBe(true)
      expect(first.remaining).toBe(2)

      await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, now })
      const third = await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, now })
      expect(third.allowed).toBe(true)
      expect(third.remaining).toBe(0)

      const fourth = await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, now })
      expect(fourth.allowed).toBe(false)
      expect(fourth.remaining).toBe(0)
    })

    test("a refused request does not extend its own window", async () => {
      // Otherwise a client hammering a limit would never be let back in: every
      // rejection would push the reset forward by another full window.
      const limiter = make()
      const key = freshKey("no-extend")
      const start = Date.now()

      await limiter.consume({ key, limit: 1, windowMs: WINDOW_MS, now: start })
      const refused = await limiter.consume({ key, limit: 1, windowMs: WINDOW_MS, now: start + 100 })

      expect(refused.allowed).toBe(false)
      expect(refused.resetAtMs).toBe(start + WINDOW_MS)
    })

    test("the window slides: an old hit ages out on its own", async () => {
      const limiter = make()
      const key = freshKey("slide")
      const start = Date.now()

      expect((await limiter.consume({ key, limit: 1, windowMs: 1_000, now: start })).allowed).toBe(
        true,
      )
      expect(
        (await limiter.consume({ key, limit: 1, windowMs: 1_000, now: start + 500 })).allowed,
      ).toBe(false)
      // One millisecond past the window, the first hit no longer counts.
      expect(
        (await limiter.consume({ key, limit: 1, windowMs: 1_000, now: start + 1_001 })).allowed,
      ).toBe(true)
    })

    test("two hits in the same millisecond are two hits", async () => {
      // A naive sorted-set member of just the timestamp would collapse these
      // into one entry, and a burst issued inside one millisecond would consume
      // a single slot no matter how large it was.
      const limiter = make()
      const key = freshKey("collision")
      const now = Date.now()

      await limiter.consume({ key, limit: 2, windowMs: WINDOW_MS, now })
      await limiter.consume({ key, limit: 2, windowMs: WINDOW_MS, now })
      const third = await limiter.consume({ key, limit: 2, windowMs: WINDOW_MS, now })

      expect(third.allowed).toBe(false)
    })

    test("a multi-slot request is all-or-nothing", async () => {
      const limiter = make()
      const key = freshKey("cost")
      const now = Date.now()

      const tooBig = await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, cost: 4, now })
      expect(tooBig.allowed).toBe(false)
      // Nothing was consumed, so the whole budget is still there.
      expect(tooBig.remaining).toBe(3)

      const fits = await limiter.consume({ key, limit: 3, windowMs: WINDOW_MS, cost: 3, now })
      expect(fits.allowed).toBe(true)
      expect(fits.remaining).toBe(0)
    })

    test("keys are independent", async () => {
      const limiter = make()
      const now = Date.now()
      const mine = freshKey("mine")
      const yours = freshKey("yours")

      await limiter.consume({ key: mine, limit: 1, windowMs: WINDOW_MS, now })
      const theirs = await limiter.consume({ key: yours, limit: 1, windowMs: WINDOW_MS, now })

      expect(theirs.allowed).toBe(true)
    })

    test("reset clears a spent budget", async () => {
      const limiter = make()
      const key = freshKey("reset")
      const now = Date.now()

      await limiter.consume({ key, limit: 1, windowMs: WINDOW_MS, now })
      await limiter.reset(key)

      expect((await limiter.consume({ key, limit: 1, windowMs: WINDOW_MS, now })).allowed).toBe(true)
    })
  })
}
