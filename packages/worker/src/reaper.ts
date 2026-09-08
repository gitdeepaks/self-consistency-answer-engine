import { cancelPendingCandidates, failRun, getRun, listOverdueRuns } from "@sce/db";
import { runBus } from "@sce/queue";
import { isTerminalRunStatus } from "@sce/shared";
import { logger, withSpan } from "@sce/observability";
import { runCompleted } from "./telemetry.ts";
import { workerConfig } from "./env.ts";
import { emitRunWebhook } from "./webhooks.ts";

/**
 * The deadline reaper.
 *
 * Every in-process guard — the per-call timeout, the deadline `AbortSignal`,
 * the checkpoint between steps — assumes there is still a process running to
 * enforce it. The reaper covers the case where there is not: the machine
 * holding a run was terminated between checkpoints, so nothing is left to
 * notice that its deadline passed and the run would sit at `FANNING_OUT` for
 * ever, streaming nothing to a client that is still connected.
 *
 * It is the one legitimately cross-tenant reader in the system, and it has to
 * say so — `RunScope` makes `{ kind: "every-tenant" }` a phrase somebody typed
 * on purpose rather than an optional filter somebody forgot.
 */

export interface Reaper {
  stop(): Promise<void>;
}

export async function reapOnce(now: Date = new Date()): Promise<number> {
  const overdue = await listOverdueRuns({
    scope: {
      kind: "every-tenant",
      reason: "deadline reaper runs across the whole install",
    },
    now,
    limit: 100,
  });

  let reaped = 0;
  for (const run of overdue) {
    const message = run.deadlineAt
      ? `Run exceeded its deadline of ${run.deadlineAt.toISOString()} and no worker completed it`
      : "Run exceeded its deadline and no worker completed it";

    try {
      const current = await getRun(run.tenantId, run.id);
      if (!current || isTerminalRunStatus(current.status)) continue;
      const won = await withSpan("worker.reaper.persist", { "run.id": run.id }, () => failRun(run.tenantId, run.id, message));
      if (!won) continue;
      runCompleted("failed", current.createdAt);
      reaped += 1;
      try {
        await cancelPendingCandidates(run.tenantId, run.id, message);
        await runBus().publish(run.tenantId, run.id, {
          type: "run.failed",
          runId: run.id,
          error: message,
        });
      } finally {
        const failed = await getRun(run.tenantId, run.id);
        if (failed) await emitRunWebhook(failed, run.tenantId, true);
      }
    } catch {
      logger.error("[reaper] failed to reap run", {
        runId: run.id,
      });
    }
  }

  if (reaped > 0)
    logger.warn("[reaper] failed runs past their deadline", { reaped });
  return reaped;
}

/** Start the periodic sweep. `REAPER_INTERVAL_MS=0` disables it entirely. */
export function startReaper(): Reaper {
  if (workerConfig.REAPER_INTERVAL_MS === 0) {
    return { stop: async () => {} };
  }

  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    // Overlapping sweeps would compete for the same rows; skip rather than queue.
    if (running) return;
    running = reapOnce()
      .then(() => {})
      .catch(() => {
        logger.error("[reaper] sweep failed");
      })
      .finally(() => {
        running = null;
      });
  }, workerConfig.REAPER_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
