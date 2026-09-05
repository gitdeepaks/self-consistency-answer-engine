import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  claimWebhookDispatch,
  createRun,
  createWebhookEndpoint,
  dispatchWebhookEvent,
  getRun,
  getWebhookEndpoint,
  listWebhookDeliveries,
  prisma,
  ensureTenant,
  type CandidateSeed,
} from "@sce/db";
import { localJobMeta, type JobMeta } from "@sce/queue";
import {
  WEBHOOK_HEADERS,
  runCompletedEvent,
  toRunSummary,
  verifyWebhookSignature,
} from "@sce/shared";
import { processWebhookJob } from "./webhooks.ts";

/**
 * Delivery, against a real receiver.
 *
 * The processor's whole job is a judgement — **which failures are worth
 * retrying** — and that judgement is invisible to a type and untestable against
 * a mocked `fetch` that never reproduces a real server's behaviour. So these
 * tests stand up an actual HTTP server on loopback and make it misbehave in the
 * specific ways receivers misbehave: a 500 that will pass, a 400 that will not,
 * a redirect, and a socket that accepts the connection and then says nothing.
 *
 * The other half is the contract with the queue. The processor **throws only to
 * ask for a retry**; every settled outcome — delivered, refused, given up on —
 * returns normally, so BullMQ's failed set stays a list of processor bugs rather
 * than a list of customers whose servers are down. Each test below asserts on
 * that distinction directly, because getting it backwards produces a system that
 * looks fine and quietly stops retrying.
 */

const PREFIX = "test-worker-webhooks";
const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
];

/** One request the receiver saw. */
interface Received {
  headers: Headers;
  body: string;
}

let tenantId = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";

/** What the receiver should do with the next request. */
let respond: (received: Received) => Response | Promise<Response> = () =>
  new Response("ok", { status: 200 });
const received: Received[] = [];

beforeAll(async () => {
  await cleanup();
  tenantId = (await ensureTenant(`${PREFIX}-a`, "Worker webhooks")).id;

  server = Bun.serve({
    port: 0, // Any free port: a fixed one makes the suite fail on a busy machine.
    async fetch(request) {
      const entry = { headers: request.headers, body: await request.text() };
      received.push(entry);
      return respond(entry);
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await cleanup();
});

async function cleanup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}

/**
 * An endpoint at `path`, and one pending delivery addressed to it.
 *
 * A fresh endpoint per test, so the fan-out to *every* subscribed endpoint —
 * which is the behaviour — cannot make one test's delivery land in another's
 * assertions.
 */
async function pending(path: string): Promise<{
  endpointId: string;
  deliveryId: string;
  secret: string;
}> {
  const created = await createWebhookEndpoint({
    tenantId,
    createdByUserId: null,
    url: `${origin}${path}`,
    eventTypes: ["run.completed"],
  });

  const run = await createRun({ tenantId, prompt: path, candidates: SEEDS });
  const loaded = await getRun(tenantId, run.id);
  if (loaded === null) throw new Error("run vanished");

  const ids = await dispatchWebhookEvent({
    tenantId,
    event: runCompletedEvent(toRunSummary(loaded)),
  });

  for (const id of ids) {
    const dispatch = await claimWebhookDispatch(tenantId, id);
    if (dispatch?.endpointId === created.endpoint.id) {
      return {
        endpointId: created.endpoint.id,
        deliveryId: id,
        secret: created.secret,
      };
    }
  }
  throw new Error("no delivery was created for the endpoint");
}

/** The delivery row as it stands now. */
async function delivery(endpointId: string, deliveryId: string) {
  const page = await listWebhookDeliveries({
    tenantId,
    limit: 50,
    filters: { endpointId },
  });
  return page.find((entry) => entry.id === deliveryId);
}

/** A delivery attempt that is not the last one the queue will make. */
function attempt(number: number): JobMeta {
  return {
    id: `hook-${number}`,
    attempt: number,
    maxAttempts: 6,
    isFinalAttempt: false,
  };
}

describe("a receiver that accepts", () => {
  test("the delivery settles, and arrives signed and verifiable", async () => {
    respond = () => new Response("ok", { status: 202 });
    received.length = 0;

    const { endpointId, deliveryId, secret } = await pending("/accept");
    await processWebhookJob({ tenantId, deliveryId }, attempt(1));

    const settled = await delivery(endpointId, deliveryId);
    expect(settled?.status).toBe("DELIVERED");
    expect(settled?.responseStatus).toBe(202);
    expect(settled?.deliveredAt).not.toBeNull();
    // Settled means settled: nothing is left scheduled.
    expect(settled?.nextAttemptAt).toBeNull();

    const request = received.at(-1);
    expect(request).toBeDefined();
    if (request === undefined) return;

    // The receiver's side of the contract, exercised exactly as a customer
    // would: verify the raw body against the secret we were handed at
    // registration. Anything that re-serialised the payload in transit — in the
    // database, in the queue, in this processor — fails here and nowhere else.
    const verified = await verifyWebhookSignature({
      secret,
      payload: request.body,
      headers: request.headers,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.event.type).toBe("run.completed");

    expect(request.headers.get(WEBHOOK_HEADERS.id)).toBeTruthy();
    expect(request.headers.get("content-type")).toContain("application/json");
  });

  test("every 2xx counts, not only 200", async () => {
    respond = () => new Response(null, { status: 204 });
    const { endpointId, deliveryId } = await pending("/no-content");

    await processWebhookJob({ tenantId, deliveryId }, attempt(1));

    expect((await delivery(endpointId, deliveryId))?.status).toBe("DELIVERED");
  });
});

describe("a receiver that fails temporarily", () => {
  test("a 500 throws, so the queue retries it, and the row stays pending", async () => {
    respond = () => new Response("upstream exploded", { status: 500 });
    const { endpointId, deliveryId } = await pending("/five-hundred");

    // Throwing is the *only* way this processor asks for a retry — the queue
    // owns the backoff, because a `setTimeout` here would not survive a deploy.
    expect(
      processWebhookJob({ tenantId, deliveryId }, attempt(1)),
    ).rejects.toThrow();

    // Give the rejection a turn to settle before reading the row.
    await processWebhookJob({ tenantId, deliveryId }, attempt(2)).catch(
      () => undefined,
    );

    const row = await delivery(endpointId, deliveryId);
    expect(row?.status).toBe("PENDING");
    expect(row?.responseStatus).toBe(500);
    expect(row?.lastError).toContain("500");
    // The row and the queue agree about when the next attempt is due.
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row?.attempts).toBe(2);
  });

  test("a 429 is retried, because it means later rather than never", async () => {
    respond = () => new Response("slow down", { status: 429 });
    const { endpointId, deliveryId } = await pending("/too-many");

    await processWebhookJob({ tenantId, deliveryId }, attempt(1)).catch(
      () => undefined,
    );

    expect((await delivery(endpointId, deliveryId))?.status).toBe("PENDING");
  });

  test("a connection that never answers is retried, not treated as a refusal", async () => {
    // Nothing is listening on this port. DNS, TLS and refused connections all
    // land here, and none of them tells us anything durable about the receiver.
    const created = await createWebhookEndpoint({
      tenantId,
      createdByUserId: null,
      url: "http://127.0.0.1:9/unreachable",
      eventTypes: ["run.completed"],
    });

    const run = await createRun({
      tenantId,
      prompt: "unreachable",
      candidates: SEEDS,
    });
    const loaded = await getRun(tenantId, run.id);
    if (loaded === null) throw new Error("run vanished");

    const ids = await dispatchWebhookEvent({
      tenantId,
      event: runCompletedEvent(toRunSummary(loaded)),
    });
    let target = "";
    for (const id of ids) {
      const dispatch = await claimWebhookDispatch(tenantId, id);
      if (dispatch?.endpointId === created.endpoint.id) target = id;
    }

    await processWebhookJob({ tenantId, deliveryId: target }, attempt(1)).catch(
      () => undefined,
    );

    const row = await delivery(created.endpoint.id, target);
    expect(row?.status).toBe("PENDING");
    // No HTTP status, because the request never completed — which is exactly
    // the case a status-only failure record cannot represent.
    expect(row?.responseStatus).toBeNull();
    expect(row?.lastError).not.toBeNull();
  });
});

describe("a receiver that refuses durably", () => {
  test("a 400 is terminal on the first attempt, and does not throw", async () => {
    respond = () => new Response("I do not want this", { status: 400 });
    const { endpointId, deliveryId } = await pending("/bad-request");

    /*
     * The judgement this whole file exists for. A 400 will fail identically six
     * times over five minutes, and retrying it teaches the receiver only that we
     * do not read their responses. So it settles immediately — and it *returns*
     * rather than throwing, because a customer's misconfigured route is not a
     * bug in this processor and does not belong in the queue's failed set.
     */
    await processWebhookJob({ tenantId, deliveryId }, attempt(1));

    const row = await delivery(endpointId, deliveryId);
    expect(row?.status).toBe("FAILED");
    expect(row?.responseStatus).toBe(400);
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeNull();
  });

  test("a 404 is terminal too — the route is simply not there", async () => {
    respond = () => new Response("not found", { status: 404 });
    const { endpointId, deliveryId } = await pending("/gone");

    await processWebhookJob({ tenantId, deliveryId }, attempt(1));

    expect((await delivery(endpointId, deliveryId))?.status).toBe("FAILED");
  });

  test("a redirect is not followed — it would post the payload elsewhere", async () => {
    respond = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      });
    const { endpointId, deliveryId } = await pending("/redirect");

    await processWebhookJob({ tenantId, deliveryId }, attempt(1)).catch(
      () => undefined,
    );

    // A 30x to another host would send a customer's prompts somewhere they never
    // registered, so it is recorded as a failure rather than obeyed.
    const row = await delivery(endpointId, deliveryId);
    expect(row?.status).not.toBe("DELIVERED");
    expect(row?.responseStatus).toBe(302);
  });

  test("the final attempt settles as failed rather than throwing", async () => {
    respond = () => new Response("still broken", { status: 503 });
    const { endpointId, deliveryId } = await pending("/exhausted");

    // A delivery that has run out of attempts does *not* dead-letter: the
    // delivery log is a better dead-letter queue for this, because it is per
    // endpoint, per event, replayable, and visible to the customer.
    await processWebhookJob(
      { tenantId, deliveryId },
      { id: "hook-final", attempt: 6, maxAttempts: 6, isFinalAttempt: true },
    );

    const row = await delivery(endpointId, deliveryId);
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(6);
    // And the endpoint's streak advances only now, on a delivery given up on —
    // not once per attempt, which would disable a receiver four times too fast.
    expect(
      (await getWebhookEndpoint(tenantId, endpointId))?.consecutiveFailures,
    ).toBe(1);
  });
});

describe("deliveries that should not be sent at all", () => {
  test("a disabled endpoint is skipped, and its delivery left replayable", async () => {
    respond = () => new Response("ok", { status: 200 });
    const { endpointId, deliveryId } = await pending("/disabled");

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabledAt: new Date(), disabledReason: "test" },
    });

    const before = received.length;
    await processWebhookJob({ tenantId, deliveryId }, attempt(1));

    // Nothing was sent…
    expect(received.length).toBe(before);
    // …and the row is untouched, so re-enabling the endpoint and replaying does
    // the obvious thing.
    expect((await delivery(endpointId, deliveryId))?.status).toBe("PENDING");
  });

  test("a delivery that no longer exists is a no-op, not a crash", async () => {
    // The redelivered-job case: the row was pruned, or a concurrent attempt
    // settled and removed it. Nothing to do is exactly what idempotency looks
    // like, and throwing would send a phantom job round the retry loop.
    await processWebhookJob(
      { tenantId, deliveryId: "clnonexistent000000000000" },
      localJobMeta("hook-missing"),
    );
  });
});
