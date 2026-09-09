import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
const text = path => readFileSync(path, 'utf8');
const yaml = path => Bun.YAML.parse(text(path));

test('staging mirrors production except app identity', () => {
  const prod = Bun.TOML.parse(text('fly.toml'));
  const staging = Bun.TOML.parse(text('fly.staging.toml'));
  expect(staging.app).not.toBe(prod.app);
  delete prod.app;
  delete staging.app;
  expect(staging).toEqual(prod);
});
test('all added host ports bind loopback; no console scraping or Docker socket', () => {
  for (const path of ['infra/monitoring/compose.yml', 'infra/chaos/compose.yml']) {
    const config = yaml(path);
    for (const service of Object.values(config.services)) {
      for (const port of service.ports || []) expect(port.startsWith('127.0.0.1:')).toBe(true);
      for (const volume of service.volumes || []) expect(volume).not.toMatch(/docker.sock|\.log|\/var\/log/);
    }
  }
});
test('alerts have real runbooks and both SLO burn windows', () => {
  const rules = yaml('infra/monitoring/alerts.yml').groups.flatMap(g => g.rules);
  for (const rule of rules) {
    const [path, anchor] = rule.annotations.runbook_url.split('#');
    expect(existsSync(path)).toBe(true);
    if (anchor) expect(text(path).toLowerCase()).toContain(`## ${anchor}`);
  }
  for (const slo of ['Availability', 'Latency']) {
    expect(rules.find(r => r.alert === `SCE${slo}FastBurn`).expr).toMatch(/\[1h\][\s\S]*\[5m\]/);
    expect(rules.find(r => r.alert === `SCE${slo}SlowBurn`).expr).toMatch(/\[6h\][\s\S]*\[30m\]/);
  }
});
test('dashboards parse and datasource UIDs are provisioned', () => {
  const sources = yaml('infra/monitoring/grafana/provisioning/datasources/default.yml').datasources.map(s => s.uid);
  for (const name of ['service', 'provider', 'cost', 'product']) {
    const dashboard = JSON.parse(text(`infra/monitoring/grafana/dashboards/${name}.json`));
    expect(dashboard.uid).toBe(`sce-${name}`);
    for (const panel of dashboard.panels) {
      if (panel.datasource) expect(sources).toContain(panel.datasource.uid);
      for (const target of panel.targets || []) expect(target.expr).not.toMatch(/tenant|user_id|run_id/);
    }
  }
});
test('collector privacy precedes every exporter; time units and suffixes explicit', () => {
  const c = yaml('infra/monitoring/collector.yml');
  expect(Object.keys(c.receivers)).toEqual(['otlp']);
  for (const p of Object.values(c.service.pipelines)) expect(p.processors).toContain('transform/privacy');
  expect(c.exporters.prometheus.add_metric_suffixes).toBe(true);
  expect(text('infra/monitoring/collector.yml')).toContain('set(unit, "s") where name == "sce.queue.age"');
  expect(text('infra/monitoring/collector.yml')).toContain('set(body, "structured operational event")');
});
test('deploy is manual, serialized, gated, and rolls back partial deploys', () => {
  const workflow = yaml('.github/workflows/deploy.yml');
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  expect(workflow.jobs.deploy.if).toContain('migration_compatible');
  const script = text('infra/ops/deploy.sh');
  expect(script.indexOf('trap rollback EXIT')).toBeLessThan(script.indexOf('attempted=1'));
  expect(script).toContain('--skip-release-command');
  expect(script).toContain('verify_image "$OLD_IMAGE"');
});
test('JavaScript assets parse without executing k6 or making requests', () => {
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  for (const path of ['infra/load/runs.js', 'infra/ops/structured-logs.js', 'infra/monitoring/check-translation.js'])
    expect(() => transpiler.transformSync(text(path))).not.toThrow();
});

/*
 * The four artefacts that describe the same metrics — the instruments the code
 * may publish, the runbook's contract table, the OTLP translation checker, and
 * the PromQL in the alerts and dashboards — drift silently: a panel that charts
 * an instrument nobody emits renders empty, and nothing else complains.
 */
const promName = (otlp, unit) => {
  const base = `sce_${otlp.slice('sce.'.length).replaceAll('.', '_')}`;
  if (otlp.endsWith('.duration')) return `${base}_seconds`;
  if (otlp === 'sce.queue.age') return `${base}_seconds`;
  return unit === 'counter' ? `${base}_total` : base;
};
test('instruments, contract table, translation checker and PromQL agree', async () => {
  const { instrumentNames } = await import('../../packages/observability/src/index.ts');
  const declared = new Set(instrumentNames);

  const contract = new Map(
    [...text('doc/runbooks/phase8-operations.md').matchAll(/^\| (sce\.[a-z.]+) \| (\w+)[^|]*\|[^|]*\| (sce_\w+) \|$/gm)]
      .map(([, otlp, kind, prometheus]) => [otlp, { kind: kind.toLowerCase(), prometheus }]));
  expect([...contract.keys()].sort()).toEqual([...declared].sort());
  for (const [otlp, { kind, prometheus }] of contract)
    expect(prometheus).toBe(promName(otlp, kind === 'counter' ? 'counter' : 'other'));

  // The checker must exercise every declared instrument, or "translation
  // verified" means only "the instruments I remembered were verified".
  const checker = text('infra/monitoring/check-translation.js');
  for (const otlp of declared)
    expect(checker.includes(`'${otlp.slice('sce.'.length)}'`) || checker.includes(`'${otlp}'`),
      `${otlp} is never sent by the translation checker`).toBe(true);

  // Every series charted or alerted on must be one the contract produces.
  const bases = new Set([...contract].map(([otlp, { prometheus }]) => prometheus));
  const promql = [text('infra/monitoring/alerts.yml'),
    ...['service', 'provider', 'cost', 'product'].map(n => text(`infra/monitoring/grafana/dashboards/${n}.json`))].join('\n');
  for (const [, series] of promql.matchAll(/\b(sce_\w+)\b/g))
    expect(bases.has(series.replace(/_(bucket|count|sum)$/, '')), `${series} is charted but not in the metric contract`).toBe(true);
});
