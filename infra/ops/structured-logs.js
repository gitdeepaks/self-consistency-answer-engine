// Opt-in stdin bridge for JSON operational records. Never forwards body/message,
// arbitrary field values, stack traces, or unstructured console lines.
import { createInterface } from 'node:readline';
if (process.env.ALLOW_LOCAL_LOG_FORWARDING !== 'yes') throw new Error('Set ALLOW_LOCAL_LOG_FORWARDING=yes');
const service = process.env.SCE_LOG_SERVICE;
if (!['sce-api', 'sce-worker'].includes(service)) throw new Error('SCE_LOG_SERVICE must be sce-api or sce-worker');
const allowed = {
  provider: ['openai', 'anthropic', 'google'],
  operation: ['candidate', 'synthesis', 'enqueue', 'reap', 'rollup', 'webhook'],
  outcome: ['ok', 'error', 'timeout', 'canceled', 'skipped', 'complete', 'failed'],
  state: ['waiting', 'active', 'delayed', 'failed', 'completed', 'waiting-children'],
};
const levels = { info: 9, warn: 13, error: 17 };
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 16384) continue;
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  if (!record || !Object.hasOwn(levels, record.level) || typeof record.timestamp !== 'string') continue;
  const attributes = Object.entries(allowed).filter(([key, values]) => values.includes(record[key]))
    .map(([key]) => ({ key, value: { stringValue: record[key] } }));
  const result = await fetch('http://127.0.0.1:4318/v1/logs', {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [
      { key: 'service.name', value: { stringValue: service } },
    ] }, scopeLogs: [{ scope: { name: 'sce-safe-logs' }, logRecords: [{
      timeUnixNano: String(BigInt(Date.now()) * 1000000n), severityNumber: levels[record.level],
      body: { stringValue: 'structured operational event' }, attributes,
    }] }] }] }),
  });
  if (!result.ok) throw new Error(`Local log collector returned ${result.status}`);
}
