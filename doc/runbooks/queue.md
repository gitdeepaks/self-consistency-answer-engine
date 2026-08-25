# Runbook — queue, workers and the progress bus

Everything here assumes `RUN_TRANSPORT=redis`. Under `local` there is no queue: the API executes runs
itself, and the only lever is restarting it.

Operator commands live in the worker package and talk to the same Redis the fleet uses:

```
bun run dlq depth                          # queue depths, both queues
bun run dlq list --limit 20                # failed jobs, newest first
bun run dlq replay <queue> <jobId>         # put one back
bun run dlq replay-all --limit 100         # put them all back
bun run dlq purge --older-than 2026-08-01  # discard permanently
bun run dlq reap                           # fail runs past their deadline, now
```

---

## Symptom: runs sit at `QUEUED` and never start

The API accepted the work and the queue took it, but nothing is consuming.

1. `bun run dlq depth`. A large and growing `waiting` with `active` at zero means no worker is
   attached.
2. Check the worker fleet is up: `fly status --app self-consistency-answer-engine` (worker group), or
   `docker ps`. A worker logs its panel and its budgets at boot — if that banner is missing, it never
   started.
3. Look for a boot failure in the worker logs. The two that stop a worker dead are a Redis ping
   failure (`pingRedis` at startup) and an invalid configuration (`Invalid worker configuration:`
   followed by the offending field — this is deliberate, a misconfigured worker must not run).
4. Scale the workers back up: `fly scale count worker=3`.

Nothing is lost while this is happening. The jobs are durable; they start the moment a worker attaches.

---

## Symptom: runs sit at `PENDING`

Different failure, and the distinction is why the two statuses exist. `PENDING` means the row was
written but **the enqueue did not succeed** — the API could not reach Redis.

1. Check Redis is reachable from an API replica.
2. The API fails such runs explicitly and emits `run.failed`, so a `PENDING` run that is *not* failed
   means the API died between the two. `bun run dlq reap` closes them out once their deadline passes,
   and the periodic reaper does it automatically every `REAPER_INTERVAL_MS`.

---

## Symptom: queue backlog is growing

`waiting` climbing while `active` is pinned at `QUEUE_CONCURRENCY × workers`.

1. **Add workers first** — `fly scale count worker=N`. It is the safe lever.
2. Raising `QUEUE_CONCURRENCY` raises the per-worker ceiling, but the bulkhead
   (`PROVIDER_MAX_CONCURRENCY`) still bounds calls per provider, so beyond a point extra concurrency
   only buys queueing inside the worker.
3. Check whether one provider is the bottleneck. A provider that has gone from 5s to 90s occupies its
   bulkhead permits for eighteen times as long. The circuit breaker opens only on *failures*, not on
   slowness, so a slow-but-working provider needs a human decision: drop it from the default panel, or
   lower `PER_MODEL_TIMEOUT_MS` so candidates fail fast with a partial answer instead of blocking.

---

## Symptom: the dead-letter queue is growing

A dead letter is **not** a model that failed. Those are recorded on the candidate row and the job
succeeds. A dead letter is an infrastructure failure: the database unreachable, an unparseable
payload, a bug in a processor.

1. `bun run dlq list` and read `failedReason`. They usually share one cause.
2. Fix the cause.
3. `bun run dlq replay-all`.

Replay is safe with respect to double-charging. A replayed job re-reads its candidate row, and a
candidate that already settled `OK` is left alone before any model call happens.

Do not `purge` until you have read the reasons. It throws away the only record of what broke.

---

## Symptom: SSE clients see nothing, but runs are completing

The progress bus, not the queue.

1. Confirm the run is progressing: `GET /api/runs/:id` shows candidates settling.
2. If the row advances but the stream is silent, the Redis Stream write is failing while the Postgres
   append succeeds. Look for `[bus] durable append failed` (the opposite case) and for Redis errors in
   the worker log.
3. A client reconnecting always recovers, because the backfill comes from Postgres. Reconnecting is
   the mitigation while the underlying Redis problem is fixed.

---

## Symptom: Redis is down

Both the API and the worker degrade rather than corrupt.

- The API cannot enqueue. New runs are marked `FAILED` with a readable reason instead of being
  accepted and lost.
- Workers cannot claim jobs. In-flight jobs already claimed continue; their durable writes to Postgres
  keep working, so **no completed work is lost**.
- Existing SSE streams stop tailing. Backfill still works, so a client that reconnects sees everything
  that has been persisted.

When Redis returns, workers reattach and the backlog drains. Jobs whose locks expired are redelivered,
and the processors' idempotency checks stop the redelivery from paying for anything twice.

---

## Symptom: a run must be stopped now

`POST /api/runs/:id/cancel`. The database flag is authoritative and the Redis pub/sub message is the
fast path — a candidate that is mid-stream aborts within a moment; a worker that misses the message
stops at its next checkpoint.

To stop *everything*, scale the workers to zero. In-flight model calls finish (their spend is already
committed); nothing new starts.

---

## Deploys

`fly deploy` rolls the API and worker groups. The worker's `SIGTERM` handler stops accepting jobs and
waits for the active ones, up to `SHUTDOWN_TIMEOUT_MS`, so a rolling deploy does not orphan runs.

A worker killed harder than that loses nothing either — its jobs are redelivered once their locks
expire — but the client watches nothing happen until then, which is why the drain is worth waiting for.

Verify with the drill:

```
bun run scale-test --apis 3 --workers 3 --runs 12
```

It starts real processes, runs the fan-out across them, `SIGKILL`s a worker mid-run and `SIGTERM`s an
API replica, and asserts every run still completes with its stream watched on a *different* replica
from the one that started it. It makes real model calls, so it needs provider credentials.
