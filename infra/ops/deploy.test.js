import { test, expect } from 'bun:test';
import { mkdtempSync, copyFileSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['success', 'partial-fails', 'smoke-fails', 'rollback-fails', 'readiness-fails']) {
  test(`deploy recovery: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sce-deploy-test-'));
    try {
      for (const command of ['flyctl', 'k6', 'curl']) {
        const path = join(dir, command);
        copyFileSync(`infra/ops/fixtures/${command}`, path);
        chmodSync(path, 0o700);
      }
      const oldDigest = `sha256:${'a'.repeat(64)}`;
      const newDigest = `sha256:${'b'.repeat(64)}`;
      const state = join(dir, 'state');
      const calls = join(dir, 'calls');
      const smokes = join(dir, 'smokes');
      writeFileSync(state, oldDigest);
      const result = Bun.spawnSync(['bash', 'infra/ops/deploy.sh'], { env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, MOCK_MODE: mode === 'readiness-fails' ? 'success' : mode, MOCK_STATE: state,
        MOCK_READY_STATUS: mode === 'readiness-fails' ? '503' : '200',
        MOCK_CALLS: calls, MOCK_SMOKES: smokes, EVIDENCE_DIR: dir,
        FLY_APP: 'sce-test', FLY_CONFIG: 'fly.staging.toml', NEW_IMAGE: `registry.fly.io/sce-test@${newDigest}`,
        SCE_BASE_URL: 'http://127.0.0.1:1', SCE_API_KEY: 'synthetic',
        TEST_ID: 'mock', ALLOW_PAID_LOAD: 'yes', SPEND_CAP_CONFIRMED: 'yes',
      } });
      expect(readFileSync(join(dir, 'old-image.txt'), 'utf8').trim()).toBe(`registry.fly.io/sce-test@${oldDigest}`);
      expect(result.exitCode).toBe(mode === 'success' ? 0 : 1);
      const invoked = readFileSync(calls, 'utf8').trim().split('\n');
      expect(invoked.length).toBe(mode === 'success' ? 1 : 2);
      if (mode === 'success') {
        expect(existsSync(join(dir, 'after.json'))).toBe(true);
        expect(readFileSync(smokes, 'utf8').trim()).toBe('mock');
      } else {
        expect(invoked[1]).toBe(`registry.fly.io/sce-test@${oldDigest} yes`);
        const rollback = readFileSync(join(dir, 'rollback-result.txt'), 'utf8');
        expect(rollback.trim()).toBe(['rollback-fails', 'readiness-fails'].includes(mode) ? 'FAILED: operator intervention required' : 'verified');
        if (!['rollback-fails', 'readiness-fails'].includes(mode)) expect(readFileSync(smokes, 'utf8')).toContain('mock-rollback');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
