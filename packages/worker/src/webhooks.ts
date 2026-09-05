import {
  claimWebhookDispatch,
  dispatchWebhookEvent,
  listDueWebhookDeliveries,
  pruneWebhookDeliveries,
  recordWebhookFailure,
  recordWebhookSuccess,
  sweepIdempotencyRecords,
} from "@sce/db";
import { queueConfig, webhookQueue, type JobMeta } from "@sce/queue";
import {
  describeError,
  runCompletedEvent,
  runFailedEvent,
  toRunSummary,
  webhookSignatureHeaders,
  type Run,
  type WebhookEvent,
  type WebhookJob,
} from "@sce/shared";
import { workerConfig } from "./env.ts";

/**
 * Delivering an event to a customer's server.
 *
 * The whole file turns on one judgement that a naive implementation gets wrong:
 * **which failures are worth retrying.** A receiver that answers 500 is having
 * a bad minute and deserves five more attempts. A receiver that answers 400,
 * 404 or 410 has told us something durable — the route is wrong, or gone, or
 * rejects our payload — and retrying that six times over five minutes teaches
 * them only that we do not read their responses. So 4xx is terminal (with the
 * two exceptions below) and everything else is retried.
 *
 * The second judgement is where retries *live*. They are the queue's, not this
 * module's: BullMQ's exponential backoff is the same mechanism the run flow
 * uses, it is already visible in the operator's dashboard, and it survives the
 * process being redeployed mid-schedule — which a `setTimeout` here would not.
 * What this module owns is the decision to throw or not, and the row that
 * records what happened either way.
 *
 * A delivery that exhausts its attempts does **not** dead-letter. It is marked
 * `FAILED` on its own row and the processor returns normally, because the
 * delivery log is a strictly better dead-letter queue for this: it is per
 * endpoint, per event, replayable, and visible to the customer whose
 * integration is the thing that is broken.
 */

/** Response text kept on the row when a receiver refuses a delivery. */
const RESPONSE_SNIPPET_CHARS = 200;

/**
 * Statuses that mean "do not try this again".
 *
 * 408 and 429 are pointedly absent: a timeout and a rate limit are both the
 * receiver asking for *later*, not for *never*, and they are the two 4xx codes
 * where retrying is the courteous thing rather than the rude one.
 */
function isTerminalStatus(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/** The backoff BullMQ will apply before the next attempt, mirrored onto the row. */
function backoffMs(attempt: number): number {
  return queueConfig.WEBHOOK_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
}

/**
 * Perform one delivery attempt.
 *
 * Throws only to ask the queue for a retry. Every other outcome — delivered,
 * refused, given up on — is recorded and returned normally, so the queue's
 * failed set stays a list of *processor bugs* rather than a list of customers
 * whose servers are down.
 */
export async function processWebhookJob(
  job: WebhookJob,
  meta: JobMeta,
): Promise<void> {
  const delivery = await claimWebhookDispatch(job.tenantId, job.deliveryId);

  // Deleted, or already settled by a concurrent attempt. Not an error: a
  // redelivered job whose work is done is exactly what idempotency looks like.
  if (delivery === null) return;

  // An endpoint disabled between emission and delivery should not be posted to.
  // The row is left `PENDING` so that re-enabling the endpoint and replaying
  // the delivery does the obvious thing.
  if (delivery.endpointDisabled) return;

  const attempts = meta.attempt;
  const timestampSeconds = Math.floor(Date.now() / 1000);

  const signature = await webhookSignatureHeaders({
    secret: delivery.secret,
    id: delivery.eventId,
    timestampSeconds,
    payload: delivery.payload,
  });

  let status: number | null = null;
  let failure: string | null = null;

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "sce-webhooks/1.0",
        ...signature,
      },
      body: delivery.payload,
      // The receiver is a stranger's server; without this, one that accepts the
      // connection and never answers holds a worker slot until the process is
      // restarted.
      signal: AbortSignal.timeout(workerConfig.WEBHOOK_TIMEOUT_MS),
      // A 30x to a different host would post a customer's prompt somewhere they
      // never registered. Redirects are the receiver's problem to fix in their
      // configuration, not ours to follow.
      redirect: "manual",
    });

    status = response.status;
    if (response.ok) {
      await recordWebhookSuccess({
        tenantId: job.tenantId,
        deliveryId: delivery.id,
        endpointId: delivery.endpointId,
        responseStatus: response.status,
        attempts,
      });
      return;
    }

    // Read for the log, and bounded: a receiver that returns an HTML error page
    // must not put a megabyte of markup in a database column.
    const body = await response.text().catch(() => "");
    failure = `HTTP ${response.status}${body === "" ? "" : ` — ${body.slice(0, RESPONSE_SNIPPET_CHARS)}`}`;
  } catch (error: unknown) {
    // DNS failure, TLS failure, connection refused, timeout. All transient as
    // far as we can tell from here, so all retried.
    failure = describeError(error);
  }

  const terminal = status !== null && isTerminalStatus(status);
  const exhausted = terminal || meta.isFinalAttempt;

  const outcome = await recordWebhookFailure({
    tenantId: job.tenantId,
    deliveryId: delivery.id,
    endpointId: delivery.endpointId,
    responseStatus: status,
    error: failure ?? "unknown failure",
    attempts,
    exhausted,
    nextAttemptAt: exhausted
      ? null
      : new Date(Date.now() + backoffMs(attempts)),
  });

  if (outcome.disabled) {
    console.warn("[webhooks] endpoint disabled after repeated failures", {
      endpointId: delivery.endpointId,
      consecutiveFailures: outcome.consecutiveFailures,
    });
  }

  if (exhausted) {
    console.warn("[webhooks] delivery given up", {
      deliveryId: delivery.id,
      eventType: delivery.eventType,
      attempts,
      status,
      terminal,
    });
    return;
  }

  // The one path that throws: ask the queue for the next attempt. The row above
  // already says when that is due, so a sweeper looking at the database and the
  // queue looking at its own schedule agree.
  throw new Error(
    `Webhook delivery failed (attempt ${attempts}): ${failure ?? "unknown"}`,
  );
}

/* -------------------------------------------------------------- emission */

/**
 * Emit the terminal event for a run.
 *
 * Best-effort by construction, and that is the important property: a run has
 * already completed by the time this is called, and no failure to tell somebody
 * about it may un-complete it. Every error is caught and logged; the dispatch
 * rows are the durable part, and the sweeper picks up anything the direct
 * enqueue below missed.
 */
export async function emitRunWebhook(
  run: Run,
  tenantId: string,
): Promise<void> {
  const event =
    run.status === "COMPLETE"
      ? runCompletedEvent(toRunSummary(run))
      : run.status === "FAILED"
        ? runFailedEvent(toRunSummary(run), run.error ?? "Run failed")
        : null;

  // Cancellation is deliberately not an event. A run stops because somebody
  // asked it to, and telling their own server about their own action is noise
  // that every integration then has to filter out.
  if (event === null) return;

  await emitWebhookEvent(tenantId, event);
}

/**
 * Write the dispatch rows for an event, then nudge the queue.
 *
 * The write is the commitment; the enqueue is an optimisation that saves a
 * sweep interval of latency, and is allowed to fail. That split is what makes
 * emission a single-store operation rather than a dual write to Postgres and
 * Redis — the failure mode of which is an event that exists in exactly one of
 * the two places and is therefore either lost or duplicated.
 */
export async function emitWebhookEvent(
  tenantId: string,
  event: WebhookEvent,
): Promise<void> {
  try {
    const deliveryIds = await dispatchWebhookEvent({ tenantId, event });
    await Promise.all(
      deliveryIds.map((deliveryId) =>
        webhookQueue()
          .enqueue({ tenantId, deliveryId })
          .catch((error: unknown) => {
            // Not lost: the row is `PENDING` and due now, so the sweeper will
            // enqueue it on its next pass.
            console.warn(
              "[webhooks] could not enqueue immediately; left for the sweeper",
              {
                deliveryId,
                error: describeError(error),
              },
            );
          }),
      ),
    );
  } catch (error: unknown) {
    console.error("[webhooks] could not emit event", {
      type: event.type,
      error: describeError(error),
    });
  }
}

/* --------------------------------------------------------------- sweeper */

export interface WebhookSweeper {
  stop(): Promise<void>;
}

/**
 * Move due deliveries from the database onto the queue.
 *
 * This is what makes the outbox an outbox. It covers three cases that a direct
 * enqueue cannot: Redis being unreachable at the moment an event was emitted, a
 * `quota.exceeded` event emitted by an API replica that has no queue producer
 * of its own, and a job lost to a Redis eviction.
 *
 * Enqueueing an already-queued delivery is a no-op, because the job id is
 * derived from the delivery id — so this is safe to run alongside the direct
 * path, and safe to run on every replica.
 */
export async function sweepWebhooksOnce(
  now: Date = new Date(),
): Promise<number> {
  const due = await listDueWebhookDeliveries({
    before: now,
    limit: workerConfig.WEBHOOK_SWEEP_BATCH,
    scope: {
      kind: "every-tenant",
      reason:
        "the webhook outbox sweep serves whichever tenants have events waiting",
    },
  });

  let enqueued = 0;
  for (const delivery of due) {
    try {
      await webhookQueue().enqueue({
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
      });
      enqueued += 1;
    } catch (error: unknown) {
      console.error("[webhooks] sweep could not enqueue", {
        deliveryId: delivery.id,
        error: describeError(error),
      });
    }
  }
  return enqueued;
}

/**
 * Retention: settled deliveries and expired idempotency records.
 *
 * Both tables grow with traffic and neither is read after its window, so
 * something has to remove them. Folded into the webhook sweeper rather than
 * given a timer of its own because it is cheap, and because one more `setInterval`
 * in a worker is one more thing to remember during a shutdown.
 */
export async function pruneOnce(now: Date = new Date()): Promise<void> {
  await sweepIdempotencyRecords({
    now,
    scope: {
      kind: "every-tenant",
      reason: "idempotency records expire on their own clock, install-wide",
    },
  });

  if (workerConfig.WEBHOOK_RETENTION_DAYS === 0) return;

  await pruneWebhookDeliveries({
    before: new Date(
      now.getTime() - workerConfig.WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
    scope: {
      kind: "every-tenant",
      reason: "the delivery log's retention window is an install-wide policy",
    },
  });
}

/** How many sweeps pass between retention passes. Pruning is not urgent. */
const PRUNE_EVERY_N_SWEEPS = 600;

/** Start the periodic sweep. `WEBHOOK_SWEEP_INTERVAL_MS=0` disables it. */
export function startWebhookSweeper(): WebhookSweeper {
  if (workerConfig.WEBHOOK_SWEEP_INTERVAL_MS === 0) {
    return { stop: async () => {} };
  }

  let running = false;
  let ticks = 0;

  const timer = setInterval(() => {
    // Overlapping sweeps would enqueue the same rows against each other; skip
    // rather than queue, exactly as the reaper and the rollup do.
    if (running) return;
    running = true;
    ticks += 1;
    const prune = ticks % PRUNE_EVERY_N_SWEEPS === 0;

    void sweepWebhooksOnce()
      .then(() => (prune ? pruneOnce() : undefined))
      .catch((error: unknown) => {
        console.error("[webhooks] sweep failed", {
          error: describeError(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, workerConfig.WEBHOOK_SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
