/**
 * A receiver, written the way a receiver should be written.
 *
 *     SCE_WEBHOOK_SECRET=whsec_… bun run packages/sdk/examples/webhook-receiver.ts
 *
 * Four rules, and each one is a bug somebody has shipped:
 *
 *   1. **Verify before parsing.** The signature covers the raw bytes. A handler
 *      that parses first and re-serialises to verify fails on key order, on
 *      unicode escaping, and on nothing else for months.
 *   2. **Answer 2xx fast, work afterwards.** A delivery that takes longer than
 *      ten seconds is treated as failed and retried, so doing the work inline
 *      turns one slow event into six copies of itself.
 *   3. **Deduplicate on `webhook-id`.** Delivery is at-least-once by design.
 *      The id is stable across every retry and across an operator's replay.
 *   4. **Handle the union exhaustively.** A `switch` with no default is a
 *      compile error when a new event type is added, which is when you want to
 *      find out — not in production, from a payload you ignored.
 */

import { verifyWebhookSignature, type WebhookEvent } from "../src/index.ts"

const secret = process.env["SCE_WEBHOOK_SECRET"]
if (secret === undefined || secret === "") {
  console.error("Set SCE_WEBHOOK_SECRET — the whsec_… value returned when you registered the endpoint.")
  process.exit(1)
}

/**
 * Events already handled.
 *
 * In-memory here because this is an example; in a real receiver this is a
 * unique index on the event id, so that two instances behind a load balancer
 * cannot both decide they are the first to see it.
 */
const handled = new Set<string>()

async function handle(event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case "run.completed":
      console.log(`✓ run ${event.data.run.id} completed`, {
        confidence: event.data.run.confidence,
        latencyMs: event.data.run.totalLatencyMs,
      })
      // The event carries a summary, not the answer. Fetch the run when you
      // need the text: `await sce.runs.retrieve(event.data.run.id)`.
      return

    case "run.failed":
      console.error(`✗ run ${event.data.run.id} failed: ${event.data.error}`)
      return

    case "quota.exceeded":
      console.warn(
        `! quota ${event.data.quota.limit} exceeded on the ${event.data.plan} plan — ` +
          `${event.data.quota.used}/${event.data.quota.ceiling}, resets ${event.data.quota.resetAt}`,
      )
      return

    default: {
      // Exhaustiveness: adding an event type to the union makes this line a
      // compile error, which is the point of writing it out.
      const unreachable: never = event
      throw new Error(`Unhandled event: ${JSON.stringify(unreachable)}`)
    }
  }
}

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 4000),
  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })

    // The raw bytes. Not `request.json()` — see rule 1.
    const payload = await request.text()

    const result = await verifyWebhookSignature({
      secret,
      payload,
      headers: request.headers,
    })

    if (!result.ok) {
      // 400, not 500: a bad signature will fail the same way on every retry, so
      // asking for one wastes both sides' time. A sudden run of these means a
      // rotated secret, or somebody probing the endpoint.
      console.warn(`refused a delivery: ${result.reason}`)
      return new Response("invalid signature", { status: 400 })
    }

    const { event } = result

    if (handled.has(event.id)) {
      // Acknowledged, not reprocessed. A duplicate is a successful delivery
      // whose acknowledgement we lost, and the sender needs to hear a 2xx to
      // stop resending it.
      return new Response("duplicate", { status: 200 })
    }
    handled.add(event.id)

    // Rule 2: acknowledge now, work after. `void` rather than `await`, and the
    // error is caught here because an unhandled rejection would take the
    // process down after the response has already gone out.
    void handle(event).catch((error: unknown) => {
      console.error("handler failed", { eventId: event.id, error })
    })

    return new Response("ok", { status: 200 })
  },
})

console.log(`listening on http://localhost:${server.port}`)
console.log("register it with:")
console.log(
  `  curl -X POST "$SCE_BASE_URL/v1/webhooks/endpoints" \\\n` +
    `    -H "Authorization: Bearer $SCE_API_KEY" -H "Content-Type: application/json" \\\n` +
    `    -d '{"url":"http://localhost:${server.port}"}'`,
)
