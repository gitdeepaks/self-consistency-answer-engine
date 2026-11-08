/**
 * Test-suite preload.
 *
 * The queue and bus suites talk to the real Redis, and so does a developer's
 * `bun run dev` fleet on the same machine. Without a separate namespace they
 * share queues: a running worker happily claims the integration test's jobs,
 * and the test fails with no explanation that points at the cause.
 *
 * Set before any module reads it — `@sce/queue/env.ts` resolves the namespace
 * once, at import time, and every key name is derived from it.
 */
process.env.REDIS_NAMESPACE =
  process.env.SCE_TEST_REDIS_NAMESPACE ?? "sce-test";

// Postgres is shared with development on purpose: the suites create their own
// tenants and clean up after themselves, and running against the same schema a
// developer is looking at is the point of using a real database at all.

/**
 * A signing secret for the Clerk webhook suite.
 *
 * `env.ts` parses `process.env` once, at first import, and `bun test` shares a
 * process across files — so a secret set inside a test file arrives too late if
 * any other file imported `app.ts` first. Setting it here is the only place
 * that is reliably before every import.
 *
 * `??=` so a real secret in the environment still wins: someone running the
 * suite against a live Clerk instance should not have it silently replaced.
 */
process.env.CLERK_WEBHOOK_SIGNING_SECRET ??= `whsec_${Buffer.from(
  "phase-3-webhook-test-secret-32b!",
).toString("base64")}`;

/**
 * Rate limiting is off by default under `bun test`.
 *
 * The limiter is a *sliding window keyed on the credential*, and the suites
 * re-use one bootstrap key: running `bun test` twice inside a minute would
 * spend the same budget twice and fail the second run for a reason that has
 * nothing to do with the code under test. The limiter itself is covered
 * directly — `packages/queue/src/ratelimit.test.ts` for the algorithm, and
 * `packages/server/src/ratelimit.test.ts` for the middleware, which takes an
 * explicit `enabled` override for exactly this reason.
 *
 * `??=` so a suite (or a developer) can still turn it on deliberately.
 */
process.env.RATE_LIMIT_ENABLED ??= "false";

/**
 * The answer cache is off by default under `bun test`.
 *
 * The suite runs against a shared Postgres and asks the same questions every
 * time — "Summarise CAP theorem", "Cancel me" — and the cache's TTL is a day.
 * A second `bun test` within that window would serve those runs from the first
 * one, so a test's behaviour would depend on what ran yesterday. That is the
 * same argument as `RATE_LIMIT_ENABLED` above, and it has the same answer.
 *
 * What decides whether an answer may be reused is pure and is tested directly
 * in `packages/shared/src/answer-cache.test.ts` — normalisation, the canonical
 * key, the fingerprint, and every pair that must *not* match.
 *
 * `??=` so a suite (or a developer) can still turn it on deliberately.
 */
process.env.ANSWER_CACHE_ENABLED ??= "false";

/**
 * Placeholder provider keys under `bun test`.
 *
 * Starting a run seats each provider as PENDING only when its key is set; with
 * none, the run fails at once and never reaches the queue. A developer's `.env`
 * usually has real keys, so the HTTP suites pass locally and fail on a clean CI
 * runner. No suite calls a provider — the queue is stubbed, and the provider
 * tests pass their own env — so a placeholder is enough.
 *
 * `||=` so real keys in the environment still win, and an empty one is
 * treated as missing.
 */
process.env.OPENAI_API_KEY ||= "test-openai-key";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.GOOGLE_GENERATIVE_AI_API_KEY ||= "test-google-key";
