import { cancelPendingCandidates, failRun, listOverdueRuns } from "@sce/db";
import { runBus } from "@sce/queue";
import { describeError } from "@sce/shared";
import { workerConfig } from "./env.ts";

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
      await cancelPendingCandidates(run.tenantId, run.id, message);
      await failRun(run.tenantId, run.id, message);
      await runBus().publish(run.tenantId, run.id, {
        type: "run.failed",
        runId: run.id,
        error: message,
      });
      reaped += 1;
    } catch (error) {
      console.error("[reaper] failed to reap run", {
        runId: run.id,
        error: describeError(error),
      });
    }
  }

  if (reaped > 0)
    console.warn(`[reaper] failed ${reaped} run(s) past their deadline`);
  return reaped;
}

/** Start the periodic sweep. `REAPER_INTERVAL_MS=0` disables it entirely. */
export function startReaper(): Reaper {
  if (workerConfig.REAPER_INTERVAL_MS === 0) {
    return { stop: async () => {} };
  }

  let running = false;
  const timer = setInterval(() => {
    // Overlapping sweeps would compete for the same rows; skip rather than queue.
    if (running) return;
    running = true;
    void reapOnce()
      .catch((error: unknown) => {
        console.error("[reaper] sweep failed", { error: describeError(error) });
      })
      .finally(() => {
        running = false;
      });
  }, workerConfig.REAPER_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
