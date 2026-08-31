import type { Metadata } from "next";
import type { ReactElement } from "react";
import { Composer } from "@/components/ask/composer";
import { ErrorState } from "@/components/ui/states";
import { serverApi } from "@/lib/api/server";

export const metadata: Metadata = { title: "Ask" };

/**
 * The composer page.
 *
 * Server-rendered, so the panel and the plan are already on the page at first
 * paint — a composer that flashes an empty model list and then fills it in is
 * a composer people start typing into before they can see what it will cost.
 *
 * The two requests are issued together rather than in sequence: they are
 * independent, and waiting for one before starting the other would double the
 * time to first byte for no reason.
 */
export default async function AskPage(): Promise<ReactElement> {
  const api = serverApi();

  const [panel, billing] = await Promise.all([
    api.getProviders().catch(() => null),
    api.getBilling().catch(() => null),
  ]);

  if (panel === null) {
    return (
      <ErrorState
        title="The API is not reachable"
        detail="The panel could not be loaded, so there is nothing to ask yet. Check that the API is running and that NEXT_PUBLIC_API_URL points at it."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Ask the panel
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every model answers independently. An evaluator then merges the
          strongest parts into one answer and tells you where they disagreed.
        </p>
      </div>

      <Composer
        panel={panel.panel}
        evaluatorModel={panel.evaluator.model}
        // A billing lookup that failed must not silently unlock a paid
        // capability, so the fallback is the most restrictive plan rather than
        // the most permissive. The API refuses it independently either way.
        plan={billing?.plan ?? "free"}
      />
    </div>
  );
}
