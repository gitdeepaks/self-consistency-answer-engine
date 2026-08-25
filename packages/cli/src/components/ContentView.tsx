import type { Run } from "@sce/shared"
import { formatMs } from "../format.ts"
import { markdownStyle, theme } from "../theme.ts"

export interface Tab {
  key: string
  label: string
  color: string
}

/** Final answer, evaluator analysis, then one tab per panel member. */
export function buildTabs(run: Run | null, colorOf: (provider: string) => string): Tab[] {
  const tabs: Tab[] = [
    { key: "final", label: "Final Answer", color: theme.accent },
    { key: "analysis", label: "Analysis", color: theme.magenta },
  ]
  for (const candidate of run?.candidates ?? []) {
    tabs.push({ key: candidate.id, label: candidate.label, color: colorOf(candidate.provider) })
  }
  return tabs
}

export function TabBar({ tabs, activeIndex }: { tabs: Tab[]; activeIndex: number }) {
  return (
    <box flexDirection="row" flexShrink={0} gap={1} paddingX={1}>
      {tabs.map((tab, index) => {
        const active = index === activeIndex
        return (
          <text
            key={tab.key}
            fg={active ? theme.bg : tab.color}
            bg={active ? tab.color : undefined}
          >
            {active ? ` ${tab.label} ` : ` ${tab.label} `}
          </text>
        )
      })}
    </box>
  )
}

function Placeholder({ lines }: { lines: string[] }) {
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      {lines.map((line, index) => (
        <text key={index} fg={theme.dim}>
          {line}
        </text>
      ))}
    </box>
  )
}

function Analysis({ run }: { run: Run }) {
  const synthesis = run.synthesis
  if (!synthesis) {
    return <Placeholder lines={["The evaluator has not compared the answers yet."]} />
  }

  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <text fg={theme.ok}>
        <strong>Where the models agreed</strong>
      </text>
      {synthesis.agreements.length === 0 ? (
        <text fg={theme.dim}>  (nothing converged)</text>
      ) : (
        synthesis.agreements.map((item, index) => (
          <text key={index} fg={theme.text}>
            {"  • "}
            {item}
          </text>
        ))
      )}

      <text fg={theme.warn}>
        <strong>Where they disagreed</strong>
      </text>
      {synthesis.disagreements.length === 0 ? (
        <text fg={theme.dim}>  (no conflicts found)</text>
      ) : (
        synthesis.disagreements.map((item, index) => (
          <text key={index} fg={theme.text}>
            {"  • "}
            {item}
          </text>
        ))
      )}

      <text fg={theme.accent}>
        <strong>Scorecard</strong>
      </text>
      {synthesis.reviews.map((review) => {
        const candidate = run.candidates.find((c) => c.provider === review.provider)
        const filled = Math.round(review.score)
        return (
          <box key={review.provider} flexDirection="column">
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>{(candidate?.label ?? review.provider).padEnd(8)}</text>
              <text fg={review.score >= 7 ? theme.ok : review.score >= 4 ? theme.warn : theme.err}>
                {"█".repeat(filled)}
                {"░".repeat(Math.max(0, 10 - filled))} {review.score.toFixed(1)}/10
              </text>
            </box>
            {review.strengths.map((item, index) => (
              <text key={`s${index}`} fg={theme.ok}>
                {"    + "}
                {item}
              </text>
            ))}
            {review.weaknesses.map((item, index) => (
              <text key={`w${index}`} fg={theme.err}>
                {"    − "}
                {item}
              </text>
            ))}
          </box>
        )
      })}

      <text fg={theme.dim}>
        Evaluator {synthesis.model} · {formatMs(synthesis.latencyMs)} · confidence{" "}
        {(synthesis.confidence * 100).toFixed(0)}%
      </text>
    </box>
  )
}

interface ContentViewProps {
  run: Run | null
  tab: Tab | undefined
  focused: boolean
  /**
   * Text streamed so far for candidates that have not settled, keyed by
   * candidate id. Kept separate from `run` because a partial answer is not an
   * answer — the settled row remains the source of truth.
   */
  streaming: Record<string, string>
}

export function ContentView({ run, tab, focused, streaming }: ContentViewProps) {
  let body: React.ReactNode

  if (!run || !tab) {
    body = (
      <Placeholder
        lines={[
          "Self-consistency: ask once, get every model's answer, then a merged best answer.",
          "",
          "1. Your question is sent to OpenAI, Claude and Gemini in parallel.",
          "2. Claude then compares the answers, scores them, and writes a merged reply.",
          "",
          "Type a question above and press Enter to begin.",
        ]}
      />
    )
  } else if (tab.key === "final") {
    body = run.synthesis ? (
      <markdown content={run.synthesis.finalAnswer} syntaxStyle={markdownStyle} />
    ) : (
      <Placeholder
        lines={
          run.status === "FAILED"
            ? ["This run failed before a final answer was produced.", run.error ?? ""]
            : run.status === "CANCELED"
              ? ["This run was canceled before a final answer was produced.", run.error ?? ""]
            : ["Waiting for the panel to answer, then the evaluator will merge them…"]
        }
      />
    )
  } else if (tab.key === "analysis") {
    body = <Analysis run={run} />
  } else {
    const candidate = run.candidates.find((c) => c.id === tab.key)
    const partial = candidate ? (streaming[candidate.id] ?? "") : ""

    if (!candidate) {
      body = <Placeholder lines={["Unknown tab."]} />
    } else if (candidate.status === "RUNNING" && partial.length > 0) {
      // Tokens as they arrive. Rendered as plain text rather than Markdown:
      // a half-written fence or table would flicker between parses, and the
      // settled tab a moment later renders the finished document properly.
      body = (
        <box flexDirection="column">
          <text fg={theme.dim}>{candidate.model} · generating…</text>
          <text fg={theme.text}>{partial}</text>
        </box>
      )
    } else if (candidate.status === "OK" && candidate.content) {
      body = (
        <box flexDirection="column">
          <text fg={theme.dim}>
            {candidate.model} · {formatMs(candidate.latencyMs)}
          </text>
          <markdown content={candidate.content} syntaxStyle={markdownStyle} />
        </box>
      )
    } else if (
      candidate.status === "ERROR" ||
      candidate.status === "SKIPPED" ||
      candidate.status === "CANCELED"
    ) {
      body = (
        <box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <text fg={theme.err}>
            {candidate.label} did not contribute to this run.
          </text>
          <text fg={theme.dim}>{candidate.error ?? "No reason recorded."}</text>
          {/* Streaming means a cut-short call still leaves what it produced. */}
          {candidate.content ? (
            <>
              <text fg={theme.dim}>Partial answer before it stopped:</text>
              <text fg={theme.text}>{candidate.content}</text>
            </>
          ) : null}
        </box>
      )
    } else {
      body = <Placeholder lines={[`${candidate.label} is still thinking…`]} />
    }
  }

  return (
    <scrollbox
      flexGrow={1}
      focused={focused}
      paddingX={1}
      style={{
        rootOptions: {
          backgroundColor: theme.bg,
          border: true,
          borderStyle: "rounded",
          borderColor: focused ? theme.borderActive : theme.border,
        },
        scrollbarOptions: {
          showArrows: false,
          trackOptions: { foregroundColor: theme.borderActive, backgroundColor: theme.border },
        },
      }}
    >
      {body}
    </scrollbox>
  )
}
