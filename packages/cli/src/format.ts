export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatTokens(input: number | null, output: number | null): string {
  if (input == null && output == null) return "—"
  return `${input ?? 0}in / ${output ?? 0}out`
}

export function formatRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  if (delta < 60_000) return "just now"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

export function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`
}
