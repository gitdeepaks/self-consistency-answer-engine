"use client"

import {
  estimateRun,
  formatEstimate,
  hasEntitlement,
  type PlanId,
  type ProviderHealth,
  type ProviderId,
} from "@sce/shared"
import { Loader2, Send } from "lucide-react"
import { useRouter } from "next/navigation"
import { useCallback, useMemo, useState, type FormEvent, type ReactElement } from "react"
import { ProviderTag } from "@/components/run/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, TextArea } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/states"
import { useApi } from "@/lib/api/browser"
import { isApiRequestError } from "@/lib/api/client"
import { cn } from "@/lib/cn"

/**
 * The composer.
 *
 * The one screen where a person spends money, so the design goal is that they
 * know it *before* they press the button rather than after:
 *
 *   - the estimate updates as they type and as they change the panel, and is
 *     quoted as a **range with a qualifier** because it is an estimate — see
 *     `estimateRun` in @sce/shared for what it can and cannot know,
 *   - the panel is visible, so "four models" is a choice rather than a default
 *     somebody discovers on an invoice,
 *   - a provider with no credentials is shown as unavailable rather than hidden,
 *     because "why is Gemini not answering?" is otherwise unanswerable from the
 *     interface.
 *
 * Choosing the panel at all is a paid capability (`panel.custom`). It is gated
 * here for the affordance and gated again in the API for the enforcement — a
 * feature hidden only in a UI is not gated, and `POST /api/runs` refuses it
 * independently of anything this component does.
 */

const MAX_PROMPT = 8000

export function Composer({
  panel,
  evaluatorModel,
  plan,
}: {
  panel: readonly ProviderHealth[]
  evaluatorModel: string
  plan: PlanId
}): ReactElement {
  const api = useApi()
  const router = useRouter()

  const available = useMemo(() => panel.filter((member) => member.available), [panel])
  const canChoosePanel = hasEntitlement(plan, "panel.custom")

  const [prompt, setPrompt] = useState("")
  const [selected, setSelected] = useState<readonly ProviderId[]>(() =>
    available.map((member) => member.id),
  )
  const [temperature, setTemperature] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The panel actually used: everything available, unless the plan allows a
  // choice and one has been made.
  const effective = canChoosePanel ? selected : available.map((member) => member.id)

  const estimate = useMemo(
    () =>
      estimateRun({
        prompt,
        providers: effective,
        // The *resolved* model ids from `GET /api/providers`, not the
        // compiled-in defaults: an install that overrides `OPENAI_MODEL` gets
        // an estimate for the model it will actually call.
        models: Object.fromEntries(panel.map((member) => [member.id, member.model])),
        evaluatorModel,
      }),
    [prompt, effective, panel, evaluatorModel],
  )

  const toggle = useCallback((id: ProviderId): void => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )
  }, [])

  const tooLong = prompt.length > MAX_PROMPT
  const tooShort = prompt.trim().length > 0 && prompt.trim().length < 3
  const ready = prompt.trim().length >= 3 && !tooLong && effective.length > 0 && !submitting

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready) return

    setSubmitting(true)
    setError(null)

    try {
      const run = await api.createRun(
        {
          prompt: prompt.trim(),
          // Sent only when it is a real choice. Omitting it means "the default
          // panel", which is what a free-plan caller must send — passing an
          // explicit list would trip the `panel.custom` gate for a selection
          // they never made.
          ...(canChoosePanel && effective.length !== available.length
            ? { providers: [...effective] }
            : {}),
          ...(temperature === null ? {} : { temperature }),
        },
        // A fresh key per submission, so a double click or a flaky connection
        // returns the run the first attempt created instead of fanning out a
        // second, identically expensive panel.
        crypto.randomUUID(),
      )
      router.push(`/runs/${run.id}`)
    } catch (caught: unknown) {
      // A typed refusal carries the sentence worth showing — which quota, how
      // much is left, when it resets. `ApiRequestError` keeps it precisely so
      // this does not have to become "Something went wrong".
      setError(
        isApiRequestError(caught)
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Could not start the run",
      )
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Panel>
        <PanelBody className="space-y-4">
          <Field
            label="Your question"
            labelHidden
            error={
              tooLong
                ? `That is ${(prompt.length - MAX_PROMPT).toLocaleString("en-US")} characters over the limit.`
                : tooShort
                  ? "A question needs at least three characters."
                  : null
            }
          >
            {({ controlId, describedBy, invalid }) => (
              <TextArea
                id={controlId}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value)
                }}
                onKeyDown={(event) => {
                  // The TUI's shortcut, kept: a long prompt is a paragraph, so
                  // Enter has to insert a newline and the modifier submits.
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    void submit(event)
                  }
                }}
                rows={7}
                maxLength={MAX_PROMPT + 500}
                placeholder="Ask anything. The panel answers independently, then an evaluator merges them."
                className="border-0 bg-transparent px-0 text-base focus-visible:outline-none"
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-xs text-ink-faint">
              {prompt.length.toLocaleString("en-US")} / {MAX_PROMPT.toLocaleString("en-US")}
              <span className="mx-2">·</span>
              <kbd className="rounded border border-line px-1 font-mono">⌘</kbd>
              <kbd className="ml-0.5 rounded border border-line px-1 font-mono">↵</kbd> to send
            </span>

            <Button type="submit" disabled={!ready} size="lg">
              {submitting ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {submitting ? "Starting…" : "Ask the panel"}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {error !== null && <ErrorState detail={error} title="Could not start the run" />}

      <div className="grid gap-4 md:grid-cols-[1fr_20rem]">
        <Panel>
          <PanelHeader
            title="The panel"
            description={
              canChoosePanel
                ? "Choose who answers. The evaluator reads all of them."
                : "Every configured model answers. Choosing a subset is a Pro feature."
            }
          />
          <PanelBody className="space-y-2">
            {panel.map((member) => {
              const chosen = effective.includes(member.id)
              const selectable = canChoosePanel && member.available
              return (
                <div
                  key={member.id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5",
                    chosen ? "border-line-strong bg-surface-sunken" : "border-line",
                    !member.available && "opacity-60",
                  )}
                >
                  <label className="flex min-w-0 flex-1 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={chosen}
                      disabled={!selectable}
                      onChange={() => {
                        toggle(member.id)
                      }}
                      className="size-4 shrink-0 accent-[var(--accent)] disabled:opacity-50"
                    />
                    <ProviderTag provider={member.id} model={member.model} className="min-w-0" />
                  </label>

                  {member.available ? (
                    <Badge tone={member.route === "direct" ? "success" : "accent"}>
                      {member.route === "direct" ? "Direct" : "Gateway"}
                    </Badge>
                  ) : (
                    <Badge tone="warning" title={member.hint ?? undefined}>
                      No credentials
                    </Badge>
                  )}
                </div>
              )
            })}

            {available.length === 0 && (
              <p className="py-2 text-sm text-ink-muted">
                No provider has usable credentials, so there is nobody to ask. Set at least one
                provider key, or an AI Gateway key, on the API.
              </p>
            )}
          </PanelBody>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Estimated cost" />
            <PanelBody className="space-y-3">
              <p className="font-mono text-lg text-ink">{formatEstimate(estimate)}</p>
              <dl className="space-y-1 text-xs text-ink-muted">
                <div className="flex justify-between gap-4">
                  <dt>Panel</dt>
                  <dd>{effective.length} model{effective.length === 1 ? "" : "s"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Input tokens</dt>
                  <dd className="font-mono">{estimate.totalInputTokens.toLocaleString("en-US")}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Output tokens (assumed)</dt>
                  <dd className="font-mono">{estimate.totalOutputTokens.toLocaleString("en-US")}</dd>
                </div>
              </dl>

              {estimate.unpricedModels.length > 0 && (
                <p className="text-xs text-warning">
                  No price on file for {estimate.unpricedModels.join(", ")} — the real cost will be
                  higher than this.
                </p>
              )}
              {estimate.unverified && estimate.unpricedModels.length === 0 && (
                <p className="text-xs text-ink-faint">
                  Some prices are unverified placeholders. Treat this as an order of magnitude.
                </p>
              )}
              <p className="text-xs text-ink-faint">
                Output length is what nobody can know in advance; the range is the honest width
                around it. The synthesis call reads every answer, so it grows with the panel.
              </p>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Temperature" />
            <PanelBody>
              <Field
                label="Sampling temperature"
                labelHidden
                hint={
                  temperature === null
                    ? "Using each model's default."
                    : "Higher is more varied; lower is more repeatable."
                }
              >
                {({ controlId }) => (
                  <div className="flex items-center gap-3">
                    <input
                      id={controlId}
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperature ?? 0.7}
                      onChange={(event) => {
                        setTemperature(Number(event.target.value))
                      }}
                      className="flex-1 accent-[var(--accent)]"
                    />
                    <span className="w-14 text-right font-mono text-sm text-ink">
                      {temperature === null ? "auto" : temperature.toFixed(1)}
                    </span>
                  </div>
                )}
              </Field>
              {temperature !== null && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-2 px-0"
                  onClick={() => {
                    setTemperature(null)
                  }}
                >
                  Use the model defaults
                </Button>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>
    </form>
  )
}
