import { z } from "zod"
import { runEventSchema, type RunEvent } from "./events.ts"

/**
 * Reading an SSE stream, once, for every client.
 *
 * The CLI and the web app both consume `GET /api/runs/:id/events`, and both
 * need the same three things that `EventSource` does not give them: an
 * `Authorization` header, a resume cursor they control, and an `AbortSignal`.
 * So both read the body as a stream and decode frames themselves — and that
 * decoding is exactly the kind of fiddly, easily-wrong code that must not exist
 * twice.
 *
 * Two properties this implementation has that a naive one does not:
 *
 *   - **Frames are split on the blank-line delimiter, not per chunk.** One TCP
 *     read can carry half a frame, or three frames and a fragment. Anything
 *     that parses per chunk works perfectly on localhost and corrupts under
 *     real latency.
 *   - **Every frame is parsed against `runEventSchema`.** This is unvalidated
 *     network input by construction — a keep-alive ping, an event type a newer
 *     server added, a proxy's truncated body. A frame that does not fit the
 *     contract is skipped, which is the only safe thing to do with it; the
 *     alternative is a mistyped object flowing into the UI.
 */

/** One decoded frame: the event, and the cursor to resume from after it. */
export interface StreamedRunEvent {
  event: RunEvent
  /**
   * Durable sequence number, or null for an ephemeral event such as a token
   * delta — which was never written to the log and therefore has no position
   * in it.
   */
  seq: number | null
}

/** The fields of a raw SSE frame this client cares about. */
interface RawFrame {
  id: string | null
  data: string
}

const seqSchema = z.coerce.number().int().positive()

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Split one complete frame into its fields.
 *
 * `data:` lines accumulate and are rejoined with newlines, per the EventSource
 * specification — a JSON body containing a newline arrives as several `data:`
 * lines and is only valid once they are put back together.
 */
export function decodeSseFrame(frame: string): RawFrame | null {
  const dataLines: string[] = []
  let id: string | null = null

  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    else if (line.startsWith("id:")) id = line.slice(3).trim()
  }

  if (dataLines.length === 0) return null
  return { id, data: dataLines.join("\n") }
}

/**
 * Turn a response body into a stream of parsed run events.
 *
 * Takes the body rather than performing the request, because the two callers
 * authenticate differently — the CLI through `hc()` with a bearer token
 * resolved per request, the web app through a Clerk session token fetched in
 * the browser — and neither of those belongs in a decoder.
 *
 * The reader is always cancelled on the way out, including when the consumer
 * abandons the generator early (a user closing a tab), which is what stops an
 * orphaned HTTP connection from holding a worker's SSE slot open.
 */
export async function* readRunEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamedRunEvent> {
  // Decoded with a `TextDecoder` in streaming mode rather than piped through a
  // `TextDecoderStream`: a multi-byte character split across two chunk
  // boundaries has to be held over, and `{ stream: true }` is what does that.
  // Concatenating `String(chunk)` per chunk would corrupt any non-ASCII answer
  // roughly one time in a few thousand — the worst possible frequency.
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")

        const frame = decodeSseFrame(raw)
        if (frame === null) continue

        const parsed = runEventSchema.safeParse(parseJson(frame.data))
        if (!parsed.success) continue

        const seq = frame.id === null ? null : seqSchema.safeParse(frame.id)
        yield {
          event: parsed.data,
          seq: seq === null ? null : seq.success ? seq.data : null,
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
