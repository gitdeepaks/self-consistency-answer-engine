# Streaming

```
GET /v1/runs/{runId}/events
Accept: text/event-stream
Authorization: Bearer sce_live_…
```

A Server-Sent Events stream of one run's lifecycle. It closes on `run.completed`,
`run.failed` or `run.canceled`.

## The frame

```
event: candidate.settled
id: 17
data: {"type":"candidate.settled","runId":"clx…","candidate":{…}}

```

| Part    |                                                                                    |
| ------- | ---------------------------------------------------------------------------------- |
| `event` | The event's `type`. Convenient for `addEventListener`; the same value is in `data` |
| `id`    | The **durable sequence number** — the resume cursor. Absent on ephemeral events    |
| `data`  | One JSON `RunEvent`                                                                |

Frames are separated by a blank line. Split on the blank line, not per chunk: one TCP read can
carry half a frame, or three frames and a fragment. Parsing per chunk works perfectly on
localhost and corrupts under real latency.

## The events

| `type`              | Carries                                                         | Durable |
| ------------------- | --------------------------------------------------------------- | ------- |
| `run.snapshot`      | The whole run, as it stands. Sent first on a fresh subscription | no      |
| `run.status`        | `status` — `QUEUED`, `FANNING_OUT`, `SYNTHESIZING`              | yes     |
| `candidate.started` | `candidateId`                                                   | yes     |
| `candidate.delta`   | `candidateId`, `text` — a chunk of that model's answer          | **no**  |
| `candidate.settled` | The complete candidate, with its answer, tokens and timing      | yes     |
| `synthesis.started` | `model` — the evaluator                                         | yes     |
| `synthesis.settled` | The synthesis: final answer, agreements, disagreements, reviews | yes     |
| `run.completed`     | `totalLatencyMs` — **terminal**                                 | yes     |
| `run.failed`        | `error` — **terminal**                                          | yes     |
| `run.canceled`      | `reason` — **terminal**                                         | yes     |

Plus `ping`, a keep-alive with no meaning, sent so intermediaries do not close an idle
connection. Ignore it.

**Deltas are ephemeral.** A run produces thousands of them and they are never written to the
durable log, so they have no `id` and are not replayed. Nothing is lost by missing them: the
`candidate.settled` that follows carries the complete text. A reconnecting client loses
animation, not content.

**Handle the union exhaustively, and tolerate additions.** New event types are additive and may
appear at any time. A `switch` with a `default` that ignores the unknown is correct; one that
throws will break on our next release.

## Reconnecting

Every durable event's `id` is its position in the run's log. Send the last one you saw and the
stream replays from just after it:

```http
GET /v1/runs/clx…/events
Last-Event-ID: 17
```

or, for clients that are not `EventSource`:

```http
GET /v1/runs/clx…/events?afterSeq=17
```

The header wins when both are present, because a browser that has one is telling you where it
actually got to. A malformed `Last-Event-ID` — which is what a truncated frame produces —
replays from the beginning rather than being refused: seeing every event twice is a client that
works.

Replay comes from Postgres and the live tail from Redis, so **any replica can serve any run's
stream**, including one started on a machine that has since been replaced. There is no sticky
session to arrange.

## Runs that finished before you connected

Subscribing to a run that is already over does not hang. The stream sends a `run.snapshot`
followed by the terminal event, both without ids, and closes.

## `EventSource` is usually the wrong tool

It cannot send an `Authorization` header, cannot be aborted cleanly, and chooses its own resume
point. Read the body as a stream instead:

```ts
const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
  headers: { authorization: `Bearer ${apiKey}`, "last-event-id": String(afterSeq) },
  signal: controller.signal,
})

for await (const { event, seq } of readRunEventStream(response.body!)) {
  if (event.type === "candidate.delta") process.stdout.write(event.text)
}
```

`readRunEventStream` is exported from `@sce/sdk`. It handles the frame boundaries, holds over
multi-byte characters split across chunks, and parses every frame against the `RunEvent`
schema — dropping anything malformed rather than letting a mistyped object into your code.

Or just use the client:

```ts
for await (const { event } of sce.runs.stream(runId, { afterSeq: 17, signal })) { … }
```

## Cancelling

Abort the request and the stream ends — but the run keeps going, and keeps costing. Cancel it
too:

```ts
await sce.runs.cancel(runId, "user navigated away")
```

`sce.ask()` does this for you when its `signal` aborts.

## Timeouts

The stream has no server-side timeout; the run's own deadline governs. Do not apply a client
request timeout to it — a run legitimately takes minutes. Use an `AbortSignal` you control, and
rely on the `ping` frames to notice a dead connection.
