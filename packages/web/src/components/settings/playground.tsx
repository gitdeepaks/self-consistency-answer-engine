"use client"

import { isSceApiError } from "@sce/sdk"
import { Loader2, Play, Terminal } from "lucide-react"
import { useAuth } from "@clerk/nextjs"
import { useMemo, useState, type ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Field, Select, TextArea } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/states"
import { config, authConfigured } from "@/env"
import { publicApi } from "@/lib/api/public"

/**
 * The API playground.
 *
 * The point of a playground is not that it is a nicer `curl`. It is that the
 * gap between "I am reading the docs" and "I have made a successful request" is
 * where most evaluations are abandoned, and the gap is almost entirely
 * credentials: finding the base URL, minting a key, getting the header right.
 * Signed into the web app, all three are already true, so the first successful
 * call costs one click.
 *
 * Every operation here runs through `@sce/sdk` against the real `/v1` surface —
 * not a mock, and not the internal `/api` routes. What you see is what your
 * code will see, including the error envelope. The `curl` panel is generated
 * from the same operation, so copying it out reproduces exactly what just ran.
 */

type Operation =
  | "GET /v1/providers"
  | "GET /v1/usage"
  | "GET /v1/runs"
  | "POST /v1/runs"
  | "GET /v1/webhooks/endpoints"
  | "GET /v1/webhooks/deliveries"

const OPERATIONS: readonly { value: Operation; summary: string; body?: string }[] = [
  { value: "GET /v1/providers", summary: "Which panel members are reachable right now" },
  { value: "GET /v1/usage", summary: "This month's spend, and how close each quota is" },
  { value: "GET /v1/runs", summary: "A page of run history, newest first" },
  {
    value: "POST /v1/runs",
    summary: "Start a run — this one costs money",
    body: JSON.stringify({ prompt: "Why is the sky blue?" }, null, 2),
  },
  { value: "GET /v1/webhooks/endpoints", summary: "Registered receivers" },
  { value: "GET /v1/webhooks/deliveries", summary: "What we sent, and what your server said" },
]

interface Outcome {
  status: number
  durationMs: number
  body: string
}

export function Playground(): ReactElement {
  const { getToken } = useAuth()

  const [operation, setOperation] = useState<Operation>("GET /v1/providers")
  const [body, setBody] = useState(OPERATIONS[3]?.body ?? "")
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = OPERATIONS.find((entry) => entry.value === operation)
  const isWrite = operation.startsWith("POST")

  /**
   * The equivalent `curl`, generated from the same operation.
   *
   * `$SCE_API_KEY` rather than the session token that is actually being used:
   * pasting a live credential into a page that people screenshot is how
   * credentials leak, and a session token would not work from a terminal
   * tomorrow anyway.
   */
  const curl = useMemo(() => {
    const [method = "GET", path = "/v1"] = operation.split(" ")
    const lines = [
      `curl -sS -X ${method} "${config.apiUrl}${path}"`,
      `  -H "Authorization: Bearer $SCE_API_KEY"`,
    ]
    if (isWrite) {
      lines.push(`  -H "Content-Type: application/json"`)
      lines.push(`  -H "Idempotency-Key: $(uuidgen)"`)
      lines.push(`  -d '${body.replace(/\s+/g, " ").trim()}'`)
    }
    return lines.join(" \\\n")
  }, [operation, body, isWrite])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setOutcome(null)

    const started = performance.now()
    try {
      const sce = await publicApi(async () => (authConfigured() ? getToken() : null))
      if (sce === null) throw new Error("Sign in to use the playground")

      const result = await execute(sce, operation, body)
      setOutcome({
        status: 200,
        durationMs: Math.round(performance.now() - started),
        body: JSON.stringify(result, null, 2),
      })
    } catch (caught: unknown) {
      // A refusal is a *result*, not a crash — showing the real envelope is the
      // most useful thing this page does, because it is the shape the reader's
      // own error handling has to cope with.
      if (isSceApiError(caught)) {
        setOutcome({
          status: caught.status,
          durationMs: Math.round(performance.now() - started),
          body: JSON.stringify(
            {
              code: caught.code,
              message: caught.message,
              ...(caught.details === undefined ? {} : { details: caught.details }),
              requestId: caught.requestId,
            },
            null,
            2,
          ),
        })
      } else {
        setError(caught instanceof Error ? caught.message : "The request failed")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error !== null && <ErrorState detail={error} />}

      <Panel>
        <PanelHeader
          title="Try a request"
          description="Runs against the real /v1 API with your session, through @sce/sdk. What you see here is what your code will see."
          actions={
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void run()
              }}
            >
              {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
              Send
            </Button>
          }
        />

        <PanelBody className="space-y-4">
          <Field label="Operation" hint={selected?.summary}>
            {({ controlId }) => (
              <Select
                id={controlId}
                value={operation}
                onChange={(event) => {
                  const next = OPERATIONS.find((entry) => entry.value === event.target.value)
                  if (next === undefined) return
                  setOperation(next.value)
                  setBody(next.body ?? "")
                  setOutcome(null)
                }}
              >
                {OPERATIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.value}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {isWrite && (
            <Field
              label="Request body"
              hint="This starts a real run on your workspace, and it is billed like any other."
            >
              {({ controlId }) => (
                <TextArea
                  id={controlId}
                  rows={5}
                  value={body}
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => {
                    setBody(event.target.value)
                  }}
                />
              )}
            </Field>
          )}
        </PanelBody>
      </Panel>

      {outcome !== null && (
        <Panel>
          <PanelHeader
            title="Response"
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={outcome.status < 400 ? "success" : "danger"}>{outcome.status}</Badge>
                <span className="text-xs tabular-nums text-ink-muted">{outcome.durationMs} ms</span>
                <CopyButton value={outcome.body} label="Copy response" />
              </div>
            }
          />
          <PanelBody>
            <pre className="max-h-96 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono text-xs text-ink">
              {outcome.body}
            </pre>
          </PanelBody>
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title="The same request, from a terminal"
          description="Set SCE_API_KEY to a key from the API keys page."
          actions={<CopyButton value={curl} label="Copy curl" />}
        />
        <PanelBody>
          <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-xs text-ink">
            <Terminal aria-hidden="true" className="mb-2 size-3.5 text-ink-faint" />
            {curl}
          </pre>
        </PanelBody>
      </Panel>
    </div>
  )
}

/**
 * Dispatch one operation.
 *
 * An exhaustive switch over a literal union rather than a lookup table, so
 * adding an operation to `OPERATIONS` without teaching this function about it
 * is a compile error — and the playground can never offer a request it cannot
 * actually make.
 */
async function execute(
  sce: NonNullable<Awaited<ReturnType<typeof publicApi>>>,
  operation: Operation,
  body: string,
): Promise<unknown> {
  switch (operation) {
    case "GET /v1/providers":
      return sce.providers()
    case "GET /v1/usage":
      return sce.usage()
    case "GET /v1/runs":
      return sce.runs.list({ limit: 5 })
    case "POST /v1/runs":
      return sce.runs.create(parseBody(body))
    case "GET /v1/webhooks/endpoints":
      return sce.webhooks.list({ limit: 10 })
    case "GET /v1/webhooks/deliveries":
      return sce.webhooks.deliveries({ limit: 10 })
  }
}

/** The body, parsed here so a typo is a clear message rather than a 400. */
function parseBody(body: string): { prompt: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("The request body is not valid JSON")
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("prompt" in parsed) ||
    typeof parsed.prompt !== "string"
  ) {
    throw new Error('The request body needs a "prompt" string')
  }
  return { prompt: parsed.prompt }
}
