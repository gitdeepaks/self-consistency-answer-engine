# Webhooks

A run takes minutes. Holding an SSE connection open for all of it is fine for a browser and
awkward for a server, and polling a job API is how an integration becomes both slow and
expensive. Register a URL and be told instead.

## The events

| `type`           | Fired when                              | `data`                |
| ---------------- | --------------------------------------- | --------------------- |
| `run.completed`  | A run reached `COMPLETE`                | `{ run }` — a summary |
| `run.failed`     | A run reached `FAILED`                  | `{ run, error }`      |
| `quota.exceeded` | A request was refused by a plan ceiling | `{ quota, plan }`     |

Cancellation is deliberately not an event: a run stops because somebody asked it to, and
telling your server about your own action is noise you would only have to filter out.

`quota.exceeded` fires **at most once per hour per limit**. An exhausted monthly quota is hit
again by every subsequent request, and a delivery per refusal is what gets a sender's IP range
blocked by the receiver's infrastructure.

## Registering

```bash
curl -sS "$SCE_BASE_URL/v1/webhooks/endpoints" \
  -H "Authorization: Bearer $SCE_API_KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.example/hooks/sce", "eventTypes": ["run.completed", "run.failed"]}'
```

```json
{
  "endpoint": { "id": "clx…", "url": "https://…", "eventTypes": ["run.completed","run.failed"], … },
  "secret": "whsec_2xR9…"
}
```

**The secret appears once.** Store it before you do anything else with the response. Omitting
`eventTypes` subscribes to everything. `https` is required outside development.

Rotation is register-new, delete-old: run both for a window, move traffic, then delete. There
is no rotate-in-place, because there is no instant at which all of your instances have the new
secret.

## The delivery

```http
POST /hooks/sce HTTP/1.1
content-type: application/json
webhook-id: evt_9f2c…
webhook-timestamp: 1772928000
webhook-signature: v1,K5f3…

{"id":"evt_9f2c…","type":"run.completed","apiVersion":"v1","createdAt":"…","data":{"run":{…}}}
```

This is [Standard Webhooks](https://standardwebhooks.com) — the same scheme Svix and Clerk use,
so if you already receive Clerk webhooks you can verify ours with the library you have.

`run.completed` carries a run **summary**, not the answer. The final answer and every candidate
can run to hundreds of kilobytes, and a webhook that large is one your proxy will eventually
reject at a size limit nobody documented. Fetch `GET /v1/runs/{runId}` when you want the text.

## Verifying

The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, HMAC-SHA256, keyed with
the **base64-decoded bytes** of the secret's body (everything after `whsec_`), base64-encoded.

```ts
import { verifyWebhookSignature } from "@sce/sdk"

const payload = await request.text()          // raw bytes — see below
const result = await verifyWebhookSignature({
  secret: process.env.SCE_WEBHOOK_SECRET!,
  payload,
  headers: request.headers,
})

if (!result.ok) return new Response("invalid signature", { status: 400 })
// result.event is a fully typed, discriminated WebhookEvent
```

Four ways this is got wrong, each of which survives every test a single implementation writes:

**Parsing before verifying.** The signature covers the raw bytes. A handler that calls
`request.json()` and re-stringifies to verify fails on key order, on unicode escaping, and on
nothing else for months. Read the body as text, verify, *then* parse.

**Comparing with `===`.** String comparison short-circuits on the first differing byte, which
leaks the signature one character at a time. Use a constant-time compare.

**Ignoring the timestamp.** Without it, a captured delivery replays for ever. Reject anything
more than five minutes from your clock.

**Using the printable secret as the HMAC key.** It produces a stable signature that verifies
against itself — and against no other implementation in existence. Decode the base64 first.

`verifyWebhookSignature` does all four correctly and runs anywhere Web Crypto does. Use it.

## Responding

**Answer 2xx within ten seconds, then do the work.** Anything slower is treated as a failure
and retried, so processing inline turns one slow event into six copies of itself. Acknowledge,
enqueue, return.

**Deduplicate on `webhook-id`.** Delivery is at-least-once by design, and the id is stable
across every retry *and* across an operator's replay. A unique index on it is the whole
implementation.

**Answer 4xx for something durable.** A bad signature or an unparseable body will fail
identically on retry; a 400 stops us wasting both sides' time. Reserve 5xx for "try me again".

**Do not follow redirects, and do not expect us to.** A 30x to a different host would post your
prompts somewhere you never registered, so a redirect is treated as a failed delivery.

## Retries and failure

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| Attempts       | 6, exponential backoff, roughly 5 seconds to 5 minutes |
| Retried        | Timeouts, connection failures, 5xx, 408, 429           |
| Not retried    | Every other 4xx — the answer will not change           |
| Disabled after | 20 consecutive failed deliveries                       |

A disabled endpoint stops receiving and keeps its history. Re-enabling is explicit
(`POST /v1/webhooks/endpoints/{id}/enable`), not on a timer: something at the far end is
broken, and resuming automatically would only resume hammering it.

## The delivery log

The first place to look when an integration is not firing — and the reason that question does
not have to become a support ticket. It shows what we sent, when, how many attempts, the status
your server returned and the first bytes of its response.

```bash
curl -sS "$SCE_BASE_URL/v1/webhooks/deliveries?status=FAILED" \
  -H "Authorization: Bearer $SCE_API_KEY" | jq '.data[] | {eventType, attempts, responseStatus, lastError}'
```

Also in the web app, under **Settings → Webhooks**.

Replay one after fixing your receiver:

```bash
curl -sS -X POST "$SCE_BASE_URL/v1/webhooks/deliveries/{deliveryId}/replay" \
  -H "Authorization: Bearer $SCE_API_KEY"
```

The event is re-sent with its **original id and bytes**, so a receiver that already handled it
deduplicates exactly as it should. Deliveries are kept for 30 days.

## A complete receiver

[`packages/sdk/examples/webhook-receiver.ts`](../../packages/sdk/examples/webhook-receiver.ts)
— runnable, and correct on all four counts above.
