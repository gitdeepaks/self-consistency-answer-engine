import type { RunSummary } from "@sce/shared"
import { formatMs, formatRelative, truncate } from "../format.ts"
import { theme } from "../theme.ts"

interface HistoryViewProps {
  items: RunSummary[]
  loading: boolean
  onSelect: (id: string) => void
  focused: boolean
}

export function HistoryView({ items, loading, onSelect, focused }: HistoryViewProps) {
  const options = items.map((item) => ({
    name: truncate(item.prompt, 62),
    description: `${item.status === "COMPLETE" ? "✔" : item.status === "FAILED" ? "✖" : "…"} ${
      item.candidateCount
    } models · ${formatMs(item.totalLatencyMs)} · ${formatRelative(item.createdAt)}`,
    value: item.id,
  }))

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      border
      borderStyle="rounded"
      borderColor={focused ? theme.borderActive : theme.border}
      title=" history — ↑↓ to browse, Enter to open, Ctrl+H to close "
      titleAlignment="left"
    >
      {loading ? (
        <text fg={theme.dim}>Loading…</text>
      ) : options.length === 0 ? (
        <text fg={theme.dim}>No runs recorded yet.</text>
      ) : (
        <select
          flexGrow={1}
          options={options}
          focused={focused}
          showScrollIndicator
          onSelect={(_index, option) => {
            if (option?.value) onSelect(String(option.value))
          }}
        />
      )}
    </box>
  )
}
