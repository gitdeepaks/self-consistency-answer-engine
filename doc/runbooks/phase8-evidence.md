# Phase 8 Evidence

## Implementation Ledger

| Item | Status | Evidence / Remaining Gate |
| --- | --- | --- |
| Local monitoring Compose, collector, Prometheus, Grafana, Tempo, Loki | Implemented, live startup pending | Versioned configs in infra/monitoring; no Docker daemon available during implementation |
| Four dashboard provisioning assets | Implemented, rendering pending | service/provider/cost/product JSON; static parsing only |
| Telemetry contract and OTLP translation | Fixture/checker implemented, live verification pending | Run `bun run infra/monitoring/check-translation.js` against local stack; then separately verify runtime-originated data |
| Runtime instrument integration | Separate agent's work, not verified here | Confirm per-process service.instance.id, units, terminal durations including queue wait, zero gauges, bounded label values |
| Sanitized structured log ingestion | Implemented, end-to-end retention/redaction pending | Opt-in finite-enum bridge plus collector allowlist; no raw console scraping |
| SLO/queue/DLQ/breaker/budget alerts | Implemented, PromQL engine validation/firing drills pending | Every alert has a repository-relative runbook link; no paging integration |
| Steady/burst load | Implemented, execution unmeasured | Explicit opt-in and 1..20 shared iterations; completion assertions |
| Chaos | Implemented, not executed | Isolated Compose and restoration traps; application recovery must be asserted separately |
| Staging parity | Implemented, static equality check | No Fly app/resource provisioning or remote checks performed |
| Deploy/rollback workflow | Implemented, staging rehearsal pending | Manual environment gates, pre-deploy old digest, trap before rollout, smoke and rollback verification |
| Migration compatibility | Approval gate only, pending evidence | Test old image on migrated staging schema before approving |
| Capacity claims | **UNMEASURED** | No throughput, latency, error rate, cost or recovery measurements are asserted |

## Local Results

Implementation-time local checks passed: dashboard/YAML/TOML parsing and staging parity, loopback exposure and runbook-link checks, JavaScript parsing, Bash syntax, and both Compose `config --quiet` checks. Mocked Fly/k6/curl tests exercise successful deployment, partial mutation followed by deploy failure, post-deploy smoke failure, rollback failure, and dependency-readiness failure. These mocks make no remote requests and do not prove Fly's live response shape or runtime recovery. See the final implementation report for the exact test count.

Docker CLI/Compose are installed, but the daemon socket is unavailable. k6, promtool and actionlint are not installed locally. Consequently no image build, container startup, actual OTLP translation, PromQL/OTTL execution, dashboard rendering, paid request, chaos injection or remote deployment was performed. All staging/capacity gates above remain pending.

## Load Procedure

k6 must be installed separately; no root package changes. Both profiles use a finite total request budget, not an unbounded arrival-rate executor. `steady` uses one VU with five-second think time after each completion; `burst` uses up to five concurrent VUs. This is a bounded starting probe, not a certified target-RPS benchmark. HTTP metrics suppress dynamic URL tags; never enable HTTP debug/response-body exports with credentials.

Before running: approve a maximum USD amount, set a nonzero `GLOBAL_DAILY_BUDGET_MICRO_CENTS` on **both API and worker**, cap provider accounts, review candidate/evaluator output-token limits and concurrency, and verify remaining balance using `bun run ops spend --days 1 --limit 20`. $1 = 100000000 microcents. Server caps are cached and calls already in flight can overshoot; iteration/token limits bound work but do not guarantee a precise dollar ceiling. `SPEND_CAP_CONFIRMED=yes` attests these checks, it does not configure the server. A production load test is not implied by deployment permission.

```bash
export SCE_BASE_URL=http://127.0.0.1:8788
# Inject SCE_API_KEY from a private secret source; do not put it in shell history.
export ALLOW_PAID_LOAD=yes SPEND_CAP_CONFIRMED=yes
export TEST_ID="phase8-$(date +%s)"
PROFILE=steady MAX_RUNS=6 k6 run infra/load/runs.js
export TEST_ID="phase8-burst-$(date +%s)"
PROFILE=burst MAX_RUNS=10 k6 run infra/load/runs.js
```

Every accepted run is polled for up to 240s; only `COMPLETE` plus nonempty synthesis counts as success. Failed/canceled/timed-out runs fail thresholds. An outstanding run is canceled on timeout, but cancellation does not undo paid calls. A POST transport timeout may leave an accepted run with no known ID; do not retry with a new key blindly. Inspect the synthetic tenant's persisted runs and halt new work if necessary. Overall scenario maxDuration is 30m. p95 < 90s is asserted on the measured completion durations; errors separately fail the completion rate. Record admission latency separately from completion latency.

## Capacity Template

Copy this section into an evidence record after an approved run; keep missing values **UNMEASURED**, never substitute projections for measurements.

| Field | Result |
| --- | --- |
| Test date / operator / approval | UNMEASURED |
| Commit / image digest / migration revision | UNMEASURED |
| Environment / region / VM sizes / API+worker replicas | UNMEASURED |
| DB+Redis tier / network topology / cold starts | UNMEASURED |
| Provider models / timeouts / bulkheads / worker concurrency | UNMEASURED |
| Output token caps / spend cap / provider account cap | UNMEASURED |
| Profile / VUs / requested iterations / completed iterations | UNMEASURED |
| HTTP admission RPS and p50/p95/p99 | UNMEASURED |
| End-to-end completion p50/p95/p99 / errors / timeouts | UNMEASURED |
| Max queue depth / oldest age / DLQ before and after | UNMEASURED |
| CPU / RSS / connections / saturation | UNMEASURED |
| Input/output tokens / persisted USD delta / duplicate charges | UNMEASURED |
| Chaos injection and restoration timestamps / drain duration | UNMEASURED |
| New-image smoke / rollback smoke / old-image digest | UNMEASURED |
| Redaction canary absent from Loki/Tempo / retention verified | UNMEASURED |
| Sanitized artifact locations / limitations / next experiment | UNMEASURED |

## Validation Commands

These are local checks, not deployments:

```bash
bun test infra/ops/assets.test.js infra/ops/deploy.test.js
bash -n infra/ops/deploy.sh infra/ops/smoke.sh infra/chaos/drill.sh
GRAFANA_ADMIN_PASSWORD=validation-only docker compose -f infra/monitoring/compose.yml config --quiet
CHAOS_ENV_FILE=/dev/null docker compose -f infra/chaos/compose.yml config --quiet
docker run --rm -v "$PWD/infra/monitoring:/etc/prometheus:ro" --entrypoint promtool prom/prometheus:v3.2.1 check rules /etc/prometheus/alerts.yml
docker run --rm -v "$PWD/infra/monitoring/collector.yml:/etc/otelcol/config.yaml:ro" otel/opentelemetry-collector-contrib:0.123.0 validate --config=/etc/otelcol/config.yaml
```

Static tests do not execute OTTL or PromQL, render dashboards, test Fly machine JSON against a live app, or prove rollback. The Docker commands and translation fixture must pass before considering monitoring usable. Staging then needs real synthetic completion, all alerts firing/recovery, privacy canaries, old-image/new-schema compatibility, partial-deploy rollback and load/chaos rehearsals. Production approval remains blocked until that evidence exists.
