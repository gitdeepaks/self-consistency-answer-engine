# ADR-003 — BullMQ on Redis for the run queue

**Status:** accepted · **Date:** 2026-08-25 · **Phase:** 2

## Context

`startRun()` created a run row and then called `void executeRun(...)` — background work inside the
HTTP process. Every property that made this untenable follows from that one line:

- **A restart orphans every in-flight run.** The promise dies with the process. The row stays at
  `FANNING_OUT` for ever and the client watches nothing happen. A deploy did this several times a day.
- **It cannot scale past one instance.** Fan-out concurrency is bounded by the API process that
  happened to receive the request, and expensive model calls compete for the same event loop as cheap
  reads.
- **Nothing is retryable.** A failure anywhere in the pipeline lost the whole run, including the
  candidates that had already succeeded and already been paid for.
- **A duplicate request fans out twice.** There was no idempotency anywhere, and each fan-out is
  three model calls plus an evaluator pass — the most expensive kind of duplicate.

Phase 2 requires a durable queue. The plan named two candidates.

## Options

**A. Redis + BullMQ.** Mature, widely operated, and — decisively — it has **flows**: a parent job
that the queue holds until its children finish. A run is exactly that shape. Costs a Redis
dependency.

**B. A Postgres job table with `SELECT … FOR UPDATE SKIP LOCKED`.** One fewer service, and
transactionally consistent with the run row it refers to. But parent/child dependencies, exponential
backoff, delayed retries, a failed-job store and a dashboard would all be ours to build and operate.

## Decision

**BullMQ on Redis**, with the run modelled as a flow: one synthesis parent, one candidate child per
panel member.

Redis is not an added dependency in practice. The durable progress bus (ADR-004) needs Redis Streams
regardless, so option B would have meant running Redis *and* hand-writing a scheduler.

The details that carry weight:

- **Deterministic job ids** — `cand-<runId>-<candidateId>`, `synth-<runId>`. BullMQ makes an add with
  an existing id a no-op, so a retried enqueue cannot produce a second panel. (Job ids may not
  contain `:`; BullMQ reserves it for repeatable-job encoding. The integration test found this.)
- **`ignoreDependencyOnFailure` on children** — a candidate that gives up cannot strand the parent in
  `waiting-children` for ever. It is the queue-level statement of a rule the orchestrator always had:
  one panel member failing is a partial result, not a failed run.
- **The parent reads the database, not its children's return values.** A synthesis retried an hour
  after a crash sees the candidates that exist *now*, which is what makes it genuinely resumable.
- **Job payloads are identifiers, never snapshots.** `{ tenantId, runId, candidateId }` and nothing
  else. The prompt, the panel, the temperature, the deadline and the ceilings all live on the `Run`
  row, so a redelivered job reads current state rather than replaying a stale copy of the world.
- **Payloads are parsed with Zod on the way in.** A payload is written by one process, sits in Redis,
  and is read later by a possibly different build. That is a trust boundary like any other.

**Idempotency has two halves, and both are needed.** The queue's deterministic job id stops a
duplicate *enqueue*. `Run.idempotencyKey`, with a `@@unique([tenantId, idempotencyKey])` index, stops
a duplicate *request* — a retried `POST /api/runs` returns the run the first attempt created, with
`200` instead of `201`. The uniqueness is enforced by the database index rather than by a
read-then-write in application code, so two concurrent retries cannot both win.

**There is no separate dead-letter topic.** BullMQ's failed set already retains the payload, the
failure reason, the stack and the attempt history, and moving those jobs elsewhere would only break
the link back to the flow they belong to. `packages/queue/src/dlq.ts` and the `dlq` operator command
are what was actually missing: a way to read it and put things back.

What reaches the DLQ is narrow on purpose. A model returning an error is a normal outcome — the
candidate processor records it on the row and the job **succeeds**, so synthesis still runs with
whoever answered. Only infrastructure failures exhaust their attempts. That is what keeps the list
short enough to be worth reading.

## Consequences

- Redis is now a hard dependency of both the API and the worker. Both ping it at boot and refuse to
  come up without it, so a bad deploy fails its health check instead of failing a user's first request.
- `RUN_TRANSPORT=local` keeps the old in-process path reachable behind a flag — the migration escape
  hatch Phase 2's risk note asks for, the single-machine deployment shape, and the path the test suite
  takes. It runs the **same processors**, so it is a transport swap rather than a second
  implementation that can drift. It announces at boot that it cannot be scaled.
- The API image no longer needs the provider SDKs. `EMBED_WORKER=true` pulls them in through a
  dynamic import, and only then.
- Redis is a new operational surface: memory limits, persistence, failover. `doc/runbooks/queue.md`
  covers backlog, DLQ replay and a Redis outage.
