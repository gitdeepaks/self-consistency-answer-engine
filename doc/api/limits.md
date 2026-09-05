# Limits

Two independent mechanisms, refusing for different reasons and needing different responses.

| | Protects | Window | Refusal |
| --- | --- | --- | --- |
| **Rate limits** | The service, from a burst | Seconds to a minute | `429 rate_limited` |
| **Plan quotas** | Your invoice, from a runaway | A calendar month | `429 quota_exceeded` |

Waiting thirty seconds fixes the first and does nothing at all for the second. This is the
single best reason to branch on `code` rather than on the status.

## Rate limits

Per-route budgets, because the routes are not alike: starting a run buys model calls and
reading one reads a row. A single shared budget would either throttle reads pointlessly or let
writes through far too fast.

| Bucket | Applies to | Keyed by |
| --- | --- | --- |
| `runs.create` | `POST /v1/runs` | Credential, **and** client IP |
| `reads` | Everything else | Credential |

Run creation is additionally limited per IP, because a credential-only limiter cannot see one
address minting fresh credentials in a loop.

Every response carries the state — on success as well as on a refusal, which is the point:

```http
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1772928000
Retry-After: 27
```

Pace a batch job off `X-RateLimit-Remaining` while it is still positive. Reacting only to the
429 means every worker in your fleet discovers the limit simultaneously and then retries
simultaneously.

`@sce/sdk` surfaces the latest reading as `sce.rateLimit` and through an `onRateLimit` callback.

## Plan quotas

Checked **before** anything is persisted or enqueued, so an exhausted quota costs you a
rejected request rather than three model calls.

| Limit | Meaning |
| --- | --- |
| `monthlyRuns` | Runs started this calendar month |
| `monthlyTokens` | Tokens across every model call, candidates and evaluator |
| `monthlyCost` | Spend, in micro-cents |
| `concurrentRuns` | Runs in flight at once |

```json
{
  "code": "quota_exceeded",
  "message": "You have used 50 of 50 runs this month on the Free plan.",
  "details": {
    "quota": { "limit": "monthlyRuns", "used": 50, "ceiling": 50,
               "resetAt": "2026-10-01T00:00:00.000Z", "upgradeTo": "pro" }
  },
  "requestId": "01J8Z…"
}
```

**Do not discover your limits by hitting them.** `GET /v1/usage` returns the same figures from
the same calculation the pre-flight check uses, so the number you read and the number that
blocks you are one implementation rather than two:

```bash
curl -sS "$SCE_BASE_URL/v1/usage" -H "Authorization: Bearer $SCE_API_KEY" \
  | jq '.quotas[] | {limit, used, ceiling, resetAt}'
```

Subscribe to the `quota.exceeded` [webhook](./webhooks.md) to be told rather than to poll. It
fires at most once an hour per limit, so an exhausted quota does not become thousands of
deliveries.

## Two other refusals worth knowing

**`402 payment_required`** — the subscription is past its grace period. Reads keep working;
writes stop. Nothing is deleted.

**`503 budget_exhausted`** — the deployment's install-wide daily spend cap tripped and an
operator has to release it. Nothing about your request or your plan would change the answer,
which is why it is a 5xx rather than a 4xx. Retry with backoff.

## Per-run ceilings

Every run is stamped at creation with a token and cost ceiling, narrowed to what is left of
your monthly allowance. A run that reaches its ceiling stops and is marked failed with the
reason, which is what stops one enormous question from spending a whole month's budget.

Runs also carry a wall-clock deadline (`deadlineAt`). A run past it is reaped and failed rather
than left in flight for ever.

## Conditional reads

`GET /v1/runs/{runId}` returns an `ETag`. A finished run never changes, so send it back:

```http
GET /v1/runs/clx… HTTP/1.1
If-None-Match: W/"3Yq8k…"

HTTP/1.1 304 Not Modified
ETag: W/"3Yq8k…"
```

A 304 costs you the round trip and not the body. It still counts against the `reads` budget —
the work is in reaching the database, not in serialising — but it is dramatically cheaper for
both sides, and it is one header.

Better still, do not poll: use the [event stream](./streaming.md) or a
[webhook](./webhooks.md).

## Pagination

Every collection is cursor-paginated. There is no offset alternative, deliberately: offsets
over a table being written to skip and repeat rows as the set shifts under the reader, which
is exactly what a run history does while runs are being created.

```json
{ "data": [ … ], "nextCursor": "clx…", "hasMore": true }
```

Pass `nextCursor` back as `?cursor=`. It is opaque — never construct or parse one. Loop while
`hasMore`, and cap `limit` at 100.
