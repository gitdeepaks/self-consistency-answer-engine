import { afterAll, expect, test } from "bun:test"
import { context, metrics as apiMetrics, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics"
import { aiTelemetry, captureTraceContext, logRecord, metrics, PrivateSpanExporter, telemetryConfig, withSpan } from "./index.ts"

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new PrivateSpanExporter(exporter))] })
const manager = new AsyncLocalStorageContextManager().enable()
context.setGlobalContextManager(manager)
trace.setGlobalTracerProvider(provider)
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const meter = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 })] })
apiMetrics.setGlobalMeterProvider(meter)

afterAll(async () => { await provider.shutdown(); await meter.shutdown(); manager.disable(); context.disable(); trace.disable(); apiMetrics.disable() })

test("disabled by default and configuration errors never reveal values", () => {
  expect(telemetryConfig({}).SCE_TELEMETRY_ENABLED).toBe("false")
  expect(aiTelemetry("candidate")).toEqual({ isEnabled: false, recordInputs: false, recordOutputs: false, functionId: "candidate" })
  expect(() => telemetryConfig({ SCE_TELEMETRY_ENABLED: "secret" })).toThrow("Invalid telemetry configuration")
  expect(() => telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@host" })).toThrow("Invalid telemetry endpoint")
})

test("serialized carrier continues a parent with async context isolation", async () => {
  const carriers = await Promise.all(["one", "two"].map((name) => withSpan(name, {}, async () => {
    const before = captureTraceContext()
    await Bun.sleep(5)
    expect(captureTraceContext()).toEqual(before)
    expect(logRecord("info", "test")).toContain(trace.getSpan(context.active())?.spanContext().traceId ?? "missing")
    return before
  })))
  expect(carriers[0]).not.toEqual(carriers[1])
  await withSpan("consumer", {}, async () => {}, carriers[0])
  const spans = exporter.getFinishedSpans()
  const parent = spans.find((span) => span.name === "one")
  const child = spans.find((span) => span.name === "consumer")
  expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId)
  expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId)
  expect(captureTraceContext()).toEqual({})
})

test("exceptions and AI SDK sensitive attributes are sanitized", async () => {
  await expect(withSpan("failing", { prompt: "private question" }, async () => {
    trace.getSpan(context.active())?.setAttribute("ai.prompt.messages", "private question")
    trace.getSpan(context.active())?.recordException(new Error("sk-secret private question"))
    throw new Error("private question")
  })).rejects.toThrow("private question")
  const serialized = JSON.stringify(exporter.getFinishedSpans().filter((span) => span.name === "failing").map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })))
  expect(serialized).not.toContain("private question")
  expect(serialized).not.toContain("sk-secret")
  expect(logRecord("error", "Operation failed", { error: "private question", authorization: "Bearer secret", runId: "run-1" })).not.toContain("private question")
  expect(logRecord("error", "Bearer secret")).not.toContain("Bearer secret")
})

test("in-memory metrics exclude IDs and balance lifecycle deltas", async () => {
  metrics.count("sce.http.requests", 1, { route: "/v1/runs", method: "POST", status_class: "2xx", runId: "private-id" })
  metrics.histogram("sce.http.duration", 0.25, { route: "/v1/runs" })
  metrics.adjust("sce.sse.connections", 1)
  metrics.adjust("sce.sse.connections", -1)
  metrics.gauge("sce.queue.depth", 3, { queue: "candidate", state: "wait" })
  await meter.forceFlush()
  const data = metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
  expect(JSON.stringify(data)).not.toContain("private-id")
  expect(data.find((metric) => metric.descriptor.name === "sce.sse.connections")?.dataPoints[0]?.value).toBe(0)
  expect(data.find((metric) => metric.descriptor.name === "sce.queue.depth")?.dataPoints[0]?.value).toBe(3)
})

test("NodeSDK exports OTLP HTTP only when enabled and flushes on shutdown", async () => {
  const paths: string[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    paths.push(new URL(request.url).pathname)
    await request.arrayBuffer()
    return Response.json({})
  } })
  try {
    for (const enabled of ["false", "true"]) {
      const child = Bun.spawn([process.execPath, "-e", `
        import { initializeTelemetry, shutdownTelemetry, withSpan, metrics } from './index.ts';
        initializeTelemetry('test-service');
        await withSpan('test-operation', {}, async () => {});
        metrics.count('sce.run.created', 1);
        await shutdownTelemetry();
      `], { cwd: import.meta.dir, env: { ...process.env, SCE_TELEMETRY_ENABLED: enabled, OTEL_SDK_DISABLED: "false", OTEL_EXPORTER_OTLP_ENDPOINT: server.url.toString(), OTEL_TRACES_SAMPLER_ARG: "1" }, stdout: "pipe", stderr: "pipe" })
      const output = await new Response(child.stderr).text()
      expect(await child.exited, output).toBe(0)
      if (enabled === "false") expect(paths).toEqual([])
    }
    expect(paths).toContain("/v1/traces")
    expect(paths).toContain("/v1/metrics")
  } finally {
    await server.stop(true)
  }
})
