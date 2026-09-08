import { metrics } from "@sce/observability";
import type { recordUsage } from "@sce/db";

export function providerCompleted(
  provider: string,
  operation: string,
  outcome: string,
  startedAt: number,
): void {
  metrics.count("sce.provider.calls", 1, { provider, operation, outcome });
  metrics.histogram("sce.provider.duration", (performance.now() - startedAt) / 1000, {
    provider, operation,
  });
}

export function usageRecorded(usage: Awaited<ReturnType<typeof recordUsage>>): void {
  const provider = usage.provider;
  metrics.count("sce.tokens", usage.inputTokens, { provider, direction: "input" });
  metrics.count("sce.tokens", usage.outputTokens, { provider, direction: "output" });
  metrics.count("sce.cost.microcents", usage.costMicroCents, { provider });
}

export function runCompleted(outcome: string, createdAt: string): void {
  metrics.count("sce.run.completed", 1, { outcome });
  metrics.histogram("sce.run.duration", Math.max(0, Date.now() - new Date(createdAt).getTime()) / 1000, { outcome });
}
