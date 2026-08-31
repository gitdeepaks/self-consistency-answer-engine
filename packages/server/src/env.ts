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

const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development")

/**
 * `CORS_ORIGIN` as an explicit list, or `*`.
 *
 * The wildcard is now a development-only convenience: the API serves
 * tenant-scoped data to authenticated callers, so an origin allowlist is part
 * of the boundary rather than decoration on it. `refineCors` below rejects `*`
 * anywhere but development, and does it at boot — a misconfigured production
 * deploy fails to start rather than serving every origin until somebody notices.
 */
const corsOriginSchema = z
  .string()
  .trim()
  .default("*")
  .transform((raw) =>
    raw === "*"
      ? "*"
      : raw
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
  )
  .refine((value) => value === "*" || value.length > 0, {
    message: "CORS_ORIGIN must be `*` or a comma-separated list of origins",
  })

/**
 * Clerk credentials.
 *
 * All optional, and the reason is deliberate: an install that has not connected
 * Clerk yet still authenticates API keys, which is everything CI and the SDK
 * need. What it cannot do is accept a session or an OAuth token, and
 * `clerkConfigured()` is what the auth layer checks before telling a caller so
 * in as many words. Half-configured is the dangerous state, so the shapes are
 * checked here: a publishable key in the secret key's slot fails at boot.
 */
const clerkSecretKeySchema = z
  .string()
  .trim()
  .regex(/^sk_(test|live)_[A-Za-z0-9]+$/, "CLERK_SECRET_KEY must look like sk_test_… or sk_live_…")
  .optional()

const clerkPublishableKeySchema = z
  .string()
  .trim()
  .regex(
    /^pk_(test|live)_[A-Za-z0-9+/=]+$/,
    "CLERK_PUBLISHABLE_KEY must look like pk_test_… or pk_live_…",
  )
  .optional()

const clerkWebhookSecretSchema = z
  .string()
  .trim()
  .regex(/^whsec_[A-Za-z0-9+/=]+$/, "CLERK_WEBHOOK_SIGNING_SECRET must look like whsec_…")
  .optional()

const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
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
   * Grace period granted when a payment fails, in days.
   *
   * Dunning, not deletion: a `PAST_DUE` tenant keeps working until this runs
   * out, and then goes read-only — every run they have ever made stays
   * readable. Zero means a failed payment restricts access immediately, which
   * is legal but hostile; the default is a week.
   */
  BILLING_GRACE_PERIOD_DAYS: z.coerce.number().int().nonnegative().max(90).default(7),

  /**
   * Hard ceiling on what the whole install may spend in one UTC day, in
   * micro-cents (1e-8 USD).
   *
   * This is the blast-radius control that per-tenant quotas cannot be: a bug
   * that fans out a thousand runs, or a leaked key used by fifty machines, has
   * nothing to do with any single plan. Reaching it engages a persisted kill
   * switch that refuses new runs until an operator releases it.
   *
   * Zero disables the cap. That is allowed — some installs meter spend
   * elsewhere — but it is announced at boot, because an install with no ceiling
   * anywhere is one bug away from an unbounded invoice.
   */
  GLOBAL_DAILY_BUDGET_MICRO_CENTS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(250 * 100 * 1_000_000),

  /**
   * How long today's global spend figure is cached before it is re-read.
   *
   * The cost of caching is bounded overshoot — at most one window's worth of
   * spend past the cap — and the cost of not caching is an aggregate over every
   * metering row written today, on every single `POST /runs`.
   */
  GLOBAL_BUDGET_REFRESH_MS: positiveInt.max(5 * 60_000).default(15_000),

  /** Rate limiting. `false` turns it off entirely — for tests and local work. */
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** The sliding window every budget below is measured over. */
  RATE_LIMIT_WINDOW_MS: positiveInt.max(60 * 60_000).default(60_000),

  /**
   * Per-window budgets, per credential.
   *
   * Distinct per route because the routes are not alike: `POST /runs` starts
   * model calls and `GET /runs` reads a row, so giving them one shared budget
   * either throttles reads pointlessly or lets writes through far too fast.
   */
  RATE_LIMIT_RUNS_PER_WINDOW: positiveInt.max(100_000).default(20),
  RATE_LIMIT_READS_PER_WINDOW: positiveInt.max(1_000_000).default(300),

  /**
   * Per-window budget for run creation keyed by client IP, on top of the
   * per-credential one. A single address minting keys in a loop is the shape a
   * credential-only limiter cannot see.
   */
  RATE_LIMIT_RUNS_PER_IP_PER_WINDOW: positiveInt.max(100_000).default(60),

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

  CLERK_SECRET_KEY: clerkSecretKeySchema,
  CLERK_PUBLISHABLE_KEY: clerkPublishableKeySchema,
  CLERK_WEBHOOK_SIGNING_SECRET: clerkWebhookSecretSchema,

  /**
   * The OAuth application the CLI authenticates against.
   *
   * A public client — no secret, PKCE only — so this id is not sensitive and is
   * served to clients from `GET /api/auth/config`, which is what lets `sce auth
   * login` work against any instance without its own configuration.
   */
  CLERK_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),

  /**
   * Who may reach the internal operations console, by email address.
   *
   * Install administration is a **separate axis** from tenant roles, and this
   * variable is why. An `owner` is the most senior person inside one workspace;
   * making that role also mean "operator of the whole install" would hand every
   * customer's account owner a cross-tenant view of everybody else. So operator
   * status comes from configuration — a value only somebody with deploy access
   * can set — and nothing a user, a webhook or a billing provider writes can
   * grant it.
   *
   * Empty (the default) means the console is unreachable for everyone, which is
   * the correct posture for an install that has not thought about it yet.
   */
  SCE_ADMIN_EMAILS: z
    .string()
    .trim()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    ),

  /**
   * Override for the authorization server's origin.
   *
   * Normally derived from the publishable key, which encodes the instance's
   * frontend API host. Needed only for a proxied or custom-domain setup where
   * the encoded host is not the one clients should talk to.
   */
  CLERK_OAUTH_ISSUER: z.url("CLERK_OAUTH_ISSUER must be an absolute URL").optional(),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

/**
 * The frontend API origin, decoded from the publishable key.
 *
 * A publishable key is `pk_<env>_` followed by base64 of the frontend API host
 * with a `$` terminator — the same trick every Clerk SDK uses to avoid a second
 * environment variable. It is decoded rather than trusted: a key that does not
 * decode to a plausible hostname yields null, and the OAuth endpoints are then
 * simply not advertised instead of pointing clients somewhere unintended.
 */
export function frontendApiFromPublishableKey(key: string | undefined): string | null {
  if (key === undefined) return null

  const encoded = key.replace(/^pk_(test|live)_/, "")
  if (encoded === key) return null

  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null

  return `https://${host}`
}

function parseEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source)
  if (!parsed.success) {
    const report = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid server configuration:\n${report}`)
  }

  const env = parsed.data

  // Cross-field rules, checked after parsing because each depends on more than
  // one variable. Both are boot-time failures on purpose: the failure modes
  // they prevent — a wide-open production CORS policy, an API that silently
  // cannot verify the tokens its own CLI issues — are invisible at runtime.
  if (env.CORS_ORIGIN === "*" && env.NODE_ENV === "production") {
    throw new Error(
      "Invalid server configuration:\n" +
        "  CORS_ORIGIN: `*` is not allowed in production — set an explicit " +
        "comma-separated origin allowlist",
    )
  }

  if ((env.CLERK_SECRET_KEY === undefined) !== (env.CLERK_PUBLISHABLE_KEY === undefined)) {
    throw new Error(
      "Invalid server configuration:\n" +
        "  CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY: set both or neither — a half-configured " +
        "identity provider accepts no sessions but reports no error",
    )
  }

  // Not a failure: an install may meter spend somewhere else. But an install
  // with no ceiling anywhere is one bug away from an unbounded invoice, and
  // that is worth one line on every boot rather than a surprise at month end.
  if (env.GLOBAL_DAILY_BUDGET_MICRO_CENTS === 0 && env.NODE_ENV === "production") {
    console.warn(
      "[config] GLOBAL_DAILY_BUDGET_MICRO_CENTS=0 — the install-wide daily spend cap is " +
        "disabled. Per-tenant quotas still apply; nothing bounds total spend.",
    )
  }

  return env
}

const env = parseEnv(process.env)

const frontendApi = env.CLERK_OAUTH_ISSUER ?? frontendApiFromPublishableKey(env.CLERK_PUBLISHABLE_KEY)

/**
 * The typed configuration the rest of the package reads.
 *
 * Named fields rather than the raw env names, so a rename of an environment
 * variable is a change to this file alone.
 */
export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  port: env.PORT,
  hostname: env.HOST,
  corsOrigin: env.CORS_ORIGIN,
  runDeadlineMs: env.RUN_DEADLINE_MS,
  runMaxTotalTokens: env.RUN_MAX_TOTAL_TOKENS,
  runMaxCostMicroCents: env.RUN_MAX_COST_MICRO_CENTS,
  billing: {
    gracePeriodDays: env.BILLING_GRACE_PERIOD_DAYS,
  },
  budget: {
    globalDailyMicroCents: env.GLOBAL_DAILY_BUDGET_MICRO_CENTS,
    refreshMs: env.GLOBAL_BUDGET_REFRESH_MS,
  },
  rateLimit: {
    enabled: env.RATE_LIMIT_ENABLED,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    runsPerWindow: env.RATE_LIMIT_RUNS_PER_WINDOW,
    readsPerWindow: env.RATE_LIMIT_READS_PER_WINDOW,
    runsPerIpPerWindow: env.RATE_LIMIT_RUNS_PER_IP_PER_WINDOW,
  },
  embedWorker: env.EMBED_WORKER,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  /** Operator email allowlist for the internal console. Empty means nobody. */
  adminEmails: env.SCE_ADMIN_EMAILS,
  clerk: {
    secretKey: env.CLERK_SECRET_KEY ?? null,
    publishableKey: env.CLERK_PUBLISHABLE_KEY ?? null,
    webhookSigningSecret: env.CLERK_WEBHOOK_SIGNING_SECRET ?? null,
    oauthClientId: env.CLERK_OAUTH_CLIENT_ID ?? null,
    /** Origin of the authorization server, or null when it cannot be determined. */
    issuer: frontendApi,
  },
} as const

/** Can this process verify Clerk sessions and OAuth tokens at all? */
export function clerkConfigured(): boolean {
  return config.clerk.secretKey !== null && config.clerk.publishableKey !== null
}

export { parseEnv as parseServerEnv }
