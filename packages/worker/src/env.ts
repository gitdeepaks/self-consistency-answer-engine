import { calibrationMapSchema, loadRootEnv, type CalibrationMap } from "@sce/shared";
import { z } from "zod";

// Must run before anything below reads process.env.
loadRootEnv();

/**
 * Worker configuration, parsed once at boot.
 *
 * The predecessor of this file was a hand-rolled `num()` that fell back to a
 * default whenever a value failed to parse — so `PER_MODEL_TIMEOUT_MS=12O000`
 * (letter O) ran silently with the default and nobody found out. Every value
 * here is validated instead, and a bad one names itself and stops the process.
 */

const positiveInt = z.coerce.number().int().positive();

/**
 * A calibration map supplied as JSON.
 *
 * `JSON.parse` is one of the three places `unknown` is unavoidable, and this is
 * the shape §3 sanctions for it: the value enters as `unknown` and leaves as a
 * `CalibrationMap` or as a named configuration error. Nothing downstream sees
 * anything but the domain type, and a map that is malformed — or not monotone,
 * which `calibrationMapSchema` also refuses — stops the worker at boot instead
 * of quietly correcting every confidence with garbage.
 */
const calibrationEnvSchema: z.ZodType<CalibrationMap | null, string | undefined> = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx): CalibrationMap | null => {
    if (raw === undefined || raw.length === 0) return null;

    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON document" });
      return null;
    }

    const parsed = calibrationMapSchema.safeParse(document);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: `is not a calibration map — ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      });
      return null;
    }
    return parsed.data;
  });

const durationMs = positiveInt.max(
  60 * 60_000,
  "duration must be under an hour",
);

const workerEnvSchema = z
  .object({
    /** Wall-clock budget for a single panel member. */
    PER_MODEL_TIMEOUT_MS: durationMs.default(120_000),
    /** Wall-clock budget for the evaluator pass. */
    EVALUATOR_TIMEOUT_MS: durationMs.default(180_000),
    /**
     * Budget for the whole run, from creation to synthesis.
     *
     * Enforced between steps and as an `AbortSignal` inside every model call.
     * Without it, a run whose legs each stay just under their own timeout can
     * still hold a worker slot for an unbounded total.
     */
    RUN_DEADLINE_MS: durationMs.default(10 * 60_000),

    MAX_OUTPUT_TOKENS: positiveInt.max(200_000).default(4_000),
    /** Retries the AI SDK performs inside a single model call. */
    MAX_RETRIES: z.coerce.number().int().nonnegative().max(10).default(2),

    /**
     * Per-run ceilings, checked before each model call.
     *
     * Zero disables the ceiling. Cost is in micro-cents (1e-8 USD), matching
     * `UsageRecord.costMicroCents`, so the check is exact integer arithmetic.
     */
    RUN_MAX_TOTAL_TOKENS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(400_000),
    RUN_MAX_COST_MICRO_CENTS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(50 * 1_000_000),

    /** Concurrent in-flight calls allowed against one provider, per worker. */
    PROVIDER_MAX_CONCURRENCY: positiveInt.max(64).default(4),
    /** Consecutive failures that open a provider's circuit breaker. */
    BREAKER_FAILURE_THRESHOLD: positiveInt.max(100).default(5),
    /** How long a provider's breaker stays open before a trial call. */
    BREAKER_COOLDOWN_MS: durationMs.default(30_000),

    /**
     * Streaming deltas are batched before they reach the bus.
     *
     * One published frame per generated token would make the progress bus cost
     * more than the generation. Flushing on whichever of these two limits comes
     * first keeps the UI smooth on a fast model and responsive on a slow one.
     */
    CANDIDATE_DELTA_FLUSH_MS: positiveInt.max(5_000).default(80),
    CANDIDATE_DELTA_FLUSH_CHARS: positiveInt.max(64_000).default(256),

    /**
     * How long the install-wide kill switch reading is cached.
     *
     * Consulted before every model call across the fleet, so a per-step read
     * would cost a query per candidate to observe a switch that is off
     * essentially always. The trade is that a freshly-tripped switch takes up
     * to one window to reach every worker.
     */
    KILL_SWITCH_REFRESH_MS: durationMs.default(10_000),

    /**
     * How often per-tenant daily usage rollups are recomputed. 0 disables them.
     *
     * The rollup is what the cost dashboard reads; enforcement never does, so a
     * stale or disabled rollup can make a report lag but can never let spend
     * past a limit.
     */
    USAGE_ROLLUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60_000)
      .default(5 * 60_000),

    /** How often the deadline reaper sweeps for abandoned runs. 0 disables it. */
    REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(60 * 60_000)
      .default(30_000),

    /**
     * How often due outbound webhooks are swept out of the database and onto
     * the queue. 0 disables the sweeper.
     *
     * The sweeper is the outbox half of webhook delivery: emitting an event is
     * a single database write, and this is what turns those rows into jobs. Two
     * seconds is a latency budget rather than a polling cost — the query is an
     * index scan over `(status, nextAttemptAt)` that almost always returns
     * nothing.
     *
     * Disabling it does not lose events. It stops them being *delivered*, and
     * they resume on the next sweep once it is switched back on, which is the
     * behaviour that makes this a safe knob during an incident.
     */
    WEBHOOK_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(60 * 60_000)
      .default(2_000),

    /** Deliveries turned into jobs per sweep. Bounds one tenant's burst. */
    WEBHOOK_SWEEP_BATCH: positiveInt.max(10_000).default(200),

    /**
     * Wall-clock budget for one delivery attempt.
     *
     * Short on purpose. A receiver that needs longer than ten seconds to
     * acknowledge a webhook is doing its processing inline, which is a bug in
     * their integration that a generous timeout would hide until it became an
     * outage — the correct shape is a 2xx and a background job, and the docs
     * say so.
     */
    WEBHOOK_TIMEOUT_MS: durationMs.default(10_000),

    /**
     * How long settled deliveries are kept before the sweep removes them.
     * 0 keeps them forever, which is a defensible choice and an unbounded table.
     */
    WEBHOOK_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(365)
      .default(30),

    /** How long a SIGTERM waits for in-flight jobs before forcing the exit. */
    SHUTDOWN_TIMEOUT_MS: durationMs.default(30_000),

    /**
     * The fitted confidence calibration, as the JSON document the evals harness
     * writes (`bun run evals calibrate`).
     *
     * Configuration rather than a table because it is a *release* decision: a
     * map is fitted on measured data, checked on held-out data, reviewed, and
     * deployed with the build whose answers it corrects. A knob that could
     * silently change the confidence every customer sees, with no diff and no
     * review, would be the wrong shape entirely.
     *
     * Absent leaves `Synthesis.calibratedConfidence` null, which is the honest
     * reading of "this build has not measured its own confidence yet" — the
     * evaluator's raw number is still stored and still shown.
     */
    CONFIDENCE_CALIBRATION: calibrationEnvSchema,
  })
  .refine((env) => env.EVALUATOR_TIMEOUT_MS <= env.RUN_DEADLINE_MS, {
    message:
      "EVALUATOR_TIMEOUT_MS must not exceed RUN_DEADLINE_MS — the run deadline would " +
      "abort every synthesis before its own timeout could ever fire",
    path: ["EVALUATOR_TIMEOUT_MS"],
  })
  .refine((env) => env.PER_MODEL_TIMEOUT_MS <= env.RUN_DEADLINE_MS, {
    message: "PER_MODEL_TIMEOUT_MS must not exceed RUN_DEADLINE_MS",
    path: ["PER_MODEL_TIMEOUT_MS"],
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

function parseEnv(
  source: Readonly<Record<string, string | undefined>>,
): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const report = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid worker configuration:\n${report}`);
}

export const workerConfig: WorkerEnv = parseEnv(process.env);

export { parseEnv as parseWorkerEnv };
