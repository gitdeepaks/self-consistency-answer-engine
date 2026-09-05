import { disconnect } from "@sce/db";
import {
  closeRedis,
  createCandidateWorker,
  createSynthesisWorker,
  createWebhookWorker,
  pingRedis,
  queueConfig,
  setLocalRunJobHandlers,
  setLocalWebhookJobHandler,
} from "@sce/queue";
import { describeError } from "@sce/shared";
import { workerConfig } from "./env.ts";
import { runJobHandlers } from "./handlers.ts";
import { resolveEvaluator, resolvePanel } from "./providers.ts";
import { startReaper, type Reaper } from "./reaper.ts";
import { startRollup, type Rollup } from "./rollup.ts";
import { MemoryBreakerStore, setBreakerStore } from "./resilience.ts";
import {
  processWebhookJob,
  startWebhookSweeper,
  type WebhookSweeper,
} from "./webhooks.ts";

export {
  runJobHandlers,
  processCandidateJob,
  processSynthesisJob,
} from "./handlers.ts";
export {
  resolveEvaluator,
  resolvePanel,
  resolveProvider,
} from "./providers.ts";
export { reapOnce, startReaper } from "./reaper.ts";
export { rollupOnce, startRollup } from "./rollup.ts";
export { workerConfig } from "./env.ts";
export {
  emitRunWebhook,
  emitWebhookEvent,
  processWebhookJob,
  pruneOnce,
  startWebhookSweeper,
  sweepWebhooksOnce,
} from "./webhooks.ts";

/**
 * The worker process.
 *
 * Three BullMQ workers — one per queue — plus the deadline reaper, the usage
 * rollup and the webhook outbox sweeper. Everything this file does beyond
 * starting them is about stopping them properly, because that is the part a
 * deploy exercises several times a day.
 */

export interface WorkerHandle {
  /** Drain in-flight jobs and release every connection. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Start the worker.
 *
 * Under `RUN_TRANSPORT=local` there is no queue to consume: the processors are
 * registered with the in-process queue instead, and the API executes them
 * directly. That path exists so a single machine — or a test — can run the
 * exact same code without Redis, and it announces itself so nobody mistakes it
 * for the scalable one.
 */
export async function startWorker(): Promise<WorkerHandle> {
  if (queueConfig.RUN_TRANSPORT === "local") {
    setLocalRunJobHandlers(runJobHandlers);
    setLocalWebhookJobHandler(processWebhookJob);
    // A fleet-wide breaker needs Redis; without it, per-process state is the
    // honest option rather than a Redis call that cannot succeed.
    setBreakerStore(new MemoryBreakerStore());
    console.warn(
      "[worker] RUN_TRANSPORT=local — running in-process. Runs do not survive a restart " +
        "and this process cannot be scaled past one replica.",
    );
    const reaper = startReaper();
    const rollup = startRollup();
    const webhooks = startWebhookSweeper();
    return { shutdown: () => shutdownLocal(reaper, rollup, webhooks) };
  }

  await pingRedis();

  const candidateWorker = createCandidateWorker(runJobHandlers.candidate);
  const synthesisWorker = createSynthesisWorker(runJobHandlers.synthesis);
  const webhookWorker = createWebhookWorker(processWebhookJob);

  for (const worker of [candidateWorker, synthesisWorker, webhookWorker]) {
    worker.on("failed", (job, error) => {
      console.error("[worker] job failed", {
        queue: worker.name,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: describeError(error),
      });
    });
    worker.on("error", (error) => {
      console.error("[worker] worker error", {
        queue: worker.name,
        error: describeError(error),
      });
    });
  }

  await Promise.all([
    candidateWorker.waitUntilReady(),
    synthesisWorker.waitUntilReady(),
    webhookWorker.waitUntilReady(),
  ]);
  const reaper = startReaper();
  const rollup = startRollup();
  const webhookSweeper = startWebhookSweeper();

  announce();

  let shuttingDown: Promise<void> | null = null;
  return {
    shutdown: () => {
      /*
       * SIGTERM arrives once per deploy, and can arrive twice if the platform
       * is impatient. Memoising the drain means the second signal joins the
       * first rather than closing a worker that is halfway through closing.
       */
      shuttingDown ??= (async () => {
        console.log("[worker] draining…");
        await reaper.stop();
        await rollup.stop();
        await webhookSweeper.stop();
        // `close()` stops accepting new jobs and waits for active ones to
        // finish. That wait is the entire reason a rolling deploy does not
        // orphan runs — a killed worker's jobs would be redelivered, but only
        // after their lock expired, with the client watching nothing happen.
        await Promise.all([
          candidateWorker.close(),
          synthesisWorker.close(),
          webhookWorker.close(),
        ]);
        await closeRedis();
        await disconnect();
        console.log("[worker] drained");
      })();
      return shuttingDown;
    },
  };
}

async function shutdownLocal(
  reaper: Reaper,
  rollup: Rollup,
  webhooks: WebhookSweeper,
): Promise<void> {
  await reaper.stop();
  await rollup.stop();
  await webhooks.stop();
  setLocalRunJobHandlers(null);
  setLocalWebhookJobHandler(null);
  await disconnect();
}

function announce(): void {
  const panel = resolvePanel();
  const evaluator = resolveEvaluator();

  console.log("Self-Consistency Answer Engine — worker");
  console.log(
    `  transport  ${queueConfig.RUN_TRANSPORT}  concurrency ${queueConfig.QUEUE_CONCURRENCY}  ` +
      `attempts ${queueConfig.QUEUE_MAX_ATTEMPTS}`,
  );
  for (const provider of panel) {
    const state = provider.model
      ? `ready via ${provider.route}`
      : "UNAVAILABLE";
    console.log(
      `  panel      ${provider.spec.label.padEnd(8)} ${provider.modelId.padEnd(22)} ${state}`,
    );
  }
  console.log(
    `  evaluator  ${evaluator.spec.label.padEnd(8)} ${evaluator.modelId.padEnd(22)} ${
      evaluator.model ? `ready via ${evaluator.route}` : "UNAVAILABLE"
    }`,
  );
  console.log(
    `  budgets    run ${Math.round(workerConfig.RUN_DEADLINE_MS / 1000)}s  ` +
      `model ${Math.round(workerConfig.PER_MODEL_TIMEOUT_MS / 1000)}s  ` +
      `tokens ${workerConfig.RUN_MAX_TOTAL_TOKENS || "unlimited"}`,
  );
}

/**
 * Install the signal handlers.
 *
 * Exported rather than run on import so that a process embedding the worker —
 * a single-machine deployment running the API and the worker together — owns
 * its own shutdown sequence instead of inheriting two competing ones.
 */
export function installShutdownHandlers(handle: WorkerHandle): void {
  let exiting = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (exiting) return;
    exiting = true;
    console.log(`[worker] ${signal} received`);

    // A drain that hangs must not hold the deploy open for ever; the platform
    // would SIGKILL us anyway, and doing it ourselves at least logs why.
    const guard = setTimeout(() => {
      console.error(
        `[worker] drain exceeded ${workerConfig.SHUTDOWN_TIMEOUT_MS}ms; exiting with work in flight`,
      );
      process.exit(1);
    }, workerConfig.SHUTDOWN_TIMEOUT_MS);
    guard.unref?.();

    void handle
      .shutdown()
      .then(() => {
        clearTimeout(guard);
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("[worker] shutdown failed", {
          error: describeError(error),
        });
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

// Only when run as a program, so importing `@sce/worker` for its handlers (the
// embedded-worker path, and the tests) does not start a second consumer.
if (import.meta.main) {
  const handle = await startWorker();
  installShutdownHandlers(handle);
}
