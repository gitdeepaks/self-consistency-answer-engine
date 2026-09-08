import { logger, metrics } from "@sce/observability"
import { QueueGetters } from "bullmq"
import { Redis } from "ioredis"
import { queueConfig } from "./env.ts"
import { CANDIDATE_QUEUE, SYNTHESIS_QUEUE, WEBHOOK_QUEUE } from "./names.ts"

/** Optional polling owns its connections; it never waits on the producer pool. */
export function startQueueTelemetry(): () => Promise<void> {
  if (queueConfig.RUN_TRANSPORT !== "redis") return async () => {}
  let stopped = false
  let pending: Promise<void> | undefined
  let connection: Redis | undefined
  const sample = async () => {
    const client = new Redis(queueConfig.REDIS_URL, {
      lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false,
      connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null,
    })
    connection = client
    client.on("error", () => {})
    const deadline = setTimeout(() => client.disconnect(), 5000)
    const queues: QueueGetters[] = []
    try {
      await client.connect()
      for (const name of [CANDIDATE_QUEUE, SYNTHESIS_QUEUE, WEBHOOK_QUEUE]) {
        if (stopped) return
        const queue = new QueueGetters(name, { connection: client, skipWaitingForReady: true, skipVersionCheck: true })
        queue.on("error", () => {})
        queues.push(queue)
        const counts = await queue.getJobCounts("wait", "active", "delayed", "failed", "waiting-children")
        const [oldest] = await queue.getJobs(["wait"], 0, 0, true)
        if (stopped) return
        for (const [state, count] of Object.entries(counts)) metrics.gauge("sce.queue.depth", count, { queue: name, state })
        metrics.gauge("sce.queue.age", oldest ? Math.max(0, Date.now() - oldest.timestamp) / 1000 : 0, { queue: name, state: "wait" })
      }
    } finally {
      clearTimeout(deadline)
      client.disconnect()
      connection = undefined
      for (const queue of queues) void queue.close().catch(() => {})
    }
  }
  const poll = () => {
    if (stopped || pending) return
    pending = sample().catch(() => {
      if (!stopped) logger.warn("Queue telemetry collection failed")
    }).finally(() => { pending = undefined })
  }
  const timer = setInterval(poll, 30000)
  timer.unref()
  poll()
  return async () => {
    stopped = true
    clearInterval(timer)
    connection?.disconnect()
    // A disconnected optional client must not hold the process's drain open.
  }
}
