import type { Candidate, ProviderHealth, Run } from "@sce/shared"
import { formatMs, formatTokens, truncate } from "../format.ts"
import { theme } from "../theme.ts"
import { useSpinner } from "./useSpinner.ts"

const MARKS: Record<Candidate["status"], string> = {
  PENDING: "○",
  RUNNING: "",
  OK: "✔",
  ERROR: "✖",
  SKIPPED: "–",
  CANCELED: "⊘",
}

function statusColor(candidate: Candidate): string {
  switch (candidate.status) {
    case "OK":
      return theme.ok
    case "ERROR":
      return theme.err
    case "SKIPPED":
    case "CANCELED":
      return theme.dim
    default:
      return theme.warn
  }
}

function CandidateRow({ candidate, color }: { candidate: Candidate; color: string }) {
  const spinner = useSpinner(candidate.status === "RUNNING")
  const mark = candidate.status === "RUNNING" ? spinner : MARKS[candidate.status]

  return (
    <box flexDirection="row" gap={1}>
      <text fg={statusColor(candidate)}>{mark}</text>
      <text fg={color}>{candidate.label.padEnd(8)}</text>
      <text fg={theme.dim}>{candidate.model.padEnd(20)}</text>
      <text fg={theme.dim}>{formatMs(candidate.latencyMs).padStart(7)}</text>
      <text fg={theme.dim}>{formatTokens(candidate.inputTokens, candidate.outputTokens)}</text>
      {candidate.error && (
        <text fg={theme.err} flexGrow={1}>
          {truncate(candidate.error, 60)}
        </text>
      )}
    </box>
  )
}

interface PanelStatusProps {
  run: Run | null
  panel: ProviderHealth[]
  stage: string
  busy: boolean
}

export function PanelStatus({ run, panel, stage, busy }: PanelStatusProps) {
  const spinner = useSpinner(busy)
  const colors = new Map(panel.map((provider) => [provider.id, provider.color]))

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title=" panel "
      titleAlignment="left"
    >
      {run ? (
        run.candidates.map((candidate) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            color={colors.get(candidate.provider) ?? theme.text}
          />
        ))
      ) : (
        <text fg={theme.dim}>No run yet — type a question above and press Enter.</text>
      )}
      <box flexDirection="row" gap={1}>
        <text fg={busy ? theme.warn : theme.dim}>{busy ? spinner : "·"}</text>
        <text fg={busy ? theme.text : theme.dim}>{stage}</text>
        {run?.synthesis && (
          <text fg={theme.magenta}>
            · confidence {(run.synthesis.confidence * 100).toFixed(0)}% · total{" "}
            {formatMs(run.totalLatencyMs)}
          </text>
        )}
      </box>
    </box>
  )
}
