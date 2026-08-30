# Runbook — spend, quotas and the kill switch

Everything that spends money has three independent brakes, and knowing which one is on is the whole
of triage:

| Brake | Scope | Set by | Refusal |
| ----- | ----- | ------ | ------- |
| **Per-run ceiling** | one run | the API, at creation, from the plan's remaining monthly budget | candidates settle `SKIPPED`, run `FAILED` |
| **Plan quota** | one tenant, one calendar month | `PLANS` in `@sce/shared` | `429 quota_exceeded` |
| **Global daily cap** | the whole install, one UTC day | `GLOBAL_DAILY_BUDGET_MICRO_CENTS` | `503 budget_exhausted` |

Operator commands live in the worker package and talk to the same database the fleet uses:

```
bun run ops spend                       # today's spend, the switch, the biggest spenders
bun run ops spend --days 7 --limit 50   # a wider window
bun run ops rollup                      # recompute today's and yesterday's usage rollups
bun run ops halt --reason "..."         # stop the install from starting new runs
bun run ops resume                      # release the kill switch
```

`bun run dlq …` is the same program; both names run `packages/worker/src/cli.ts`.

---

## Symptom: every `POST /api/runs` answers `503 budget_exhausted`

The global daily cap has been reached and the kill switch is engaged. This is the system working:
new runs are refused, and runs already in flight stop at their next checkpoint rather than spending
the rest of the day's budget while you read this.

The API logged the trip as:

```
[budget] global daily cap reached — engaging kill switch { capMicroCents, spentMicroCents, since }
```

1. **See the numbers.**

   ```
   bun run ops spend
   ```

   It prints today's total against the cap, when the switch was engaged and why, and spend by tenant,
   biggest first.

2. **Decide which of the three shapes this is.**

   - *One tenant dominates.* Their plan quota should have stopped them — check whether they are on
     the plan you think (`GET /api/usage` as that tenant, or the `Subscription` row). A tenant on
     `enterprise` has no monthly ceiling by design.
   - *Spend is spread evenly and the day is young.* The cap may simply be too low for current
     traffic. Raise `GLOBAL_DAILY_BUDGET_MICRO_CENTS` deliberately — it is micro-cents, so $500/day
     is `50000000000`.
   - *Neither.* Suspect a loop: one prompt fanned out repeatedly, a client retrying without an
     `Idempotency-Key`, or a leaked key. `bun run ops spend --limit 50` and the `AuditEvent` table
     (`action = 'QUOTA_EXCEEDED'`) will show who.

3. **Stop the source before releasing the switch.** Revoke the key
   (`DELETE /api/keys/:id`), fix the client, or move the tenant's plan. Releasing first just
   reproduces the incident.

4. **Release it.**

   ```
   bun run ops resume
   ```

   The API picks this up within `GLOBAL_BUDGET_REFRESH_MS` (default 15s) and workers within
   `KILL_SWITCH_REFRESH_MS` (default 10s). Nothing releases the switch automatically, and nothing
   should: whatever spent the money is still there until somebody has looked.

> The cap is a *latch*, not a limit that lifts at midnight. If the day rolls over while it is
> engaged, it stays engaged.

---

## Symptom: a customer says they are blocked and should not be

Ask for the response body, not the status code — the status alone cannot distinguish four different
refusals.

| `code` | What it means | Where to look |
| ------ | ------------- | ------------- |
| `quota_exceeded` | A plan ceiling. The body names which one, what they have used and when it resets. | their `Subscription` row and `PLANS` |
| `rate_limited` | A per-minute budget, not a monthly one. `rateLimit.bucket` says which route. | `RATE_LIMIT_*` |
| `payment_required` | The subscription cannot fund new work — grace period expired, or cancelled. | `Subscription.status`, `graceEndsAt` |
| `feature_unavailable` | Their plan does not include the capability (`body.feature`). | `PLANS[plan].features` |
| `budget_exhausted` | Not about them at all — the install-wide switch. | the section above |

For a quota question, `GET /api/usage` as that tenant is the authoritative answer: it is produced by
the same function that refused them.

To change a plan out of band (a support gesture, an enterprise agreement not yet in Clerk):

```sql
INSERT INTO "Subscription" ("id", "tenantId", "plan", "status", "updatedAt")
VALUES (gen_random_uuid()::text, '<tenant-id>', 'team', 'ACTIVE', now())
ON CONFLICT ("tenantId") DO UPDATE SET "plan" = 'team', "status" = 'ACTIVE', "updatedAt" = now();
```

The next request picks it up — there is no cache in front of it. Note this will be overwritten by the
next billing webhook for that workspace, so record why it was done.

---

## Symptom: a workspace went read-only after a failed payment

Working as intended. `PAST_DUE` opens a grace window of `BILLING_GRACE_PERIOD_DAYS`; after it,
writes stop and reads do not. Nothing is deleted or hidden.

- Confirm: `GET /api/billing` as that tenant shows `access.mode = "read-only"` and the reason.
- The fix is a successful payment — Clerk sends `paymentAttempt.updated` with `status: "paid"`, and
  the handler clears the grace window and restores `ACTIVE`.
- To extend grace manually, set `graceEndsAt` forward on the `Subscription` row. To restore access
  entirely, set `status = 'ACTIVE'` and `graceEndsAt = NULL`.

---

## Symptom: the cost dashboard disagrees with the invoice

Three causes, in order of likelihood:

1. **Rollups are stale.** They are recomputed every `USAGE_ROLLUP_INTERVAL_MS` (default 5 minutes) by
   the worker; `GET /api/usage/daily` reports `rolledUpAt` so you can see how old the figures are.
   Force one: `bun run ops rollup`. Enforcement never reads these, so staleness is a reporting
   problem only.
2. **A model has no price.** `GET /api/usage` returns `hasUnpricedCalls: true` when at least one call
   this month was metered at zero because no `ModelPrice` row matched. Find it:

   ```sql
   SELECT DISTINCT model FROM "UsageRecord" WHERE "priceId" IS NULL AND "createdAt" > now() - interval '7 days';
   ```

   Add the price with a new `ModelPrice` row (prices are versioned by `effectiveFrom` and never
   edited), then re-run the rollup. Historical `UsageRecord` costs are *not* rewritten — they are the
   record of what was charged at the time.
3. **Prices are placeholders.** `hasUnverifiedPricing: true` means a price marked `verified = false`
   was used. Those are seeded guesses; check them against the vendor's published rates before
   billing anyone from them.

---

## Symptom: workers keep skipping candidates with "Spending is paused"

The kill switch is engaged and the workers can see it. See the first section — this is the in-flight
half of the same event. Runs fail with the switch's reason rather than half-completing.

If the switch is *not* engaged and workers still say this, they are reading a stale cache: it lasts
`KILL_SWITCH_REFRESH_MS`. Wait one window before investigating anything else.

---

## Related

- `doc/adr/0006-plans-quotas-and-billing.md` — why each brake exists and why the cap latches.
- `doc/runbooks/queue.md` — for runs that are stuck rather than refused.
