import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import type { ReactElement } from "react";
import { WebhooksManager } from "@/components/settings/webhooks-manager";
import { ErrorState } from "@/components/ui/states";
import { authConfigured } from "@/env";
import { publicApi } from "@/lib/api/public";

export const metadata: Metadata = { title: "Webhooks" };

/**
 * Server-rendered, so the first paint already carries the endpoint list and the
 * recent deliveries — the whole content of the page — rather than a spinner
 * that resolves into two short lists.
 *
 * The two reads fail separately on purpose: a delivery log that could not be
 * read should not hide the endpoints that are working.
 */
export default async function WebhooksPage(): Promise<ReactElement> {
  const sce = await publicApi(async () => {
    if (!authConfigured()) return null;
    const { getToken } = await auth();
    return getToken();
  });

  if (sce === null) {
    return (
      <ErrorState
        title="Sign in to manage webhooks"
        detail="Webhook endpoints belong to a workspace, so this page needs a session."
      />
    );
  }

  const [endpoints, deliveries] = await Promise.all([
    sce.webhooks.list({ limit: 50 }).catch(() => null),
    sce.webhooks.deliveries({ limit: 25 }).catch(() => null),
  ]);

  if (endpoints === null) {
    return (
      <ErrorState
        title="Could not load your webhooks"
        detail="The API did not answer, or this credential is not allowed to read them."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Webhooks
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Be told when a run finishes, instead of polling for it. Every delivery
          is signed; verify it before you parse it.
        </p>
      </div>

      <WebhooksManager
        initialEndpoints={endpoints.data}
        initialDeliveries={deliveries?.data ?? []}
      />
    </div>
  );
}
