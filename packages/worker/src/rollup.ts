import { rollupUsage } from "@sce/db";
import { dayStart, describeError } from "@sce/shared";
import { workerConfig } from "./env.ts";

/**
 * Daily usage rollups.
 *
 * Metering writes one `UsageRecord` per model call, which is the right grain
 * for enforcement and the wrong one for a dashboard: "spend by model, by day,
 * for the last quarter" over that table is a scan that gets slower every day
 * the product succeeds. So the worker recomputes a per-tenant, per-day,
 * per-model summary on a timer.
 *
 * Two properties matter, and both come from it being a *recompute* rather than
 * an increment:
 *
 *   - **Idempotent.** Running it twice, or ten times, produces the same
 *     numbers. A retried sweep cannot double-count.
 *   - **Self-healing.** A record written late — a worker that came back after a
 *     network partition — is picked up by the next sweep of that day, which is
 *     why yesterday is recomputed alongside today rather than being sealed at
 *     midnight.
 *
 * Nothing enforces anything from these rows. Quotas and the spend guard read
 * `UsageRecord` directly, so a rollup that is stale, wrong or switched off
 * entirely can make a report lag — it can never let spend past a limit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Rollup {
  stop(): Promise<void>;
}

/**
 * Recompute today and yesterday, across every tenant.
 *
 * Yesterday is included because a sweep that only ever touched the current day
 * would leave the last few minutes before midnight permanently under-counted —
 * the records written at 23:59 land after the day's final sweep.
 */
export async function rollupOnce(now: Date = new Date()): Promise<number> {
  const scope = {
    kind: "every-tenant",
    reason: "the usage rollup recomputes every tenant's day",
  } as const;

  const today = dayStart(now);
  const yesterday = new Date(today.getTime() - DAY_MS);

  let rows = 0;
  for (const day of [yesterday, today]) {
    rows += await rollupUsage({ day, scope, now });
  }
  return rows;
}

/** Start the periodic sweep. `USAGE_ROLLUP_INTERVAL_MS=0` disables it. */
export function startRollup(): Rollup {
  if (workerConfig.USAGE_ROLLUP_INTERVAL_MS === 0) {
    return { stop: async () => {} };
  }

  let running = false;
  const timer = setInterval(() => {
    // Overlapping sweeps would recompute the same rows against each other;
    // skip rather than queue, exactly as the reaper does.
    if (running) return;
    running = true;
    void rollupOnce()
      .catch((error: unknown) => {
        console.error("[rollup] sweep failed", { error: describeError(error) });
      })
      .finally(() => {
        running = false;
      });
  }, workerConfig.USAGE_ROLLUP_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
