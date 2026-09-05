"use client";

import {
  WEBHOOK_EVENT_TYPES,
  isSceApiError,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@sce/sdk";
import { useAuth } from "@clerk/nextjs";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { authConfigured } from "@/env";
import { publicApi } from "@/lib/api/public";
import { when } from "@/lib/format";

/**
 * Webhook endpoints, and the log of what was delivered to them.
 *
 * The delivery log is the reason this page exists. Without it, "my webhook is
 * not firing" has two indistinguishable explanations — we never sent it, or
 * your server rejected it — and answering that question requires somebody with
 * access to a server log. With it, the person whose integration is broken can
 * see the attempt, the status their own server returned and the body it
 * returned with, and fix it themselves.
 *
 * The secret is revealed exactly once, in a modal that has to be dismissed
 * deliberately, for the same reason an API key is: it is not recoverable, and a
 * value that scrolls past in a list is a value somebody loses.
 */

const STATUS_TONE = {
  DELIVERED: "success",
  PENDING: "warning",
  FAILED: "danger",
} as const;

export function WebhooksManager({
  initialEndpoints,
  initialDeliveries,
}: {
  initialEndpoints: readonly WebhookEndpoint[];
  initialDeliveries: readonly WebhookDelivery[];
}): ReactElement {
  const { getToken } = useAuth();

  const client = useCallback(
    async () => publicApi(async () => (authConfigured() ? getToken() : null)),
    [getToken],
  );

  const [endpoints, setEndpoints] =
    useState<readonly WebhookEndpoint[]>(initialEndpoints);
  const [deliveries, setDeliveries] =
    useState<readonly WebhookDelivery[]>(initialDeliveries);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [subscribed, setSubscribed] =
    useState<readonly WebhookEventType[]>(WEBHOOK_EVENT_TYPES);
  const [revealed, setRevealed] = useState<{
    secret: string;
    endpoint: WebhookEndpoint;
  } | null>(null);

  /**
   * One place that turns a failure into a sentence.
   *
   * `SceApiError` keeps the machine-readable body, so a validation failure can
   * name the field rather than saying "that did not work" — which is the whole
   * point of the SDK preserving `details` instead of collapsing everything into
   * `new Error("Request failed")`.
   */
  const describe = (caught: unknown, fallback: string): string => {
    if (isSceApiError(caught)) {
      const field = caught.details?.fields?.[0];
      return field === undefined
        ? caught.message
        : `${field.path}: ${field.message}`;
    }
    return caught instanceof Error ? caught.message : fallback;
  };

  const refreshDeliveries = useCallback(async (): Promise<void> => {
    const sce = await client();
    if (sce === null) return;
    const page = await sce.webhooks.deliveries({ limit: 25 }).catch(() => null);
    if (page !== null) setDeliveries(page.data);
  }, [client]);

  // Deliveries settle seconds after a run does, so a page opened while one is
  // in flight would otherwise show a stale list until somebody reloaded.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshDeliveries();
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, [refreshDeliveries]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const sce = await client();
      if (sce === null) throw new Error("Not signed in");

      const created = await sce.webhooks.create({
        url: url.trim(),
        ...(description.trim() === ""
          ? {}
          : { description: description.trim() }),
        eventTypes: [...subscribed],
      });

      setEndpoints((current) => [created.endpoint, ...current]);
      setCreating(false);
      setUrl("");
      setDescription("");
      setSubscribed(WEBHOOK_EVENT_TYPES);
      setRevealed({ secret: created.secret, endpoint: created.endpoint });
    } catch (caught: unknown) {
      setError(describe(caught, "Could not register the endpoint"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (endpointId: string): Promise<void> => {
    setError(null);
    const previous = endpoints;
    setEndpoints((current) =>
      current.filter((endpoint) => endpoint.id !== endpointId),
    );
    try {
      const sce = await client();
      if (sce === null) throw new Error("Not signed in");
      await sce.webhooks.delete(endpointId);
    } catch (caught: unknown) {
      setError(describe(caught, "Could not delete the endpoint"));
      setEndpoints(previous);
    }
  };

  const enable = async (endpointId: string): Promise<void> => {
    setError(null);
    try {
      const sce = await client();
      if (sce === null) throw new Error("Not signed in");
      const enabled = await sce.webhooks.enable(endpointId);
      setEndpoints((current) =>
        current.map((endpoint) =>
          endpoint.id === endpointId ? enabled : endpoint,
        ),
      );
    } catch (caught: unknown) {
      setError(describe(caught, "Could not re-enable the endpoint"));
    }
  };

  const replay = async (deliveryId: string): Promise<void> => {
    setError(null);
    try {
      const sce = await client();
      if (sce === null) throw new Error("Not signed in");
      const replayed = await sce.webhooks.replay(deliveryId);
      setDeliveries((current) =>
        current.map((delivery) =>
          delivery.id === deliveryId ? replayed : delivery,
        ),
      );
    } catch (caught: unknown) {
      setError(describe(caught, "Could not replay the delivery"));
    }
  };

  return (
    <div className="space-y-4">
      {error !== null && <ErrorState detail={error} />}

      <Panel>
        <PanelHeader
          title="Endpoints"
          description="Your servers, told when a run finishes — so an integration does not have to poll for minutes."
          actions={
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus aria-hidden="true" />
              Add endpoint
            </Button>
          }
        />

        {endpoints.length === 0 ? (
          <EmptyState
            icon={<Webhook aria-hidden="true" />}
            title="No endpoints yet"
            description="Register a URL and we will POST a signed event to it whenever a run completes or fails."
          />
        ) : (
          <ul className="divide-y divide-line">
            {endpoints.map((endpoint) => (
              <li
                key={endpoint.id}
                className="flex flex-wrap items-start gap-3 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-ink">
                    {endpoint.url}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {endpoint.description ?? "No description"} ·{" "}
                    {endpoint.eventTypes.join(", ")}
                  </p>
                  {endpoint.disabledAt !== null && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                      <AlertTriangle
                        aria-hidden="true"
                        className="mt-px size-3.5 shrink-0"
                      />
                      <span>
                        {endpoint.disabledReason ??
                          "Disabled after repeated failures"}
                      </span>
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {endpoint.disabledAt === null ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="danger">Disabled</Badge>
                  )}
                  {endpoint.disabledAt !== null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void enable(endpoint.id);
                      }}
                    >
                      Re-enable
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${endpoint.url}`}
                    onClick={() => {
                      void remove(endpoint.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="Recent deliveries"
          description="What we sent, and what your server said back. The first place to look when an integration is not firing."
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void refreshDeliveries();
              }}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          }
        />

        {deliveries.length === 0 ? (
          <EmptyState
            title="Nothing delivered yet"
            description="Deliveries appear here within a second or two of a run finishing."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-ink-muted">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Event
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Response
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td className="px-5 py-2.5 font-mono text-xs text-ink">
                      {delivery.eventType}
                    </td>
                    <td className="px-5 py-2.5">
                      <Badge tone={STATUS_TONE[delivery.status]}>
                        {delivery.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-2.5 tabular-nums text-ink-muted">
                      {delivery.attempts}
                    </td>
                    <td className="max-w-xs truncate px-5 py-2.5 text-xs text-ink-muted">
                      {delivery.responseStatus ?? "—"}
                      {delivery.lastError !== null &&
                        ` · ${delivery.lastError}`}
                    </td>
                    <td className="px-5 py-2.5 text-xs text-ink-muted">
                      {when(delivery.createdAt)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {delivery.status !== "PENDING" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void replay(delivery.id);
                          }}
                        >
                          Replay
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog
        open={creating}
        title="Add a webhook endpoint"
        onClose={() => {
          setCreating(false);
        }}
      >
        <div className="space-y-4">
          <Field
            label="URL"
            hint="Must be https outside development. We never follow redirects — a 30x is treated as a failed delivery."
          >
            {({ controlId }) => (
              <TextInput
                id={controlId}
                value={url}
                inputMode="url"
                maxLength={2000}
                placeholder="https://your-app.example/hooks/sce"
                onChange={(event) => {
                  setUrl(event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Description"
            hint="Optional. So a workspace with five endpoints stays navigable."
          >
            {({ controlId }) => (
              <TextInput
                id={controlId}
                value={description}
                maxLength={200}
                placeholder="Production order pipeline"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </Field>

          <fieldset>
            <legend className="text-sm font-medium text-ink">Events</legend>
            <div className="mt-2 space-y-2">
              {WEBHOOK_EVENT_TYPES.map((eventType) => (
                <label
                  key={eventType}
                  className="flex items-center gap-2 text-sm text-ink-muted"
                >
                  <input
                    type="checkbox"
                    className="size-4 rounded border-line"
                    checked={subscribed.includes(eventType)}
                    onChange={(event) => {
                      setSubscribed((current) =>
                        event.target.checked
                          ? [...current, eventType]
                          : current.filter((entry) => entry !== eventType),
                      );
                    }}
                  />
                  <code className="font-mono text-xs">{eventType}</code>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setCreating(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || url.trim() === "" || subscribed.length === 0}
              onClick={() => {
                void create();
              }}
            >
              {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
              Register
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revealed !== null}
        title="Copy your signing secret"
        onClose={() => {
          setRevealed(null);
        }}
      >
        {revealed !== null && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              This is the only time this secret is shown. Store it now —
              verifying it on every delivery is the only thing that
              distinguishes an event from us from a POST by somebody who read
              our documentation.
            </p>

            <div className="flex items-center gap-2 rounded-[--radius-panel] border border-line bg-surface-sunken px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {revealed.secret}
              </code>
              <CopyButton value={revealed.secret} label="Copy signing secret" />
            </div>

            <p className="flex items-start gap-1.5 text-xs text-ink-muted">
              <CheckCircle2
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0 text-success"
              />
              <span>
                Verify with{" "}
                <code className="font-mono">verifyWebhookSignature</code> from{" "}
                <code className="font-mono">@sce/sdk</code>, which checks the
                raw body, the timestamp and the signature in constant time.
              </span>
            </p>

            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setRevealed(null);
                }}
              >
                I have stored it
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
