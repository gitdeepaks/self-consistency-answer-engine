"use client"

import { isTerminalRunStatus, type Run } from "@sce/shared"
import { Ban, Loader2, Share2, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactElement } from "react"
import { AnswerView, CandidateComparison } from "@/components/run/answer"
import { CandidatePanel } from "@/components/run/candidate-panel"
import { FeedbackControl } from "@/components/run/feedback"
import { ShareDialog } from "@/components/run/share-dialog"
import { RunStatusBadge } from "@/components/run/status"
import { TagEditor } from "@/components/run/tags"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/states"
import { Tabs, type TabDefinition } from "@/components/ui/tabs"
import { useRunStream } from "@/hooks/use-run-stream"
import { useApi } from "@/lib/api/browser"
import { cn } from "@/lib/cn"
import { duration, exactly, when } from "@/lib/format"

/**
 * One run, live or finished.
 *
 * The same component serves both, which is the point: a finished run is simply
 * a live one whose stream has already closed, and having two components would
 * mean two renderings of the same answer that drift apart. `useRunStream`
 * decides whether to open a connection at all — a terminal run opens none.
 *
 * The tabs matter for a reason beyond tidiness. The synthesised answer is what
 * the product claims is better, so it is the default view; the individual
 * drafts are one keypress away so that claim stays checkable rather than
 * something a user is asked to accept.
 */

type TabId = "answer" | "panel" | "compare"

export function RunView({ initialRun }: { initialRun: Run }): ReactElement {
  const api = useApi()
  const router = useRouter()
  const stream = useRunStream(initialRun)
  const { run, streaming, connection, synthesizingWith } = stream

  const [tab, setTab] = useState<TabId>(() =>
    // A run that is still going opens on the panel, because that is where
    // things are actually happening; a finished one opens on the answer.
    isTerminalRunStatus(initialRun.status) ? "answer" : "panel",
  )
  const [sharing, setSharing] = useState(false)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const finished = isTerminalRunStatus(run.status)
  const answered = run.candidates.filter(
    (candidate) => candidate.content !== null && candidate.content.length > 0,
  )

  const cancel = async (): Promise<void> => {
    setActing(true)
    setActionError(null)
    try {
      await api.cancelRun(run.id, "Canceled from the web app")
    } catch (caught: unknown) {
      setActionError(caught instanceof Error ? caught.message : "Could not cancel the run")
    } finally {
      setActing(false)
    }
  }

  const remove = async (): Promise<void> => {
    setActing(true)
    setActionError(null)
    try {
      await api.deleteRun(run.id)
      router.push("/runs")
      router.refresh()
    } catch (caught: unknown) {
      setActionError(caught instanceof Error ? caught.message : "Could not delete the run")
      setActing(false)
    }
  }

  const tabs: readonly TabDefinition<TabId>[] = [
    { id: "answer", label: "Answer", hint: run.synthesis === null ? "pending" : undefined },
    { id: "panel", label: "Drafts", hint: String(run.candidates.length) },
    ...(answered.length > 1
      ? [{ id: "compare" as const, label: "Compare" }]
      : []),
  ]

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium leading-snug text-ink">{run.prompt}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
              <span title={exactly(run.createdAt)}>{when(run.createdAt)}</span>
              <span>·</span>
              <span>{duration(run.totalLatencyMs)}</span>
              <span>·</span>
              <span>
                {run.candidates.length} model{run.candidates.length === 1 ? "" : "s"}
              </span>
              {run.temperature !== null && (
                <>
                  <span>·</span>
                  <span className="font-mono">temp {run.temperature.toFixed(1)}</span>
                </>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <ConnectionPip state={connection} live={stream.live} />

            {!finished && (
              <Button variant="secondary" size="sm" onClick={() => void cancel()} disabled={acting}>
                {acting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
                Stop
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSharing(true)
              }}
            >
              <Share2 aria-hidden="true" />
              Share
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => void remove()}
              disabled={acting}
              className="text-ink-faint hover:text-danger"
            >
              <Trash2 aria-hidden="true" />
              <span className="sr-only">Delete this run</span>
            </Button>
          </div>
        </div>

        <TagEditor runId={run.id} initialTags={run.tags} />
      </header>

      {actionError !== null && <ErrorState detail={actionError} />}

      {run.status === "FAILED" && (
        <ErrorState
          title="This run failed"
          detail={run.error ?? "No reason was recorded."}
        />
      )}

      {run.status === "CANCELED" && (
        <Panel>
          <PanelBody className="text-sm text-ink-muted">
            {run.error ?? "This run was canceled."} Any answers that had already arrived are below.
          </PanelBody>
        </Panel>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab}>
        {tab === "answer" &&
          (run.synthesis !== null ? (
            <div className="space-y-4">
              <AnswerView
                synthesis={run.synthesis}
                candidates={run.candidates}
                onCompare={
                  answered.length > 1
                    ? () => {
                        setTab("compare")
                      }
                    : undefined
                }
              />
              <Panel>
                <PanelBody>
                  <FeedbackControl runId={run.id} />
                </PanelBody>
              </Panel>
            </div>
          ) : (
            <Panel>
              <PanelBody className="py-10 text-center">
                <p className="text-sm text-ink-muted">
                  {synthesizingWith !== null
                    ? `${synthesizingWith} is reading the drafts and merging them…`
                    : finished
                      ? "This run never produced a synthesised answer."
                      : "The panel is still answering. The synthesis begins once they finish."}
                </p>
                {!finished && (
                  <Button
                    variant="link"
                    className="mt-2"
                    onClick={() => {
                      setTab("panel")
                    }}
                  >
                    Watch the drafts arrive
                  </Button>
                )}
              </PanelBody>
            </Panel>
          ))}

        {tab === "panel" && (
          <div
            className={cn(
              "grid gap-4",
              run.candidates.length === 1
                ? "grid-cols-1"
                : run.candidates.length === 2
                  ? "grid-cols-1 lg:grid-cols-2"
                  : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
            )}
          >
            {run.candidates.map((candidate) => (
              <CandidatePanel
                key={candidate.id}
                candidate={candidate}
                {...(streaming[candidate.id] === undefined
                  ? {}
                  : { streamingText: streaming[candidate.id] })}
                className="max-h-[36rem]"
              />
            ))}
          </div>
        )}

        {tab === "compare" && (
          <Panel>
            <PanelHeader
              title="Drafts side by side"
              description="What each model wrote before the evaluator merged them."
            />
            <PanelBody>
              <CandidateComparison candidates={run.candidates} />
            </PanelBody>
          </Panel>
        )}
      </Tabs>

      <ShareDialog
        runId={run.id}
        open={sharing}
        canShare={run.synthesis !== null}
        onClose={() => {
          setSharing(false)
        }}
      />
    </div>
  )
}

/**
 * The connection indicator.
 *
 * Present because a stream that has quietly died looks exactly like a run that
 * is thinking hard, and a user staring at a still page has no way to tell the
 * difference. Reconnecting is stated rather than hidden — the app recovers by
 * itself, and saying so is what stops somebody reloading and losing their place.
 */
function ConnectionPip({
  state,
  live,
}: {
  state: "idle" | "connecting" | "live" | "reconnecting" | "closed"
  live: boolean
}): ReactElement | null {
  if (!live || state === "closed") return null

  const copy =
    state === "reconnecting"
      ? "Reconnecting…"
      : state === "live"
        ? "Live"
        : "Connecting…"

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-ink-faint"
      // Polite, so a screen reader mentions a reconnect without interrupting
      // whatever the user was reading.
      aria-live="polite"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "live" ? "bg-success" : "animate-pulse bg-warning",
        )}
        aria-hidden="true"
      />
      {copy}
    </span>
  )
}
