import { loadRootEnv } from "@sce/shared"
import { z } from "zod"

// Must run before anything below reads process.env.
loadRootEnv()

/**
 * Server configuration, parsed once at boot.
 *
 * The value of parsing here rather than coercing at the point of use is that a
 * misconfigured process refuses to start instead of accepting a request and
 * then behaving in a way nobody asked for — a zero timeout, a port that is
 * really `NaN`, a `CORS_ORIGIN` of `"true"`.
 */

const positiveInt = z.coerce.number().int().positive()
const durationMs = positiveInt.max(60 * 60_000, "duration must be under an hour")

/**
 * `CORS_ORIGIN` as an explicit list, or `*`.
 *
 * Phase 3 removes the `*` default entirely. It survives here because the API is
 * still unauthenticated, and narrowing it now would only produce a false sense
 * that the surface is protected.
 */
const corsOriginSchema = z
  .string()
  .trim()
  .default("*")
  .transform((raw) =>
    raw === "*" ? "*" : raw.split(",").map((origin) => origin.trim()).filter(Boolean),
  )
  .refine((value) => value === "*" || value.length > 0, {
    message: "CORS_ORIGIN must be `*` or a comma-separated list of origins",
  })

const serverEnvSchema = z.object({
  PORT: positiveInt.max(65_535).default(8787),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  CORS_ORIGIN: corsOriginSchema,

  /**
   * Budget for the whole run, written onto the row at creation.
   *
   * The API sets it and the worker enforces it, so a run's deadline is a
   * property of the run rather than of whichever worker happens to pick it up —
   * which is what makes it survive a redelivery to a differently-configured
   * machine.
   */
  RUN_DEADLINE_MS: durationMs.default(10 * 60_000),

  /** Per-run ceilings stamped onto the row. Zero means "no ceiling". */
  RUN_MAX_TOTAL_TOKENS: z.coerce.number().int().nonnegative().default(400_000),
  RUN_MAX_COST_MICRO_CENTS: z.coerce.number().int().nonnegative().default(50 * 1_000_000),

  /**
   * Run the worker inside the API process.
   *
   * For a single-machine deployment, and for `RUN_TRANSPORT=local`. Loaded with
   * a dynamic import so the provider SDKs stay out of the API image whenever it
   * is off, which is the normal case.
   */
  EMBED_WORKER: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** How long a SIGTERM waits for in-flight requests before forcing the exit. */
  SHUTDOWN_TIMEOUT_MS: durationMs.default(20_000),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

function parseEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source)
  if (parsed.success) return parsed.data

  const report = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  throw new Error(`Invalid server configuration:\n${report}`)
}

const env = parseEnv(process.env)

/**
 * The typed configuration the rest of the package reads.
 *
 * Named fields rather than the raw env names, so a rename of an environment
 * variable is a change to this file alone.
 */
export const config = {
  port: env.PORT,
  hostname: env.HOST,
  corsOrigin: env.CORS_ORIGIN,
  runDeadlineMs: env.RUN_DEADLINE_MS,
  runMaxTotalTokens: env.RUN_MAX_TOTAL_TOKENS,
  runMaxCostMicroCents: env.RUN_MAX_COST_MICRO_CENTS,
  embedWorker: env.EMBED_WORKER,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
} as const

export { parseEnv as parseServerEnv }
