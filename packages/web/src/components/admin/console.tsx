"use client"

import type {
  AdminExperiment,
  AdminOverview,
  AdminQuality,
  AdminTenant,
  DeadLetterView,
  KillSwitch,
} from "@sce/shared"
import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react"
import Link from "next/link"
import { useState, type FormEvent, type ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { Tabs, type TabDefinition } from "@/components/ui/tabs"
import { useApi } from "@/lib/api/browser"
import { count, money, when } from "@/lib/format"

/**
 * The operations console.
 *
 * Cross-tenant by definition, which is why it lives behind a guard resolved
 * from deploy-time configuration rather than from any role a customer can hold
 * — see `admin/guard.ts` on the API for the argument.
 *
 * Deliberately shallow. It reads almost everything and writes exactly two
 * things: release the spend kill switch, and replay a dead-lettered job. Those
 * are what an incident at three in the morning actually needs. Anything more
 * destructive stays in the `ops` CLI, where it is a deliberate act at a
 * terminal rather than a button somebody can hit by accident.
 */

type TabId = "overview" | "tenants" | "quality" | "dlq"

export function AdminConsole({ initial }: { initial: AdminOverview }): ReactElement {
  const api = useApi()
  const [tab, setTab] = useState<TabId>("overview")
  const [overview, setOverview] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setOverview(await api.adminOverview())
      setError(null)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not refresh")
    }
  }

  const tabs: readonly TabDefinition<TabId>[] = [
    { id: "overview", label: "Overview" },
    { id: "tenants", label: "Workspaces", hint: count(overview.tenantCount) },
    { id: "quality", label: "Quality" },
    {
      id: "dlq",
      label: "Dead letters",
      hint: overview.deadLetters > 0 ? String(overview.deadLetters) : undefined,
    },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Operations</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every workspace on this install. Read-only, apart from the spend guard and the queue.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error !== null && <ErrorState detail={error} />}

      <Tabs tabs={tabs} active={tab} onChange={setTab}>
        {tab === "overview" && <Overview overview={overview} onChange={setOverview} />}
        {tab === "tenants" && <Tenants />}
        {tab === "quality" && <Quality />}
        {tab === "dlq" && <DeadLetters onReplayed={() => void refresh()} />}
      </Tabs>
    </div>
  )
}

function Overview({
  overview,
  onChange,
}: {
  overview: AdminOverview
  onChange: (next: AdminOverview) => void
}): ReactElement {
  const api = useApi()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const release = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.adminReleaseBudget(reason.trim())
      onChange({ ...overview, budget: result.budget })
      setReason("")
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not release the guard")
    } finally {
      setBusy(false)
    }
  }

  const { budget } = overview
  const spentPercent =
    budget.capMicroCents === 0
      ? null
      : Math.min(100, Math.round((budget.spentMicroCents / budget.capMicroCents) * 100))

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Spend today" value={money(budget.spentMicroCents)} />
        <Stat
          label="Daily cap"
          value={budget.capMicroCents === 0 ? "None set" : money(budget.capMicroCents)}
          tone={budget.capMicroCents === 0 ? "warning" : undefined}
        />
        <Stat label="Runs in flight" value={count(overview.activeRuns)} />
        <Stat
          label="Dead letters"
          value={count(overview.deadLetters)}
          tone={overview.deadLetters > 0 ? "danger" : undefined}
        />
      </div>

      {budget.capMicroCents === 0 && (
        <ErrorState
          title="No install-wide spend cap is set"
          detail="Per-tenant quotas still apply, but nothing bounds total spend. Set GLOBAL_DAILY_BUDGET_MICRO_CENTS on the API."
        />
      )}

      <Panel>
        <PanelHeader
          title="Spend guard"
          description="The install-wide stop. It trips by itself when the daily cap is reached, and only a person releases it."
          actions={
            <Badge tone={budget.killSwitch.engaged ? "danger" : "success"}>
              {budget.killSwitch.engaged ? "Engaged — runs refused" : "Clear"}
            </Badge>
          }
        />
        <PanelBody className="space-y-4">
          {spentPercent !== null && (
            <div className="space-y-1.5">
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="meter"
                aria-valuenow={spentPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Daily budget used"
              >
                <div
                  className={spentPercent >= 90 ? "h-full bg-danger" : spentPercent >= 70 ? "h-full bg-warning" : "h-full bg-accent"}
                  style={{ width: `${spentPercent}%` }}
                />
              </div>
              <p className="text-xs text-ink-faint">
                {spentPercent}% of today&rsquo;s cap used, measured since{" "}
                {new Date(budget.since).toLocaleString("en-GB")}.
              </p>
            </div>
          )}

          {budget.killSwitch.engaged ? (
            <KillSwitchRelease
              killSwitch={budget.killSwitch}
              reason={reason}
              setReason={setReason}
              busy={busy}
              onRelease={() => void release()}
              error={error}
            />
          ) : (
            <p className="text-sm text-ink-muted">
              Nothing is stopped. New runs are being accepted normally.
            </p>
          )}
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Queues" description="Depth and health, per queue." />
          <PanelBody className="p-0">
            {overview.queues.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-faint">
                The queue could not be reached. Redis may be down — which is worth checking before
                anything else on this page.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th scope="col" className="px-5 py-2 font-medium">Queue</th>
                    <th scope="col" className="px-2 py-2 font-medium">Waiting</th>
                    <th scope="col" className="px-2 py-2 font-medium">Active</th>
                    <th scope="col" className="px-2 py-2 font-medium">Delayed</th>
                    <th scope="col" className="px-5 py-2 font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[--border] font-mono text-xs">
                  {overview.queues.map((queue) => (
                    <tr key={queue.queue}>
                      <td className="px-5 py-2 font-sans text-ink">{queue.queue}</td>
                      <td className="px-2 py-2 text-ink-muted">{queue.waiting}</td>
                      <td className="px-2 py-2 text-ink-muted">{queue.active}</td>
                      <td className="px-2 py-2 text-ink-muted">{queue.delayed}</td>
                      <td className={`px-5 py-2 ${queue.failed > 0 ? "text-danger" : "text-ink-muted"}`}>
                        {queue.failed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Today's biggest spenders" description="By metered cost since midnight UTC." />
          <PanelBody className="p-0">
            {overview.topSpenders.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-faint">Nothing has been metered today.</p>
            ) : (
              <ul className="divide-y divide-[--border]">
                {overview.topSpenders.map((tenant) => (
                  <li key={tenant.tenantId} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span className="truncate font-mono text-xs text-ink">{tenant.slug}</span>
                    <span className="flex shrink-0 items-center gap-3 text-xs">
                      <span className="text-ink-faint">{count(tenant.calls)} calls</span>
                      <span className="font-mono text-ink">{money(tenant.costMicroCents)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}

function KillSwitchRelease({
  killSwitch,
  reason,
  setReason,
  busy,
  onRelease,
  error,
}: {
  killSwitch: KillSwitch
  reason: string
  setReason: (value: string) => void
  busy: boolean
  onRelease: () => void
  error: string | null
}): ReactElement {
  return (
    <div className="space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-danger">
        <AlertTriangle className="size-4" aria-hidden="true" />
        New runs are being refused across every workspace
      </p>
      <p className="text-xs text-ink-muted">
        {killSwitch.reason ?? "No reason was recorded."}
        {killSwitch.engagedAt !== null && ` Engaged ${when(killSwitch.engagedAt)}.`}
      </p>
      <p className="text-xs text-ink-muted">
        Nothing releases this on a timer, and that is deliberate: whatever spent the money is still
        there until somebody has looked. Say what you found — it goes in the audit log, which the
        next incident cannot overwrite.
      </p>

      <Field label="Why is it safe to resume?">
        {({ controlId }) => (
          <TextInput
            id={controlId}
            value={reason}
            minLength={3}
            maxLength={500}
            placeholder="Runaway retry loop in the nightly eval job, fixed in #482 and redeployed."
            onChange={(event) => {
              setReason(event.target.value)
            }}
          />
        )}
      </Field>

      {error !== null && <p className="text-xs text-danger">{error}</p>}

      <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={onRelease}>
        {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
        Release the spend guard
      </Button>
    </div>
  )
}

function Tenants(): ReactElement {
  const api = useApi()
  const [term, setTerm] = useState("")
  const [tenants, setTenants] = useState<readonly AdminTenant[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.adminTenants(term.trim().length > 0 ? { q: term.trim() } : {})
      setTenants(result.tenants)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Lookup failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void search(event)} className="flex gap-2">
        <Field label="Find a workspace" labelHidden className="flex-1">
          {({ controlId }) => (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                aria-hidden="true"
              />
              <TextInput
                id={controlId}
                value={term}
                onChange={(event) => {
                  setTerm(event.target.value)
                }}
                placeholder="Slug, id, or part of a name — blank for the newest"
                className="pl-9"
              />
            </div>
          )}
        </Field>
        <Button type="submit" variant="secondary" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Look up
        </Button>
      </form>

      {error !== null && <ErrorState detail={error} />}

      {tenants === null ? (
        <EmptyState
          title="Search for a workspace"
          description="Leave the box empty and press Look up to see the most recently created ones."
        />
      ) : tenants.length === 0 ? (
        <EmptyState title="No workspace matches that" />
      ) : (
        <Panel>
          <PanelBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th scope="col" className="px-5 py-2 font-medium">Workspace</th>
                    <th scope="col" className="px-2 py-2 font-medium">Plan</th>
                    <th scope="col" className="px-2 py-2 font-medium">Access</th>
                    <th scope="col" className="px-2 py-2 font-medium">Members</th>
                    <th scope="col" className="px-2 py-2 font-medium">Runs</th>
                    <th scope="col" className="px-5 py-2 font-medium">Spend (30d)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[--border]">
                  {tenants.map((tenant) => (
                    <tr key={tenant.id}>
                      <td className="px-5 py-2.5">
                        <span className="block text-ink">{tenant.name}</span>
                        <span className="block font-mono text-xs text-ink-faint">{tenant.slug}</span>
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone="neutral">{tenant.plan}</Badge>
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone={tenant.access.mode === "full" ? "success" : "warning"}>
                          {tenant.access.mode}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs text-ink-muted">
                        {tenant.memberCount}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs text-ink-muted">
                        {count(tenant.runCount)}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink">
                        {money(tenant.costMicroCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PanelBody>
        </Panel>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- quality */

/**
 * The answer-quality panel.
 *
 * Three questions an operator asks about the engine rather than about a
 * customer: is the experiment saying anything yet, is the cache paying for
 * itself, and does the confidence number mean anything. Every figure is an
 * aggregate across the install — no prompt and no answer body reaches this
 * page, which is why it can be cross-tenant at all.
 */
function Quality(): ReactElement {
  const api = useApi()
  const [days, setDays] = useState(14)
  const [report, setReport] = useState<AdminQuality | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (window: number): Promise<void> => {
    try {
      setReport(await api.adminQuality(window))
      setError(null)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not load the quality report")
    }
  }

  if (report === null) {
    return (
      <div className="space-y-3">
        {error !== null && <ErrorState detail={error} />}
        <EmptyState
          title="Answer quality"
          description="Experiment arms, answer-cache savings, and whether the confidence number tracks reality."
          action={
            <Button variant="secondary" onClick={() => void load(days)}>
              Load
            </Button>
          }
        />
      </div>
    )
  }

  const cache = report.cache

  return (
    <div className="space-y-5">
      {error !== null && <ErrorState detail={error} />}

      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30, 90].map((window) => (
          <Button
            key={window}
            size="sm"
            variant={days === window ? "primary" : "secondary"}
            onClick={() => {
              setDays(window)
              void load(window)
            }}
          >
            {window}d
          </Button>
        ))}
        <span className="text-xs text-ink-faint">
          generated {when(report.generatedAt)}
        </span>
      </div>

      <Panel>
        <PanelHeader
          title="Answer cache"
          description="Runs served from an earlier answer instead of a fresh panel."
        />
        <PanelBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label="Hit rate" value={`${(cache.hitRate * 100).toFixed(1)}%`} />
            <Figure label="Hits" value={count(cache.cacheHits)} />
            <Figure label="Runs" value={count(cache.runs)} />
            <Figure
              label="Estimated saving"
              value={money(cache.estimatedSavedMicroCents)}
              hint={`at ${money(cache.meanGeneratedCostMicroCents)} per generated run`}
            />
          </dl>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Confidence calibration"
          description="Claimed confidence against the thumbs people actually gave. A weak signal, continuously available — the judged measurement comes from the eval harness."
        />
        <PanelBody className="space-y-3">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure
              label="Calibration error"
              value={report.calibration.expectedCalibrationError.toFixed(3)}
            />
            <Figure label="Brier score" value={report.calibration.brierScore.toFixed(3)} />
            <Figure label="Base rate" value={`${(report.calibration.baseRate * 100).toFixed(1)}%`} />
            <Figure label="Rated answers" value={count(report.calibration.sampleSize)} />
          </dl>

          {report.calibration.sampleSize === 0 ? (
            <p className="text-sm text-ink-muted">
              Nobody has rated an answer in this window, so there is nothing to calibrate against.
            </p>
          ) : (
            <div className="space-y-1.5">
              {report.calibration.bins
                .filter((bin) => bin.count > 0)
                .map((bin) => (
                  <div key={bin.lower} className="flex items-center gap-3 text-xs">
                    <span className="w-20 font-mono text-ink-faint">
                      {bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}
                    </span>
                    <span className="w-14 text-right text-ink-muted">{count(bin.count)}</span>
                    <div className="flex-1">
                      <Bar label="claimed" value={bin.meanConfidence} tone="bg-ink-faint" />
                      <Bar label="actual" value={bin.accuracy} tone="bg-accent" />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Experiments"
          description="Panel A/B tests, assigned by workspace so one customer sees one consistent panel."
        />
        <PanelBody className="space-y-4">
          {report.experiments.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No experiments are configured. Set <code>PANEL_EXPERIMENTS</code> on the API to start
              one.
            </p>
          ) : (
            report.experiments.map((experiment) => (
              <ExperimentArms key={experiment.id} experiment={experiment} />
            ))
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Panels"
          description="Every registered panel, resolved to the models this install would actually call."
        />
        <PanelBody className="space-y-3">
          {report.panels.map((panel) => (
            <div key={panel.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{panel.label}</span>
                <span className="font-mono text-xs text-ink-faint">{panel.id}</span>
                {panel.isDefault && <Badge tone="success">default</Badge>}
                <Badge tone="neutral">{panel.promptSetId}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-muted">{panel.description}</p>
              <p className="mt-2 font-mono text-xs text-ink-faint">
                {panel.seats.map((seat) => `${seat.label} (${seat.model})`).join(" · ")} → judged by{" "}
                {panel.evaluator.model}
              </p>
            </div>
          ))}
        </PanelBody>
      </Panel>
    </div>
  )
}

/**
 * One number in a metric row.
 *
 * Distinct from `Stat` below, which wraps its number in its own Panel for the
 * overview grid. These sit inside a panel already, so a second border around
 * each would read as four cards inside one card.
 */
function Figure({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): ReactElement {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{value}</dd>
      {hint !== undefined && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-ink-faint">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-surface-sunken">
        <div
          className={`h-1.5 rounded-full ${tone}`}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </div>
      <span className="w-10 text-right tabular-nums text-ink-muted">
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  )
}

/**
 * One experiment's arms, side by side.
 *
 * The comparison a reader wants is between rows, so the arms are a table rather
 * than a set of cards — and every column is per-arm rather than a total,
 * because a total across arms measures nothing.
 */
function ExperimentArms({ experiment }: { experiment: AdminExperiment }): ReactElement {
  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-medium text-ink">{experiment.label}</span>
        <span className="font-mono text-xs text-ink-faint">{experiment.id}</span>
        <Badge tone={experiment.active ? "success" : "neutral"}>
          {experiment.active ? "running" : "ended"}
        </Badge>
      </div>
      <p className="px-4 pt-3 text-sm text-ink-muted">{experiment.hypothesis}</p>

      <div className="overflow-x-auto px-4 pb-4 pt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="pb-2 pr-4 font-medium">Arm</th>
              <th className="pb-2 pr-4 font-medium">Panel</th>
              <th className="pb-2 pr-4 text-right font-medium">Runs</th>
              <th className="pb-2 pr-4 text-right font-medium">Failed</th>
              <th className="pb-2 pr-4 text-right font-medium">Cached</th>
              <th className="pb-2 pr-4 text-right font-medium">Confidence</th>
              <th className="pb-2 pr-4 text-right font-medium">Thumbs</th>
              <th className="pb-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {experiment.arms.map((arm) => (
              <tr key={arm.variantId ?? "unassigned"}>
                <td className="py-2 pr-4 font-mono text-xs text-ink">{arm.variantId ?? "—"}</td>
                <td className="py-2 pr-4 font-mono text-xs text-ink-muted">{arm.panelId ?? "—"}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{count(arm.runs)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{count(arm.failed)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{count(arm.cached)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {arm.meanConfidence === null ? "—" : `${(arm.meanConfidence * 100).toFixed(0)}%`}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ink-muted">
                  {arm.thumbsUp} / {arm.thumbsDown}
                </td>
                <td className="py-2 text-right font-mono text-xs">{money(arm.costMicroCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {experiment.arms.every((arm) => arm.runs === 0) && (
          <p className="pt-3 text-sm text-ink-muted">
            No runs have landed in this experiment yet. If that persists, check that the API is
            running with this experiment configured.
          </p>
        )}
      </div>
    </div>
  )
}

function DeadLetters({ onReplayed }: { onReplayed: () => void }): ReactElement {
  const api = useApi()
  const [letters, setLetters] = useState<readonly DeadLetterView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      setLetters(await api.adminDeadLetters())
      setError(null)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not read the dead-letter queue")
    }
  }

  const replay = async (letter: DeadLetterView): Promise<void> => {
    setBusy(letter.jobId)
    setError(null)
    try {
      await api.adminReplay({ queue: letter.queue, jobId: letter.jobId })
      await load()
      onReplayed()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Replay failed")
    } finally {
      setBusy(null)
    }
  }

  if (letters === null) {
    return (
      <EmptyState
        title="Dead-letter queue"
        description="Jobs that exhausted their retries, with the payload and the failure that produced them."
        action={<Button variant="secondary" onClick={() => void load()}>Load</Button>}
      />
    )
  }

  return (
    <div className="space-y-3">
      {error !== null && <ErrorState detail={error} />}

      {letters.length === 0 ? (
        <EmptyState title="Nothing is dead-lettered" description="Every job either succeeded or is still being retried." />
      ) : (
        letters.map((letter) => (
          <Panel key={`${letter.queue}:${letter.jobId}`}>
            <PanelHeader
              title={
                <span className="font-mono text-xs">
                  {letter.queue} · {letter.jobId}
                </span>
              }
              description={`${letter.attemptsMade} attempts${letter.failedAt === null ? "" : ` · failed ${when(letter.failedAt)}`}`}
              actions={
                <div className="flex items-center gap-2">
                  <Link
                    href={`/runs/${letter.data.runId}`}
                    className="text-xs text-accent underline underline-offset-2"
                  >
                    Open the run
                  </Link>
                  <Button size="sm" disabled={busy !== null} onClick={() => void replay(letter)}>
                    {busy === letter.jobId ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw aria-hidden="true" />
                    )}
                    Replay
                  </Button>
                </div>
              }
            />
            <PanelBody className="space-y-2">
              <p className="text-sm text-danger">{letter.failedReason}</p>
              {letter.stacktrace.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-ink-muted">Stack trace</summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-[0.7rem] text-ink-muted">
                    {letter.stacktrace.join("\n")}
                  </pre>
                </details>
              )}
              <p className="text-xs text-ink-faint">
                Safe to press twice: the processor re-reads the row it targets, and one that
                already settled is left alone — so a double replay cannot double-charge.
              </p>
            </PanelBody>
          </Panel>
        ))
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "warning" | "danger"
}): ReactElement {
  return (
    <Panel>
      <PanelBody>
        <p className="text-xs text-ink-muted">{label}</p>
        <p
          className={
            tone === "danger"
              ? "mt-1 font-mono text-xl text-danger"
              : tone === "warning"
                ? "mt-1 font-mono text-xl text-warning"
                : "mt-1 font-mono text-xl text-ink"
          }
        >
          {value}
        </p>
      </PanelBody>
    </Panel>
  )
}
