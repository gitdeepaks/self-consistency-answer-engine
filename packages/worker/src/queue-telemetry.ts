import { logger, metrics } from "@sce/observability";
import { candidateQueueHandle, synthesisQueueHandle, webhookQueueHandle } from "@sce/queue";

/** One bounded read per state and one oldest waiting job per queue. */
export async function pollQueues(): Promise<void> {
  for (const queue of [candidateQueueHandle(), synthesisQueueHandle(), webhookQueueHandle()]) {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "waiting-children");
    for (const [state, value] of Object.entries(counts)) {
      metrics.gauge("sce.queue.depth", value, { queue: queue.name, state });
    }
    const [oldest] = await queue.getJobs(["waiting"], 0, 0, true);
    metrics.gauge("sce.queue.age", oldest ? Math.max(0, Date.now() - oldest.timestamp) / 1000 : 0, { queue: queue.name });
  }
}

export function startQueueTelemetry(): { stop(): Promise<void> } {
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = pollQueues()
      .catch(() => { logger.error("[worker] queue telemetry poll failed"); })
      .finally(() => { pending = null; });
  }, 15_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}
