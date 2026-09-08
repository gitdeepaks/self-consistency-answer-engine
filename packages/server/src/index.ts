import { disconnect } from "@sce/db"
import { closeRedis, pingRedis, queueConfig, runQueue, webhookQueue, startQueueTelemetry } from "@sce/queue"
import { initializeTelemetry, shutdownTelemetry, logger } from "@sce/observability"
import {
  resolveEvaluatorAvailability,
  resolvePanelAvailability,
} from "@sce/shared"
import { app } from "./app.ts"
import { config } from "./env.ts"
import { markDraining } from "./readiness.ts"

export type { AppType } from "./app.ts"
export { app } from "./app.ts"
export { config } from "./env.ts"

/**
 * The API process.
 *
 * It validates, persists, enqueues and streams. It does not call a model — that
 * moved to `@sce/worker` in Phase 2 — which is what makes this process
 * stateless, restartable at any moment, and safe to run behind an autoscaler.
 */

/**
 * Fail fast on the dependencies a request will need.
 *
 * Discovering that Redis is unreachable on the first `POST /api/runs` means the
 * first user of a bad deploy pays for it. Discovering it here means the health
 * check never goes green and the deploy rolls back on its own.
 */
async function preflight(): Promise<void> {
  if (queueConfig.RUN_TRANSPORT === "redis") await pingRedis()
}

function announce(): void {
  const panel = resolvePanelAvailability()
  const evaluator = resolveEvaluatorAvailability()

  logger.info("API started", { transport: queueConfig.RUN_TRANSPORT, embeddedWorker: config.embedWorker })
  for (const provider of panel) {
    const state = provider.route ? `ready via ${provider.route}` : "UNAVAILABLE"
    logger.info("Panel availability", { provider: provider.spec.label, model: provider.modelId, state })
  }
  logger.info("Evaluator availability", { model: evaluator.modelId, available: evaluator.route !== null })
  // The spend controls, printed at boot for the same reason the worker prints
  // its budgets: the number that will refuse a customer at 3am should not have
  // to be reconstructed from environment variables during the incident.
  logger.info("Spend controls", { dailyMicroCents: config.budget.globalDailyMicroCents, rateLimitEnabled: config.rateLimit.enabled })

  if (!panel.some((provider) => provider.route !== null)) {
    logger.warn("No providers configured; runs will fail immediately")
  }
}

/** Shutdown steps registered by whatever this process actually started. */
const teardown: (() => Promise<void>)[] = []

if (import.meta.main) initializeTelemetry("sce-api")
await preflight()
if (import.meta.main) teardown.push(startQueueTelemetry())

/*
 * The embedded worker: one process serving the API and consuming the queue.
 *
 * Imported dynamically and only when asked for, so the three provider SDKs stay
 * out of the API image in the normal case — where the worker is a separate
 * fleet that scales on queue depth rather than on request rate.
 */
if (config.embedWorker || queueConfig.RUN_TRANSPORT === "local") {
  const { startWorker } = await import("@sce/worker")
  const handle = await startWorker()
  teardown.push(() => handle.shutdown())
}

announce()

/**
 * Graceful shutdown.
 *
 * A deploy must not orphan runs. For the API that means: stop the queue
 * producer, drain an embedded worker if there is one, and release the pools.
 * In-flight SSE streams end when their sockets close, and their clients
 * reconnect with a cursor — which is exactly the property the durable event log
 * was built for.
 */
let exiting = false

function shutdown(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  markDraining()
  logger.info("Server draining", { signal })

  const guard = setTimeout(() => {
    logger.error("Server drain deadline exceeded")
    process.exit(1)
  }, config.shutdownTimeoutMs)
  guard.unref?.()

  void (async () => {
    try {
      for (const step of teardown.reverse()) await step()
      await runQueue().close()
      await webhookQueue().close()
      await closeRedis()
      await disconnect()
      clearTimeout(guard)
      logger.info("Server drained")
      await shutdownTelemetry()
      process.exit(0)
    } catch (error) {
      logger.error("Server shutdown failed")
      await shutdownTelemetry().catch(() => {})
      process.exit(1)
    }
  })()
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  shutdown("SIGINT")
})

export default {
  port: config.port,
  hostname: config.hostname,
  // An SSE stream is idle by design between events; do not let Bun's default
  // request timeout cut one short while a run is thinking.
  idleTimeout: 255,
  fetch: app.fetch,
}
