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
process.env.REDIS_NAMESPACE = process.env.SCE_TEST_REDIS_NAMESPACE ?? "sce-test"

// Postgres is shared with development on purpose: the suites create their own
// tenants and clean up after themselves, and running against the same schema a
// developer is looking at is the point of using a real database at all.
