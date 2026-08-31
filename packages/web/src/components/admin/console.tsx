"use client"

import type { AdminOverview, AdminTenant, DeadLetterView, KillSwitch } from "@sce/shared"
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

type TabId = "overview" | "tenants" | "dlq"

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
