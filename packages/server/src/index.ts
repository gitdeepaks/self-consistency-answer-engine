import { disconnect } from "@sce/db"
import { closeRedis, pingRedis, queueConfig, runQueue } from "@sce/queue"
import {
  describeError,
  formatMicroCentsUsd,
  resolveEvaluatorAvailability,
  resolvePanelAvailability,
} from "@sce/shared"
import { app } from "./app.ts"
import { config } from "./env.ts"

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

  console.log("Self-Consistency Answer Engine — API")
  console.log(`  transport  ${queueConfig.RUN_TRANSPORT}${config.embedWorker ? " (worker embedded)" : ""}`)
  for (const provider of panel) {
    const state = provider.route ? `ready via ${provider.route}` : "UNAVAILABLE"
    console.log(
      `  panel      ${provider.spec.label.padEnd(8)} ${provider.modelId.padEnd(22)} ${state}`,
    )
  }
  console.log(
    `  evaluator  ${evaluator.spec.label.padEnd(8)} ${evaluator.modelId.padEnd(22)} ${
      evaluator.route ? `ready via ${evaluator.route}` : "UNAVAILABLE"
    }`,
  )
  // The spend controls, printed at boot for the same reason the worker prints
  // its budgets: the number that will refuse a customer at 3am should not have
  // to be reconstructed from environment variables during the incident.
  console.log(
    `  spend cap  ${
      config.budget.globalDailyMicroCents === 0
        ? "disabled — nothing bounds install-wide spend"
        : `${formatMicroCentsUsd(config.budget.globalDailyMicroCents, 2)}/day, install-wide`
    }`,
  )
  console.log(
    `  limits     ${
      config.rateLimit.enabled
        ? `${config.rateLimit.runsPerWindow} runs / ${config.rateLimit.readsPerWindow} reads per ` +
          `${Math.round(config.rateLimit.windowMs / 1000)}s per credential`
        : "rate limiting disabled"
    }  ·  grace ${config.billing.gracePeriodDays}d`,
  )

  if (!panel.some((provider) => provider.route !== null)) {
    console.warn(
      "\n  No provider credentials found. Runs will be created and then fail immediately.\n",
    )
  }
}

/** Shutdown steps registered by whatever this process actually started. */
const teardown: (() => Promise<void>)[] = []

await preflight()

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
  console.log(`[server] ${signal} received; draining…`)

  const guard = setTimeout(() => {
    console.error(`[server] drain exceeded ${config.shutdownTimeoutMs}ms; exiting anyway`)
    process.exit(1)
  }, config.shutdownTimeoutMs)
  guard.unref?.()

  void (async () => {
    try {
      for (const step of teardown.reverse()) await step()
      await runQueue().close()
      await closeRedis()
      await disconnect()
      clearTimeout(guard)
      console.log("[server] drained")
      process.exit(0)
    } catch (error) {
      console.error("[server] shutdown failed", { error: describeError(error) })
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
