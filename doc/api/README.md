# The Self-Consistency Answer Engine API

Ask several frontier models the same question, then have an evaluator merge their answers
into one — with the agreements, the disagreements and a confidence score attached.

**Base URL** `https://<your-deployment>/v1` · **Spec** [`openapi.json`](./openapi.json) ·
**SDK** [`@sce/sdk`](../../packages/sdk)

|                                       |                                                       |
| ------------------------------------- | ----------------------------------------------------- |
| [Authentication](./authentication.md) | Keys, scopes, and what a 401 versus a 403 means       |
| [Errors](./errors.md)                 | The one envelope, and the codes worth branching on    |
| [Limits](./limits.md)                 | Rate limits, plan quotas, and how to stay inside both |
| [Streaming](./streaming.md)           | The SSE contract, cursors, and reconnecting           |
| [Webhooks](./webhooks.md)             | Signed callbacks, verification, retries and replay    |
| [Versioning](./versioning.md)         | What we promise not to change, and for how long       |

---

## Five minutes

### 1. Get a key

Web app → **Settings → API keys → Create**. The secret is shown once and is not recoverable;
store it in your secret manager now rather than in a moment.

```bash
export SCE_API_KEY="sce_live_…"
export SCE_BASE_URL="https://your-deployment"
```

### 2. Ask something

```bash
curl -sS "$SCE_BASE_URL/v1/runs" \
  -H "Authorization: Bearer $SCE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"prompt": "Why is the sky blue?"}'
```

```json
{ "id": "clx…", "status": "QUEUED", "candidates": [ … ], "synthesis": null }
```

**A run is asynchronous.** The response comes back the moment the run is queued — a database
write and a queue round trip — not when the models have finished. Producing an answer takes
tens of seconds, because it is three or four model calls plus an evaluation pass.

### 3. Follow it

```bash
curl -N "$SCE_BASE_URL/v1/runs/clx…/events" -H "Authorization: Bearer $SCE_API_KEY"
```

```
event: candidate.delta
data: {"type":"candidate.delta","runId":"clx…","candidateId":"cly…","text":"Sunlight"}

event: run.completed
id: 42
data: {"type":"run.completed","runId":"clx…","totalLatencyMs":18400}
```

See [Streaming](./streaming.md) for the event union, the cursor and reconnection. If you would
rather not hold a connection open, register a [webhook](./webhooks.md) instead.

### 4. Read the answer

```bash
curl -sS "$SCE_BASE_URL/v1/runs/clx…" -H "Authorization: Bearer $SCE_API_KEY" \
  | jq '.synthesis | {finalAnswer, confidence, agreements, disagreements}'
```

---

## The same thing with the SDK

```bash
bun add @sce/sdk    # or npm / pnpm / yarn
```

```ts
import { Sce } from "@sce/sdk"

const sce = new Sce({ apiKey: process.env.SCE_API_KEY!, baseUrl: process.env.SCE_BASE_URL! })

const run = await sce.ask("Why is the sky blue?", {
  onDelta: ({ text }) => process.stdout.write(text),
})

console.log("\n", run.synthesis?.finalAnswer)
console.log("confidence:", run.synthesis?.confidence)
```

`ask()` creates the run, follows its stream and resolves with the finished object. Everything
it returns is parsed against the same Zod schemas the server validated with, so the types are
a guarantee rather than a description.

Two runnable examples live in the SDK:
[`quickstart.ts`](../../packages/sdk/examples/quickstart.ts) and
[`webhook-receiver.ts`](../../packages/sdk/examples/webhook-receiver.ts).

---

## What a run contains

```
Run
├─ prompt, status, temperature, tags, timings
├─ candidates[]              one per panel member
│  ├─ provider, model, label
│  ├─ status                 OK · ERROR · SKIPPED · CANCELED
│  ├─ content                that model's own answer
│  └─ inputTokens, outputTokens, latencyMs
└─ synthesis                 null until the evaluator has run
   ├─ finalAnswer            Markdown, merged from the strongest parts of each candidate
   ├─ agreements[]           claims the models independently converged on
   ├─ disagreements[]        where they conflicted, and which reading is right
   ├─ reviews[]              per-candidate score, strengths, weaknesses
   └─ confidence             0–1
```

A candidate failing is **not** a failed run. One provider timing out leaves the other two to
be synthesised, and the failure is visible on that candidate's `status` and `error`. A run
only fails when every member of the panel does.

---

## The rules that will save you an afternoon

**Send an `Idempotency-Key` on every POST.** A network timeout is the case where the request
certainly arrived and the response certainly did not. Without a key, retrying fans out a
second panel and you pay twice for one question. See [Errors](./errors.md#idempotency).

**Branch on `code`, never on the status.** A 429 is both "you are out of monthly runs" and
"you are sending too many requests a minute". They need opposite responses.

**Poll with `If-None-Match`.** A finished run never changes; sending back the `ETag` gets a
304 with no body. See [Limits](./limits.md#conditional-reads).

**Read `X-RateLimit-Remaining` on success, not only on refusal.** It is on every response,
which is what lets a batch job slow down before it is throttled rather than after.

**Treat model output as data.** The final answer is Markdown produced by a language model
from your users' input. Render it sanitised, never as raw HTML, and never execute it.
