# ADR-0008 — A separate `/v1` surface, a generated spec, and outbound webhooks

**Status:** accepted · **Date:** 2026-09-05 · **Phase:** 6

## Context

Phases 0–5 produced a working product with two clients — the web app and the TUI — both talking to
`/api` through `hc<AppType>()`. That contract is excellent for what it is: fully typed end to end,
single-sourced from the Zod schemas in `packages/shared`, and free to change because both clients
ship in the same deployment as the server.

Phase 6 turns the API into a product. That is a different kind of object: a third party writes
against it, deploys, and then is not in the room when we change it. Four decisions had to be made
before a single route could be published, and every one of them is expensive to revisit once
somebody's production traffic depends on it.

## Decisions

### 1. `/v1` is a separate, narrower surface — not `/api` with a prefix

The obvious move is to mount the existing router at `/v1` and call it done. Rejected, for two
reasons that pull in the same direction.

**The internal surface is wider than anything worth promising.** `/api` carries the operations
console, membership management, billing internals, the feedback triage queue and the anonymous
share reader. Publishing them means promising them for twelve months each. The public surface is
runs, shares, usage and webhooks — the things an integration actually needs — and leaving the rest
out is not an omission but the decision.

**One prefix cannot have two change policies.** `/api` has to stay free to change with the clients
that ship alongside it; `/v1` has to be frozen. A single router serving both would make every
first-party refactor a question about strangers' code, which is exactly the tax that makes teams
stop refactoring.

The cost is a thin duplicate route layer. It is genuinely thin: every `/v1` handler delegates to the
same `startRun`, `cancelRun` and repository functions `/api` calls, and adds only the contract —
pagination, conditional reads, idempotency, the error envelope. `v1.contract.test.ts` walks the
route table to keep it that way.

### 2. The OpenAPI document is generated from the Zod schemas, and committed

`@hono/zod-openapi` produces the specification from the same schemas the server validates with, so
there is no second source of truth to drift. Zod 4's `.meta({ id })` is what turns a shared schema
into a named `$ref` component without polluting `packages/shared` with OpenAPI concerns — `.meta()`
returns a clone, so the first-party surface is untouched.

The generated file is **committed** to `doc/api/openapi.json`, which is a combination people are
rightly suspicious of. It earns its place: a spec built only in CI can tell you today's shape but
not what you just changed. Committing it puts an API change in the pull request diff, where a
reviewer sees it — and gives the compatibility gate something to compare against.

Two routes are documented by hand with `registerPath` rather than through `openapi()`: the SSE
stream, whose handler returns an endless `text/event-stream` that no JSON response schema describes,
and the outbound webhooks, which are requests this server *makes* rather than routes it serves.
Documenting them honestly beats declaring a body shape the handler does not return.

### 3. Errors are thrown, not returned

Every `/v1` refusal goes through one renderer. Handlers call `notFound()`, `forbidden()`,
`conflict()` — which throw `AppError` subclasses — and a boundary middleware renders them into
`{ code, message, details, requestId }`.

This started as a workaround and turned out to be the better design. `@hono/zod-openapi` checks a
handler's return value against the responses its route declares, so a handler returning a bare
`Response` for its error paths does not type-check. Throwing means a handler's signature describes
only what it does when it *succeeds* — which is precisely the thing the specification publishes and
the thing worth type-checking. It also makes the envelope a guarantee rather than a convention:
there is one renderer, so it cannot drift.

The four new `AppError` subclasses (`NotFoundError`, `ForbiddenError`, `ConflictError`,
`RequestValidationError`) are shared with `/api`, which now gets machine-readable codes on refusals
that previously carried only a sentence.

### 4. Outbound webhooks are an outbox, delivered by the worker

Emitting an event is **one database write**. `dispatchWebhookEvent` inserts a `WebhookDispatch` row
per subscribed endpoint and returns; a queue job performs the HTTP request later.

The alternative — POSTing inline when a run completes — was rejected because it puts a customer's
unreachable server on the critical path of finishing a run, which is the coupling a webhook exists
to avoid. The other alternative — writing the row *and* enqueueing as one logical step — is a dual
write to Postgres and Redis, whose failure mode is an event that exists in exactly one of the two
places and is therefore either lost or duplicated.

So: the write is the commitment, the immediate enqueue is a latency optimisation that is allowed to
fail, and a sweeper picks up anything `PENDING` and due. Redis being unreachable at the instant a
run completes delays a webhook by a couple of seconds rather than losing it.

Three smaller decisions fall out of this one:

- **Standard Webhooks for the signature.** The same scheme Svix and therefore Clerk use, so a
  customer already receiving Clerk webhooks can verify ours with the library they have. `@sce/sdk`
  exports the same `verifyWebhookSignature` the server signs with, because a receiver that is
  subtly wrong about the raw-body rule fails only under a non-ASCII prompt.
- **The `(endpointId, eventId)` unique index does the deduplication**, so a synthesis job
  redelivered by the queue cannot send a customer a second copy. The same index gives
  `quota.exceeded` its once-an-hour throttle for free, by deriving the event id from the tenant, the
  limit and the hour — no rate-limiter state, nothing to reset, no drift between replicas.
- **Delivery failures do not dead-letter.** A processor that exhausts its attempts marks the row
  `FAILED` and returns normally. The delivery log is a better dead-letter queue for this: per
  endpoint, per event, replayable, and visible to the customer whose integration is broken.

### 5. The SDK vendors the shared contract instead of generating types

`@sce/shared` is private and cannot be a dependency of a published package. Rather than generating a
client from the OpenAPI document — a second source of truth with a build step between it and the
first — `packages/sdk/src/vendor/shared.ts` re-exports the schema modules through relative paths,
and the bundler inlines them.

A field added to `runSchema` is a field in a consumer's autocomplete in the same commit. Every
response is `.parse()`d with the schema the server validated it against, so the return types are a
guarantee rather than a claim, and "this deployment is newer than your SDK" is a clear error rather
than a property that is quietly `undefined`.

The modules are listed individually rather than pulled from the package barrel: the barrel also
exports the `.env` reader and the API-key hasher, and one `node:fs` import poisons the browser build
for every pure export beside it.

## Consequences

**Good.** The contract is enforced by CI rather than by review discipline — `bun run api:check`
fails on a stale spec and on any direction-aware breaking change. Nobody hand-writes the
specification, the SDK types, or a second copy of the domain schemas. A customer can find out why
their webhook is not arriving without opening a support ticket. Idempotency and cursor pagination
are uniform across every POST and every collection rather than present on the routes somebody
remembered.

**Bad.** There are now two route tables over the same data, and a feature that should exist on both
has to be added twice. The compatibility gate will produce a false positive eventually — it treats a
schema referenced from both a request and a response conservatively — and the escape hatch is an
environment variable somebody could reach for too readily. Three new tables grow with traffic and
need their retention sweeps to actually run.

**Deferred.** No `/v2` machinery beyond the `deprecated()` middleware and the policy document,
because building version negotiation before there is a second version is speculative. The public
surface has no feedback, membership or admin routes; if integrators ask for them, they get added
additively.
