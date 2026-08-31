import { hasEntitlement, PLANS, type Feature } from "@sce/shared"
import type { Metadata } from "next"
import type { ReactElement } from "react"
import { QuotaBar } from "@/components/usage/quota-bar"
import { SpendChart } from "@/components/usage/spend-chart"
import { Badge } from "@/components/ui/badge"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/states"
import { money } from "@/lib/format"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "Usage" }

/** The capabilities worth naming on a pricing comparison, in reading order. */
const FEATURE_LABELS: Readonly<Record<Feature, string>> = {
  "panel.custom": "Choose the panel",
  "api.keys": "API keys",
  "usage.daily": "Daily spend breakdown",
  webhooks: "Webhooks",
  "priority.queue": "Priority queue",
}

/**
 * Usage, quotas and the plan.
 *
 * Everything on this page comes from `GET /api/usage` and `GET /api/billing`,
 * which serve the same `PLANS` record and the same `quotaStatuses` function the
 * API enforces with. That is the property worth protecting: a pricing table
 * that advertises a limit the API does not apply, or a usage bar that says
 * you have room when the next request will be refused, is worse than no page.
 */
export default async function UsagePage(): Promise<ReactElement> {
  const api = serverApi()

  const [usage, billing] = await Promise.all([
    api.getUsage().catch(() => null),
    api.getBilling().catch(() => null),
  ])

  if (usage === null || billing === null) {
    return (
      <ErrorState
        title="Could not load usage"
        detail="The API did not answer. Your spend is still being metered; this page just cannot show it right now."
      />
    )
  }

  // Gated on the same entitlement the API checks, so an unentitled workspace is
  // told what the feature is rather than shown an empty chart.
  const daily = hasEntitlement(usage.plan, "usage.daily")
    ? await api.getUsageDaily().catch(() => null)
    : null

  const plan = PLANS[usage.plan]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Usage</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What this workspace has spent this month, and what its plan allows.
        </p>
      </div>

      {usage.access.mode === "read-only" && (
        <ErrorState
          title="This workspace is read-only"
          detail={`${usage.access.message} Every run you have ever made stays readable.`}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="This month"
            description="Counters reset at the start of each UTC calendar month."
          />
          <PanelBody className="grid gap-5 sm:grid-cols-2">
            {usage.quotas.map((quota) => (
              <QuotaBar key={quota.limit} status={quota} />
            ))}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Plan"
            actions={<Badge tone="accent">{plan.label}</Badge>}
          />
          <PanelBody className="space-y-4">
            <div>
              <p className="font-mono text-2xl text-ink">
                {money(usage.usage.costMicroCents)}
              </p>
              <p className="text-xs text-ink-faint">
                metered across {usage.usage.calls.toLocaleString("en-US")} model calls
              </p>
            </div>

            {usage.usage.hasUnpricedCalls && (
              <p className="text-xs text-warning">
                Some calls used a model with no price on file, so this total is an
                understatement.
              </p>
            )}
            {usage.usage.hasUnverifiedPricing && !usage.usage.hasUnpricedCalls && (
              <p className="text-xs text-ink-faint">
                Some prices are unverified placeholders. Treat this as approximate until they are
                checked against the vendors&rsquo; published rates.
              </p>
            )}

            <dl className="space-y-1.5 border-t border-line pt-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Status</dt>
                <dd className="text-ink">{usage.subscription.status}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Input tokens</dt>
                <dd className="font-mono text-ink">
                  {usage.usage.inputTokens.toLocaleString("en-US")}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Output tokens</dt>
                <dd className="font-mono text-ink">
                  {usage.usage.outputTokens.toLocaleString("en-US")}
                </dd>
              </div>
            </dl>
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Spend by day"
          description={
            daily === null
              ? "A per-day, per-model breakdown is part of the Pro plan and above."
              : "Rolled up per model, so a cost spike names the model that caused it."
          }
        />
        <PanelBody>
          {daily === null ? (
            <p className="py-8 text-center text-sm text-ink-faint">
              Your plan reports a single monthly total. Upgrade to see which model spent it and on
              which day.
            </p>
          ) : (
            <SpendChart entries={daily.entries} rolledUpAt={daily.rolledUpAt} />
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Plans"
          description="Served from the same table the API enforces against, so this page cannot advertise a limit that is not applied."
        />
        <PanelBody>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">Plan comparison</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Plan
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Runs / month
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Spend ceiling
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Concurrent
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Includes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--border]">
                {billing.plans.map((entry) => (
                  <tr key={entry.id} className={entry.id === usage.plan ? "bg-accent-soft/40" : ""}>
                    <th scope="row" className="py-2.5 pr-4 text-left font-medium text-ink">
                      {entry.label}
                      {entry.id === usage.plan && (
                        <Badge tone="accent" className="ml-2">
                          Current
                        </Badge>
                      )}
                      <span className="mt-0.5 block text-xs font-normal text-ink-faint">
                        {entry.priceMicroCentsPerMonth === 0
                          ? "Free"
                          : entry.selfServe
                            ? `${money(entry.priceMicroCentsPerMonth)} / month`
                            : "Talk to us"}
                      </span>
                    </th>
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-muted">
                      {entry.limits.monthlyRuns?.toLocaleString("en-US") ?? "unlimited"}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-muted">
                      {entry.limits.monthlyCostMicroCents === null
                        ? "unlimited"
                        : money(entry.limits.monthlyCostMicroCents)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-muted">
                      {entry.limits.concurrentRuns?.toLocaleString("en-US") ?? "unlimited"}
                    </td>
                    <td className="py-2.5 text-xs text-ink-muted">
                      {entry.features.length === 0
                        ? "The core engine"
                        : entry.features.map((feature) => FEATURE_LABELS[feature]).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </div>
  )
}
