import {
  formatMicroCentsUsd,
  PROVIDERS,
  type CandidateStatus,
  type ProviderId,
  type RunStatus,
} from "@sce/shared"

/**
 * Turning domain values into things a person reads.
 *
 * Everything here is pure and has no React in it, so the same function formats
 * a number in a server component, in a client component and in a test. The
 * alternative — formatting inline at each site — is how "4200ms", "4.2s" and
 * "4 seconds" end up on the same screen.
 */

/** Money. Two decimal places for a total, more only when it would read as zero. */
export function money(microCents: number): string {
  if (microCents === 0) return "$0.00"
  const usd = microCents / (100 * 1_000_000)
  if (usd < 0.01) return formatMicroCentsUsd(microCents, 4)
  return formatMicroCentsUsd(microCents, 2)
}

/** A duration, at the precision a person actually cares about. */
export function duration(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** Large counts, abbreviated. Exact below 10,000, where the digits still help. */
export function count(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US")
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * A timestamp, relative when it is recent and absolute when it is not.
 *
 * "3 minutes ago" is what somebody wants for a run they just started; "12 March"
 * is what they want for one from last quarter, because "94 days ago" is a
 * number nobody can convert back into a date.
 */
export function when(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000)

  if (seconds < 45) return "just now"
  if (seconds < 90) return "a minute ago"
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`
  if (seconds < 7200) return "an hour ago"
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours ago`
  if (seconds < 172_800) return "yesterday"
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)} days ago`

  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(then.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
  })
}

/** The exact timestamp, for a `title` attribute behind the relative one. */
export function exactly(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })
}

/** A run status, in words rather than SCREAMING_SNAKE. */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "PENDING":
      return "Queued"
    case "QUEUED":
      return "Queued"
    case "FANNING_OUT":
      return "Asking the panel"
    case "SYNTHESIZING":
      return "Synthesising"
    case "COMPLETE":
      return "Complete"
    case "FAILED":
      return "Failed"
    case "CANCELED":
      return "Canceled"
  }
}

/** A candidate status, in words. */
export function candidateStatusLabel(status: CandidateStatus): string {
  switch (status) {
    case "PENDING":
      return "Waiting"
    case "RUNNING":
      return "Answering"
    case "OK":
      return "Answered"
    case "ERROR":
      return "Failed"
    case "SKIPPED":
      return "Skipped"
    case "CANCELED":
      return "Canceled"
  }
}

/**
 * The accent for a provider.
 *
 * Read from the same `PROVIDERS` registry the CLI paints from, so the colour
 * that means "Claude" in a terminal means "Claude" here. Returned as a CSS
 * value rather than a class name because the registry is data: a fourth
 * provider added to `models.ts` gets its colour in both surfaces with no change
 * to either.
 */
export function providerColor(provider: ProviderId): string {
  return PROVIDERS[provider].color
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDERS[provider].label
}

/** Confidence as a percentage, or a dash when there is none. */
export function confidence(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`
}

/**
 * A prompt, shortened for a list.
 *
 * Cut on a word boundary rather than mid-word: a truncated list is scanned, and
 * "How do I configure Postgres conn…" reads while "How do I configure Postgres
 * connec…" does not.
 */
export function excerpt(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
