import { context, trace, metrics as otelMetrics, ROOT_CONTEXT, SpanStatusCode, type Counter, type Histogram, type Gauge, type UpDownCounter, type Attributes as OtelAttributes, type SpanContext } from "@opentelemetry/api"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { ExportResult } from "@opentelemetry/core"
import { z } from "zod"

export type TraceCarrier = { traceparent?: string; tracestate?: string }
type Attributes = Record<string, string | number | boolean>
type Fields = Record<string, string | number | boolean | null>
const propagator = new W3CTraceContextPropagator()
const carrierSchema = z.object({
  traceparent: z.string().regex(/^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/).optional(),
  tracestate: z.string().max(512).refine((value) => {
    const entries = value.split(",").map((entry) => entry.trim())
    return entries.length <= 32 && new Set(entries.map((entry) => entry.split("=")[0])).size === entries.length && entries.every((entry) => /^(?:[a-z][a-z0-9_*\/-]{0,255}|[a-z0-9][a-z0-9_*\/-]{0,240}@[a-z][a-z0-9_*\/-]{0,13})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/.test(entry))
  }).optional(),
})

export function captureTraceContext(): TraceCarrier {
  const carrier: Record<string, string> = {}
  propagator.inject(context.active(), carrier, { set: (target, key, value) => { target[key] = value } })
  return carrierSchema.parse(carrier)
}

export async function withSpan<T>(name: string, attributes: Attributes, operation: () => Promise<T>, carrier?: TraceCarrier): Promise<T> {
  const parsed = carrierSchema.safeParse(carrier)
  const parent = carrier === undefined ? context.active() : propagator.extract(ROOT_CONTEXT, parsed.success ? parsed.data : {}, {
    keys: (target) => Object.keys(target),
    get: (target, key) => key === "traceparent" ? target.traceparent : key === "tracestate" ? target.tracestate : undefined,
  })
  return trace.getTracer("@sce/observability").startActiveSpan(name, { attributes: safeFields(attributes) }, parent, async (span) => {
    try {
      return await operation()
    } catch (error) {
      // Never recordException: SDK/provider errors can contain prompts and secrets.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Operation failed" })
      span.addEvent("exception", { "exception.type": "Error", "exception.message": "Operation failed" })
      throw error
    } finally {
      span.end()
    }
  })
}

export function markSpanFailed(): void {
  trace.getSpan(context.active())?.setStatus({ code: SpanStatusCode.ERROR, message: "Operation failed" })
}

const sensitive = /prompt|completion|input|output|authorization|cookie|secret|password|api.?key|credential|body|stack|error|message|url|query/i
/** Applies to all spans, including AI SDK spans which may attach raw exceptions. */
export class PrivateSpanExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const clean = (attributes: OtelAttributes): OtelAttributes => Object.fromEntries(Object.entries(attributes).filter(([key]) => !sensitive.test(key) && /^(tenantId|runId|candidateId|deliveryId|provider|operation|outcome|method|route|type|queue|state|attempt|(run|candidate|job|tenant|delivery)\.(id|attempt|max_attempts)|ai\.model\.(id|provider)|ai\.usage\.(inputTokens|outputTokens)|ai\.settings\.(maxOutputTokens|temperature)|operation\.name|resource\.name)$/.test(key)))
    const cleanContext = (source: SpanContext): SpanContext => ({ traceId: source.traceId, spanId: source.spanId, traceFlags: source.traceFlags, isRemote: source.isRemote })
    this.exporter.export(spans.map((span) => ({
      ...span,
      spanContext: () => cleanContext(span.spanContext()),
      parentSpanContext: span.parentSpanContext ? cleanContext(span.parentSpanContext) : undefined,
      links: span.links.map((link) => ({ ...link, context: cleanContext(link.context), attributes: clean(link.attributes ?? {}) })),
      attributes: clean(span.attributes),
      status: { code: span.status.code },
      events: span.events.map((event) => ({ ...event, name: event.name === "exception" ? "exception" : "event", attributes: event.name === "exception" ? { "exception.type": "Error" } : clean(event.attributes ?? {}) })),
    })), callback)
  }
  shutdown(): Promise<void> { return this.exporter.shutdown() }
  async forceFlush(): Promise<void> { await this.exporter.forceFlush?.() }
}
function safeFields(fields: Attributes): Attributes {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sensitive.test(key) ? "[REDACTED]" : typeof value === "string" ? value.slice(0, 256) : value]))
}

export function logRecord(level: string, message: string, fields: Fields = {}): string {
  const span = trace.getSpanContext(context.active())
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sensitive.test(key) ? "[REDACTED]" : typeof value === "string" ? value.slice(0, 256) : value]))
  return JSON.stringify({ ...safe, timestamp: new Date().toISOString(), level, message: message.replace(/Bearer\s+\S+|(?:sk|sce)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+/gi, "[REDACTED]"), ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}) })
}
export const logger = {
  info(message: string, fields?: Fields): void { console.log(logRecord("info", message, fields)) },
  warn(message: string, fields?: Fields): void { console.warn(logRecord("warn", message, fields)) },
  error(message: string, fields?: Fields): void { console.error(logRecord("error", message, fields)) },
}

// Fixed instruments and dimensions prevent identifiers or arbitrary names from creating series.
const counterNames: CounterName[] = ["sce.run.created", "sce.run.completed", "sce.provider.calls", "sce.candidate.completed", "sce.synthesis.completed", "sce.tokens", "sce.cost.microcents", "sce.cache.requests", "sce.http.requests", "sce.budget.tripped", "sce.feedback"]
export type CounterName = "sce.run.created" | "sce.run.completed" | "sce.provider.calls" | "sce.candidate.completed" | "sce.synthesis.completed" | "sce.tokens" | "sce.cost.microcents" | "sce.cache.requests" | "sce.http.requests" | "sce.budget.tripped" | "sce.feedback"
export type HistogramName = "sce.run.duration" | "sce.provider.duration" | "sce.http.duration" | "sce.run.confidence"
export type GaugeName = "sce.queue.depth" | "sce.queue.age" | "sce.provider.breaker.open"
const names = new Set<string>([...counterNames, "sce.run.duration", "sce.provider.duration", "sce.http.duration", "sce.run.confidence", "sce.queue.depth", "sce.queue.age", "sce.provider.breaker.open", "sce.sse.connections"])
const dimensions = new Set(["provider", "operation", "outcome", "direction", "method", "route", "status_class", "queue", "state", "rating"])
const series = new Map<string, Set<string>>()
function metricAttributes(name: string, attributes: Attributes = {}): Attributes | null {
  if (!names.has(name)) return null
  const filtered = Object.fromEntries(Object.entries(attributes).filter(([key]) => dimensions.has(key)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 128) : value]).sort(([a], [b]) => String(a).localeCompare(String(b))))
  const key = JSON.stringify(filtered)
  const seen = series.get(name) ?? new Set<string>()
  if (!seen.has(key) && seen.size >= 256) return null
  seen.add(key)
  series.set(name, seen)
  return filtered
}
const counters = new Map<string, Counter>()
const histograms = new Map<string, Histogram>()
const gauges = new Map<string, Gauge>()
const adjustments = new Map<string, UpDownCounter>()
export const metrics = {
  count(name: CounterName, value: number, attributes?: Attributes): void {
    const attrs = metricAttributes(name, attributes)
    if (!attrs || !Number.isFinite(value) || value < 0) return
    const instrument = counters.get(name) ?? otelMetrics.getMeter("@sce/observability").createCounter(name)
    counters.set(name, instrument)
    instrument.add(value, attrs)
  },
  histogram(name: HistogramName, value: number, attributes?: Attributes): void {
    const attrs = metricAttributes(name, attributes)
    if (!attrs || !Number.isFinite(value) || value < 0) return
    if (name === "sce.run.confidence" && value > 1) return
    const instrument = histograms.get(name) ?? otelMetrics.getMeter("@sce/observability").createHistogram(name, { unit: name === "sce.run.confidence" ? "" : "s", advice: { explicitBucketBoundaries: name === "sce.run.confidence" ? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] : [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90, 120, 300] } })
    histograms.set(name, instrument)
    instrument.record(value, attrs)
  },
  gauge(name: GaugeName, value: number, attributes?: Attributes): void {
    const attrs = metricAttributes(name, attributes)
    if (!attrs || !Number.isFinite(value)) return
    const instrument = gauges.get(name) ?? otelMetrics.getMeter("@sce/observability").createGauge(name, { unit: name === "sce.queue.age" ? "s" : "" })
    gauges.set(name, instrument)
    instrument.record(value, attrs)
  },
  adjust(name: "sce.sse.connections", delta: number, attributes?: Attributes): void {
    const attrs = metricAttributes(name, attributes)
    if (!attrs || !Number.isFinite(delta)) return
    const instrument = adjustments.get(name) ?? otelMetrics.getMeter("@sce/observability").createUpDownCounter(name)
    adjustments.set(name, instrument)
    instrument.add(delta, attrs)
  },
}

const telemetryConfigSchema = z.object({
    SCE_TELEMETRY_ENABLED: z.enum(["true", "false"]).default("false"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default("http://localhost:4318"),
    OTEL_METRIC_EXPORT_INTERVAL: z.coerce.number().int().min(1000).max(300000).default(30000),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
    DEPLOYMENT_ENVIRONMENT: z.enum(["development", "test", "staging", "production"]).default("development"),
  })
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>
export function telemetryConfig(env: Record<string, string | undefined>): TelemetryConfig {
  const parsed = telemetryConfigSchema.safeParse(env)
  if (!parsed.success) throw new Error("Invalid telemetry configuration")
  const url = new URL(parsed.data.OTEL_EXPORTER_OTLP_ENDPOINT)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid telemetry endpoint")
  return parsed.data
}
let sdk: NodeSDK | undefined
let initialized = false
let enabled = false
const instanceId = randomUUID()
export function initializeTelemetry(serviceName: string): void {
  if (initialized) return
  const config = telemetryConfig(process.env)
  counters.clear()
  histograms.clear()
  gauges.clear()
  adjustments.clear()
  enabled = config.SCE_TELEMETRY_ENABLED === "true"
  if (enabled) {
    const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")
    sdk = new NodeSDK({
      autoDetectResources: false,
      logRecordProcessors: [],
      resource: resourceFromAttributes({ "service.name": serviceName, "service.instance.id": instanceId, "deployment.environment.name": config.DEPLOYMENT_ENVIRONMENT }),
      contextManager: new AsyncLocalStorageContextManager(),
      textMapPropagator: propagator,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.OTEL_TRACES_SAMPLER_ARG) }),
      traceExporter: new PrivateSpanExporter(new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 5000 })),
      metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: 5000 }), exportIntervalMillis: config.OTEL_METRIC_EXPORT_INTERVAL })],
    })
    sdk.start()
    // Establish a first sample before an alert's first increment.
    for (const name of counterNames) metrics.count(name, 0)
  }
  initialized = true
}
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown()
}
export function aiTelemetry(functionId: string): { isEnabled: boolean; recordInputs: false; recordOutputs: false; functionId: string } {
  return { isEnabled: enabled, recordInputs: false, recordOutputs: false, functionId }
}
