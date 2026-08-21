import { loadRootEnv } from "@sce/shared"

// Must run before anything below reads process.env.
loadRootEnv()

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const config = {
  port: num("PORT", 8787),
  hostname: process.env.HOST ?? "0.0.0.0",

  /** Wall-clock budget for a single panel member. */
  perModelTimeoutMs: num("PER_MODEL_TIMEOUT_MS", 120_000),
  /** Wall-clock budget for the evaluator pass. */
  evaluatorTimeoutMs: num("EVALUATOR_TIMEOUT_MS", 180_000),

  maxOutputTokens: num("MAX_OUTPUT_TOKENS", 4_000),
  /** Retries the AI SDK performs per model call before giving up. */
  maxRetries: num("MAX_RETRIES", 2),

  /** How long finished run event buffers stay replayable. */
  eventBufferTtlMs: num("EVENT_BUFFER_TTL_MS", 10 * 60_000),

  corsOrigin: process.env.CORS_ORIGIN ?? "*",
} as const
