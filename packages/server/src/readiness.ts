import { prisma } from "@sce/db"
import { createRedis, queueConfig } from "@sce/queue"
import { logger, withSpan } from "@sce/observability"

let checking: Promise<boolean> | undefined
let draining = false
export function markDraining(): void { draining = true }

/** Single-flight avoids accumulating database work during a dependency outage. */
export async function isReady(): Promise<boolean> {
  if (draining) return false
  checking ??= withSpan("readiness.dependencies", {}, async () => {
    const connection = queueConfig.RUN_TRANSPORT === "redis" ? createRedis() : undefined
    const deadline = setTimeout(() => connection?.disconnect(), 1800)
    try {
      await Promise.all([prisma.$queryRaw`SELECT 1`, connection?.ping()])
      return true
    } catch {
      logger.warn("Readiness dependency check failed")
      return false
    } finally {
      connection?.disconnect()
      clearTimeout(deadline)
    }
  }).finally(() => { checking = undefined })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([checking, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])
  } finally {
    clearTimeout(timer)
  }
}
