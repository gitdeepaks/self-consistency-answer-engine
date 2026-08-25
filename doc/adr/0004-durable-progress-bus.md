# ADR-004 — Postgres for replay, Redis Streams for the live tail

**Status:** accepted · **Date:** 2026-08-25 · **Phase:** 2

## Context

Run progress was an in-memory append-only buffer per run, with a TTL and a cursor over it
(`packages/server/src/event-bus.ts`). The cursor design was right — replay from a position, then
follow, with no way to drop or duplicate an event. The storage was not:

- The buffer lived in the process that started the run, so **a second replica could not serve the SSE
  stream for a run it did not start**. With the orchestrator moving to a separate worker fleet, *no*
  API replica would have the buffer.
- A restart lost the timeline entirely.
- Events aged out after `EVENT_BUFFER_TTL_MS`, so a run from yesterday could not be replayed at all.

Phase 1 already added the `RunEvent` table — the storage the buffer was missing — but nothing read
from it yet.

## Decision

Keep the cursor design exactly as it was and give it two stores, each doing what it is good at.

- **Postgres `RunEvent`** is the archive: append-only, with a gap-free per-run `seq` allocated by
  incrementing a counter on the run row inside the same transaction as the insert. It answers "what
  happened before I connected", for any run, for as long as the run exists.
- **A Redis Stream per run** is the live tail: capped with `MAXLEN ~`, expired a while after the run
  ends. It is what lets a worker on one machine push an event to a client connected to an API replica
  on another.

### The join, which is the whole design

A subscriber:

1. records the stream's current tail id — **before** it reads Postgres;
2. backfills from Postgres for everything after its cursor;
3. follows the stream from the recorded id.

A publisher always writes **Postgres first, then the stream**.

Those two orderings together give the guarantee. An event can be seen twice but never missed: if it
reached the stream before the recorded id, it was already in Postgres before the backfill query ran,
so the backfill caught it. Duplicates are removed by `seq`. The subscriber sees each event exactly
once, in order, with no gap — from any replica, after any restart, at any point in the run.

Getting either ordering backwards reintroduces a silent gap, which is why both are stated in the code
next to the lines that depend on them and covered by tests that run against both transports.

### Ephemeral events

`candidate.delta` — token-level streaming — is published to the bus but **never written to the
durable log**. A run produces thousands of deltas; one row each would make the archive the
bottleneck. Deltas carry `seq: null`, are dropped by a subscriber still catching up, and are batched
in the worker (whichever of `CANDIDATE_DELTA_FLUSH_CHARS` or `CANDIDATE_DELTA_FLUSH_MS` comes first)
before they reach the bus at all.

Nothing is lost by this: `candidate.settled` follows with the complete text. A client that reconnects
mid-candidate loses animation, not content.

### The SSE contract

The SSE `id` **is** the durable sequence number, so `Last-Event-ID` — which `EventSource` resends by
itself — is a resume cursor rather than a counter. `?afterSeq=` does the same for clients that are not
`EventSource`. Both are parsed with Zod, because both are network input that ends up in a database
predicate. Ephemeral events are sent with no id, so a client that reconnects after one simply does not
ask for it back.

## Consequences

- Any API replica can serve any run's stream. This is the Phase 2 exit criterion, and it is tested
  two ways: `bus.test.ts` runs every assertion against both transports plus a cross-instance case,
  and `infra/scale-test.ts` starts real API and worker processes, starts a run on one replica, watches
  it on another, and kills a worker in the middle.
- A durable append that fails is logged and downgraded to an ephemeral frame rather than thrown. The
  client keeps seeing the run unfold; what they lose is the ability to *replay* that one event. The
  gap is loud in the logs, which is where an operator can act on it.
- `event-bus.ts` is deleted. `LocalRunBus` keeps an in-process fan-out for `RUN_TRANSPORT=local`, but
  it is Postgres-backed too — so even the single-process path survives a restart, which the old buffer
  never did.
- Redis Stream memory is bounded by `RUN_STREAM_MAX_LEN` × live runs, and each stream carries a TTL.
  A run whose stream has been trimmed past a client's cursor still replays correctly: the backfill
  comes from Postgres, which has everything.
