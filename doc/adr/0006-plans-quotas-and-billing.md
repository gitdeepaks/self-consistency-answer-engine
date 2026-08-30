# ADR-0006 — Plans as data, quotas before the spend, and one global kill switch

**Status:** accepted · **Date:** 2026-08-30 · **Phase:** 4

## Context

Every run costs real money at a provider. Before this phase the only thing standing between an
authenticated caller and an unbounded invoice was the per-run ceiling stamped on the row by the API
(`RUN_MAX_TOTAL_TOKENS`, `RUN_MAX_COST_MICRO_CENTS`). That bounds *one* run. It says nothing about a
tenant starting ten thousand of them, and nothing at all about the total the install may spend in a
day.

Phase 1 already gave us the raw material: a `UsageRecord` per model call, priced from a versioned
`ModelPrice` registry, written by the worker. What was missing was everything that reads it.

## Decisions

### 1. A plan is a record, not a branch

`packages/shared/src/plans.ts` holds a `PLANS` table — limits and features per plan — checked with
`satisfies` so the literal keeps its narrow type. Nothing anywhere asks "is this tenant on Pro?"; it
asks for a limit or for a named entitlement.

The consequence that matters: a pricing change is an edit to one file, and the same record drives
the API's enforcement *and* the client's affordances, so the two cannot drift. `GET /api/usage`
serves the tenant's position against each limit, computed by the same `quotaStatuses()` that will
refuse their next request.

### 2. Quotas are checked before the spend, never reported after it

`assertRunAllowed` runs in `POST /api/runs` before the run row is written or a job enqueued. It
checks three independent things, cheapest and most catastrophic first: the install-wide kill switch,
then whether the subscription can fund new work, then the plan's ceilings for the calendar month.

Enforcement reads `UsageRecord` directly rather than the daily rollups. A quota decided from a
rollup computed five minutes ago can be walked straight through by starting runs faster than the
sweep — so the rollups serve dashboards only, and can be stale, wrong or switched off without ever
letting spend past a limit.

A refusal is a typed `AppError` carrying the limit, the usage, the ceiling, the reset time and the
plan that would raise it. A `429` whose body says only "429" leaves a client with nothing to do but
retry blindly.

### 3. The monthly ceiling is carried *into* a run

Passing the quota check is not enough on its own: one run could still spend the rest of the month's
allowance. So the API narrows the per-run ceilings it stamps on the row to what is actually left of
the plan's monthly budget. The worker's existing per-call budget check then enforces the monthly
limit from the inside, with no new mechanism.

### 4. Rate limits are operational and separate from quotas

Quotas are commercial and monthly; rate limits are per-minute and per route. Neither substitutes for
the other — a tenant well inside its plan can still take the API down with a loop.

The limiter is a **sliding window** (a sorted-set log in Redis, evaluated in one Lua script so two
replicas cannot both take the last slot). A fixed window would let a caller spend a full budget at
the end of one window and another at the start of the next, which for `POST /runs` is twice the
model spend in two seconds.

Budgets are per route and per credential, with an additional per-IP budget on run creation — the
shape a credential-only limiter cannot see is one address minting fresh credentials in a loop.

**Rate limits are deliberately not plan-derived.** Making them so would put a subscription lookup on
the hot path of every cheap read to solve a problem the monthly quota already covers.

### 5. Billing rides on the identity webhook, and Clerk is not asked at request time

Clerk Billing events arrive on the existing `/api/webhooks/clerk` endpoint: same Svix signature, same
`WebhookDelivery` claim, same at-least-once semantics. `packages/server/src/subscriptions.ts` applies
them to a local `Subscription` row.

Clerk is the authority on *what was paid*; this database is the authority on *what that entitles a
tenant to do*. Keeping the second locally is what makes a quota check one indexed read instead of a
network call to a third party in the path of every run.

Three rules make the handler safe against a provider that retries and reorders:

- **Partial updates.** Every field is optional, so a payment event writes dunning and nothing else.
- **Ambiguity is dropped, not guessed.** An event that cannot be attributed to exactly one workspace
  is acknowledged and logged. Attaching somebody's subscription to the wrong workspace is worse than
  missing it.
- **Unknown statuses change nothing.** `incomplete` is a checkout in progress; turning somebody
  halfway through paying us into a restricted workspace is exactly the wrong response.

### 6. Failing to pay stops writes and never touches reads

`PAST_DUE` opens a grace window (`BILLING_GRACE_PERIOD_DAYS`, default 7). Inside it, nothing changes.
After it — and for `CANCELED` and `PAUSED` — the workspace is **read-only**: every GET still works,
and anything that would start new spend answers `402` with the reason and the grace deadline.

There is no mode that hides data. Locking a customer out of work they have already paid for, over a
card that expired yesterday, is a support incident rather than a control.

### 7. One global daily budget cap, and it latches

Per-tenant quotas cannot see the failure modes that actually produce a surprise invoice: a bug that
fans out a thousand runs, a leaked key used by fifty machines, a provider price change. So there is
an install-wide daily cap (`GLOBAL_DAILY_BUDGET_MICRO_CENTS`, default $250/day) above plans entirely.

Reaching it engages a **persisted** kill switch. Persisted because an incident only half the fleet
knows about is not contained; latched because automatically resuming spend after a runaway simply
reproduces the incident an hour later. Both the API (new runs) and the workers (runs already in
flight) observe it. Releasing it is an operator command — see `doc/runbooks/cost.md`.

Today's spend is cached for `GLOBAL_BUDGET_REFRESH_MS` (default 15s). The cost is bounded overshoot,
at most one window's worth of spend past the cap; the alternative is an aggregate over every metering
row written today, on every single `POST /runs`.

### 8. The install's own workspace is not a customer

`auth:bootstrap` and `db:seed` put the default workspace on the unmetered plan. A fresh install whose
first run is refused because the free plan allows fifty a month is a bad first five minutes, and
nobody is going to upgrade the bootstrap tenant. The global daily cap still applies to it — that is
the ceiling that protects the bill.

## Alternatives considered

**Stripe directly instead of Clerk Billing.** Clerk is already the identity provider, its billing
events arrive through webhook plumbing that already exists, and organizations already map to tenants.
Stripe remains reachable: everything downstream of `upsertSubscription` is provider-agnostic, and
switching means writing one more event translator.

**Incrementing rollups instead of recomputing them.** Cheaper per write, and wrong the first time a
job is retried. The rollup recomputes a day from its source rows, so a retried sweep, a late record
and a manual backfill all converge on the same numbers.

**A soft global budget that only alerts.** Considered and rejected: the point of the cap is to be the
thing that stops the bleeding when nobody is awake. An alert that pages an operator who then has to
find the right command is several minutes of spend at exactly the wrong rate.

## Consequences

- Every refusal in the system now has a machine-readable `code` and a typed body
  (`apiErrorSchema`), which is what the SDK in Phase 6 will parse.
- Free-plan workspaces cannot mint API keys or choose their panel. CLI users on the free plan
  authenticate interactively (`sce auth login`) instead.
- There is one number an operator must know during a spend incident: the daily cap. Everything else
  is downstream of it.
