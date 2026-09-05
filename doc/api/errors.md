# Errors

Every refusal from `/v1`, without exception, is this:

```json
{
  "code": "quota_exceeded",
  "message": "You have used 50 of 50 runs this month on the Free plan.",
  "details": {
    "quota": { "limit": "monthlyRuns", "used": 50, "ceiling": 50, "resetAt": "2026-10-01T00:00:00.000Z", "upgradeTo": "pro" }
  },
  "requestId": "01J8Z…"
}
```

| Field | For |
| --- | --- |
| `code` | Your code. Stable, and the only part you should branch on |
| `message` | A person. User-safe, and free to change wording between releases |
| `details` | Your code, again — the specifics, typed per code. Absent when there are none |
| `requestId` | Us. Quote it in a support conversation; it is in our logs |

**Branch on `code`, not on the status.** An HTTP status cannot tell `quota_exceeded` from
`rate_limited`, and both are 429 — one means "wait for the month to reset or upgrade", the
other means "slow down and try again in thirty seconds".

## The codes

| `code` | Status | Means | `details` |
| --- | --- | --- | --- |
| `validation_failed` | 400 | The request did not match its schema | `fields[]` |
| `unauthorized` | 401 | No usable credential | — |
| `forbidden` | 403 | Valid credential, insufficient scope or role | — |
| `payment_required` | 402 | The subscription cannot fund new work | `billing` |
| `feature_unavailable` | 403 | The plan does not include this capability | `feature` |
| `not_found` | 404 | No such resource **in your workspace** | — |
| `conflict` | 409 | The request contradicts the resource's state | — |
| `quota_exceeded` | 429 | A plan ceiling was reached | `quota` |
| `rate_limited` | 429 | A per-window request budget was exhausted | `rateLimit` |
| `provider_unavailable` | 502 | An upstream model provider could not be reached | — |
| `budget_exhausted` | 503 | The install-wide spend guard is engaged | `killSwitch` |
| `not_configured` | 503 | The deployment is missing something it needs | — |
| `internal_error` | 500 | A bug. Send us the `requestId` | — |

`not_found` never distinguishes "does not exist" from "belongs to someone else". That is
deliberate: the alternative turns a list of guessed ids into a census of another workspace's
runs.

## Retrying

| Status | Retry? |
| --- | --- |
| 408, 429, 5xx | Yes, with backoff — and obey `Retry-After` when it is present |
| Other 4xx | No. It will fail identically |

Use **full jitter**: sleep a random duration up to your backoff ceiling, not the ceiling
itself. Plain exponential backoff synchronises every client that failed at the same moment, so
the retry storm arrives together and knocks the service over a second time.

`@sce/sdk` does all of this, including the `Retry-After` parsing for both the seconds form and
the HTTP-date form.

## Idempotency

Send `Idempotency-Key` on every POST. It is a client-generated unique string — a UUID is
ideal — and it makes a retry safe:

```http
POST /v1/runs
Idempotency-Key: 6f1a2b3c-…
```

| Situation | Response |
| --- | --- |
| First request | The real one |
| Retry, same key, same body | The **original response, byte for byte**, with `Idempotent-Replay: true` |
| Retry, same key, *different* body | `409 conflict` — a client bug, reported rather than hidden |
| Retry while the first is still running | `409 conflict` — retry in a moment |

Keys are remembered for 24 hours and are scoped to the operation, so the same key sent to two
different endpoints is two intentions rather than a replay of one.

Without a key, a `POST /v1/runs` that times out leaves you unable to tell whether it arrived.
Retrying fans out a second panel; not retrying loses the work. The header is how you avoid
choosing.

## Validation failures

```json
{
  "code": "validation_failed",
  "message": "The request did not match the expected shape",
  "details": {
    "fields": [
      { "path": "prompt", "message": "Prompt must be at least 3 characters" },
      { "path": "providers.1", "message": "Invalid option" }
    ]
  },
  "requestId": "01J8Z…"
}
```

Paths are dotted, so they read the way your JSON does and you can search your own payload for
them.
