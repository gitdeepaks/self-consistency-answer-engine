/**
 * Turn anything thrown by a provider SDK into a single short line that is safe
 * to persist and show in the CLI. Provider SDKs throw a zoo of shapes; the
 * useful signal is almost always `message` plus an HTTP status.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts: string[] = []
    const status = (error as { statusCode?: number; status?: number }).statusCode ??
      (error as { status?: number }).status
    if (typeof status === "number") parts.push(`HTTP ${status}`)

    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return parts.length ? `${parts[0]}: timed out` : "Timed out"
    }

    parts.push(error.message || error.name)
    const joined = parts.join(": ")
    return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined
  }
  if (typeof error === "string") return error.slice(0, 500)
  return "Unknown error"
}
