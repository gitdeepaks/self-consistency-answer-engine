// Explicit local integration check. Sends only synthetic OTLP, never model calls.
const endpoint = 'http://127.0.0.1:4318/v1/metrics';
const now = String(BigInt(Date.now()) * 1000000n);
const start = String(BigInt(Date.now() - 60000) * 1000000n);
const attributes = Object.entries({ method: 'POST', route: '/v1/runs', status_class: '2xx', provider: 'openai',
  operation: 'candidate', outcome: 'ok', direction: 'input', queue: 'candidate', state: 'waiting',
  tenant_id: 'MUST_NOT_EXPORT' }).map(([key, value]) => ({ key, value: { stringValue: value } }));
const point = { startTimeUnixNano: start, timeUnixNano: now, attributes };
const counters = ['http.requests', 'run.created', 'run.completed', 'provider.calls', 'candidate.completed',
  'synthesis.completed', 'tokens', 'cost.microcents', 'cache.requests', 'budget.tripped', 'feedback'];
const histograms = ['http.duration', 'run.duration', 'provider.duration'];
// Unitless: the exporter appends no `_seconds`, so this ratio keeps its own list.
const ratios = ['run.confidence'];
const gauges = ['queue.depth', 'queue.age', 'provider.breaker.open'];
const metrics = [
  ...counters.map(name => ({ name: `sce.${name}`, sum: { aggregationTemporality: 2, isMonotonic: true,
    dataPoints: [{ ...point, asDouble: 1 }] } })),
  ...histograms.map(name => ({ name: `sce.${name}`, unit: 's', histogram: { aggregationTemporality: 2,
    dataPoints: [{ ...point, count: '1', sum: 1, explicitBounds: [1, 90], bucketCounts: ['1', '0', '0'] }] } })),
  ...ratios.map(name => ({ name: `sce.${name}`, histogram: { aggregationTemporality: 2,
    dataPoints: [{ ...point, count: '1', sum: 0.8, explicitBounds: [0.5, 1], bucketCounts: ['0', '1', '0'] }] } })),
  ...gauges.map(name => ({ name: `sce.${name}`, gauge: { dataPoints: [{ ...point, asDouble: 1 }] } })),
  { name: 'sce.sse.connections', sum: { aggregationTemporality: 2, isMonotonic: false,
    dataPoints: [{ ...point, asDouble: 1 }] } },
];
const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resourceMetrics: [{ resource: { attributes: [
    { key: 'service.name', value: { stringValue: 'sce-contract-check' } },
    { key: 'service.instance.id', value: { stringValue: 'synthetic' } },
  ] }, scopeMetrics: [{ scope: { name: 'sce-contract-check' }, metrics }] }] }) });
if (!response.ok) throw new Error(`OTLP rejected: ${response.status}`);
const accepted = await response.json();
if (Number(accepted.partialSuccess?.rejectedDataPoints || 0)) throw new Error('OTLP partially rejected');
const expected = [
  ...counters.map(n => `sce_${n.replaceAll('.', '_')}_total`),
  ...histograms.flatMap(n => ['bucket', 'count', 'sum'].map(s => `sce_${n.replaceAll('.', '_')}_seconds_${s}`)),
  ...ratios.flatMap(n => ['bucket', 'count', 'sum'].map(s => `sce_${n.replaceAll('.', '_')}_${s}`)),
  'sce_queue_depth', 'sce_queue_age_seconds', 'sce_provider_breaker_open', 'sce_sse_connections',
];
await Bun.sleep(20000);
const query = encodeURIComponent('{job="sce-contract-check",instance="synthetic",__name__=~"sce_.*"}');
const res = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${query}`);
const data = await res.json();
if (!res.ok || data.status !== 'success') throw new Error('Prometheus query failed');
const series = data.data.result.map(item => item.metric);
for (const name of expected) if (!series.some(s => s.__name__ === name)) throw new Error(`Missing translated metric: ${name}`);
if (series.some(s => 'tenant_id' in s)) throw new Error('Tenant label escaped allowlist');
if (!series.some(s => s.__name__ === 'sce_run_duration_seconds_bucket' && s.le === '90')) throw new Error('Missing SLO bucket');
console.log(`Verified ${expected.length} translated series names, 90s histogram boundary, and tenant-label removal.`);
