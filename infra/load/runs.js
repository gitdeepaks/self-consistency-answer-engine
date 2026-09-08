import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { POLL_SECONDS, CREATE_HTTP_SECONDS, POLL_HTTP_SECONDS, POLL_INTERVAL_SECONDS,
  CANCEL_HTTP_SECONDS, THINK_SECONDS, ITERATION_SECONDS, scenarioDuration } from './budget.js';

const profile = __ENV.PROFILE || 'steady';
const runs = Number(__ENV.MAX_RUNS || 6);
if (!['steady', 'burst'].includes(profile) || !Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error('PROFILE must be steady/burst; MAX_RUNS must be 1..20');
if (__ENV.ALLOW_PAID_LOAD !== 'yes' || !__ENV.SCE_API_KEY || !__ENV.SCE_BASE_URL ||
    __ENV.SPEND_CAP_CONFIRMED !== 'yes' || !__ENV.TEST_ID)
  throw new Error('Explicit paid-load opt-in, isolated credentials, TEST_ID and confirmed server/provider spend caps required');
if (!/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(__ENV.SCE_BASE_URL))
  throw new Error('Use an HTTPS origin or loopback HTTP origin, without trailing slash');
if (!/^[A-Za-z0-9_-]{1,80}$/.test(__ENV.TEST_ID)) throw new Error('TEST_ID must be an opaque 1..80 character test marker');
const completed = new Rate('run_completed');
const duration = new Trend('run_completion_seconds');
const finished = new Counter('run_iterations_finished');
export const options = {
  scenarios: { runs: { executor: 'shared-iterations', vus: profile === 'burst' ? Math.min(5, runs) : 1,
    iterations: runs, maxDuration: scenarioDuration(runs), gracefulStop: `${ITERATION_SECONDS}s` } },
  thresholds: { run_completed: ['rate==1'], run_completion_seconds: ['p(95)<90'], checks: ['rate==1'],
    run_iterations_finished: [`count==${runs}`] },
  // Never put run IDs or credential-bearing URLs in metric labels.
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
};
export function setup() { finished.add(0); }
export function handleSummary(data) {
  const count = data.metrics.run_iterations_finished?.values.count || 0;
  const failed = Object.values(data.metrics).some(metric => Object.values(metric.thresholds || {}).some(t => !t.ok));
  return { stdout: `${JSON.stringify({ expectedIterations: runs, finishedIterations: count,
    status: count === runs && !failed ? 'PASS' : 'FAILED_RECONCILE_SYNTHETIC_RUNS',
    reconciliation: 'After any interruption, inspect this TEST_ID in the synthetic tenant persisted runs; cancel outstanding runs and compare metered spend. No summary after hard kill also requires reconciliation.' })}\n` };
}
export default function () {
  try {
  const headers = { Authorization: `Bearer ${__ENV.SCE_API_KEY}`, 'Content-Type': 'application/json',
    'Idempotency-Key': `phase8-${__ENV.TEST_ID}-${__VU}-${__ITER}` };
  const start = Date.now();
  const response = http.post(`${__ENV.SCE_BASE_URL}/v1/runs`, JSON.stringify({
    prompt: `Synthetic ops check ${__ENV.TEST_ID}-${__VU}-${__ITER}: name three sorting algorithms briefly.`,
  }), { headers, timeout: `${CREATE_HTTP_SECONDS}s`, tags: { name: 'POST /v1/runs' } });
  if (!check(response, { accepted: r => r.status === 201 })) { completed.add(false); return; }
  let run;
  try { run = response.json(); } catch { completed.add(false); return; }
  const id = run.id;
  if (typeof id !== 'string') { completed.add(false); return; }
  while (Date.now() - start < POLL_SECONDS * 1000) {
    const poll = http.get(`${__ENV.SCE_BASE_URL}/v1/runs/${encodeURIComponent(id)}`, {
      headers, timeout: `${POLL_HTTP_SECONDS}s`, tags: { name: 'GET /v1/runs/:id' },
    });
    if (poll.status === 200) {
      try { run = poll.json(); } catch { break; }
      if (['COMPLETE', 'FAILED', 'CANCELED'].includes(run.status)) break;
    }
    sleep(POLL_INTERVAL_SECONDS);
  }
  const ok = run.status === 'COMPLETE' && Boolean(run.synthesis?.finalAnswer);
  completed.add(ok);
  check(run, { 'completed with synthesis': () => ok });
  duration.add((Date.now() - start) / 1000);
  if (!['COMPLETE', 'FAILED', 'CANCELED'].includes(run.status))
    http.post(`${__ENV.SCE_BASE_URL}/v1/runs/${encodeURIComponent(id)}/cancel`, null,
      { headers, timeout: `${CANCEL_HTTP_SECONDS}s`, tags: { name: 'POST /v1/runs/:id/cancel' } });
  if (profile === 'steady') sleep(THINK_SECONDS);
  } finally {
    finished.add(1);
  }
}
