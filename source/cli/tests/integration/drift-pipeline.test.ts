import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../src/core/graph-loader.js';
import { detectDrift, syncDriftState } from '../../src/core/drift-detector.js';
import { readDriftState, writeDriftState } from '../../src/io/drift-state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../fixtures/sample-project');
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function supportsAbsorbAllOption(): boolean {
  if (!distExists) return false;
  const help = spawnSync('node', [BIN_PATH, 'drift', '--help'], {
    cwd: FIXTURE_PROJECT,
    encoding: 'utf-8',
  });
  return help.status === 0 && help.stdout.includes('--absorb-all');
}

describe('drift-pipeline', () => {
  it('load fixture graph → detectDrift → verify correct states per node', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    // Sync auth/auth-api so it has a valid baseline (including graph files)
    await syncDriftState(graph, 'auth/auth-api');

    try {
      const report = await detectDrift(graph);

      expect(report.totalChecked).toBeGreaterThan(0);
      expect(report.entries.length).toBe(report.totalChecked);

      // OK: auth/auth-api has matching hash (just synced)
      const okEntry = report.entries.find((e) => e.nodePath === 'auth/auth-api' && e.status === 'ok');
      expect(okEntry).toBeDefined();

      // orders/order-service has bogus stored hash — should drift
      const driftEntry = report.entries.find(
        (e) => e.nodePath === 'orders/order-service',
      );
      expect(driftEntry).toBeDefined();
      expect(['source-drift', 'graph-drift', 'full-drift']).toContain(driftEntry!.status);
      expect(driftEntry?.details).toContain('Changed files:');

      // users/missing-service: missing (stored entry exists but source files are gone)
      const missingEntry = report.entries.find((e) => e.nodePath === 'users/missing-service');
      expect(missingEntry).toBeDefined();
      expect(missingEntry!.status).toBe('missing');

      // auth/auth-api entry exists
      const authApiEntry = report.entries.find((e) => e.nodePath === 'auth/auth-api');
      expect(authApiEntry).toBeDefined();

      // Counts match
      expect(report.sourceDriftCount).toBe(report.entries.filter((e) => e.status === 'source-drift').length);
      expect(report.graphDriftCount).toBe(report.entries.filter((e) => e.status === 'graph-drift').length);
      expect(report.fullDriftCount).toBe(report.entries.filter((e) => e.status === 'full-drift').length);
      expect(report.missingCount).toBe(report.entries.filter((e) => e.status === 'missing').length);
      expect(report.unmaterializedCount).toBe(
        report.entries.filter((e) => e.status === 'unmaterialized').length,
      );
      expect(report.okCount).toBe(report.entries.filter((e) => e.status === 'ok').length);
    } finally {
      // Restore original drift-state for other tests
      const origState = await readDriftState(graph.rootPath);
      origState['auth/auth-api'] = {
        hash: '32264f21ff53921976fad6669ff876d5bf67152f62f9a89db803db0de0bcc514',
        files: {
          '.yggdrasil/model/auth/auth-api/node.yaml':
            '40c1087d83ac1b5132e10d3a40beb65af24c6cd13ff6067b7674654e032b4eac',
          '.yggdrasil/model/auth/auth-api/responsibility.md':
            'f47a9cf8d239d70760ae4779ff68a923559ac9ca50762c64b304c802a302cc92',
          '.yggdrasil/model/auth/node.yaml':
            'c609370d51a049baf4013828f66bc1ecf8ec815da99240ea01237ac912974269',
          '.yggdrasil/model/auth/responsibility.md':
            'd3ca07574d55e24a6f0a7e0771019c6f85f40c127cda11da93034675aa8b9fdb',
          '.yggdrasil/aspects/requires-logging/aspect.yaml':
            '08dd592c74f6889713e09c899e003badf00430c7d25a74768449eb0d7fb7beb0',
          '.yggdrasil/aspects/requires-logging/content.md':
            '13fff2681612d392624588850569f287bb450307e2ee9750987b281279dd64f3',
          '.yggdrasil/flows/checkout-flow/flow.yaml':
            '1804e9470685eec45545c5ff94e1da359f244ac0c69ddb3721aaeb98bd3d064b',
          '.yggdrasil/flows/checkout-flow/description.md':
            '84056fed046bd51b834af307ee1208c4617eca1df652773c84e4c18f96bcf0fa',
          '.yggdrasil/flows/checkout-flow/sequence.md':
            '0d361f1ec1dcc665108a03c10286cbac679e52dba14b8ddaf3a48d31f7effbe8',
          'src/auth/auth.controller.ts':
            '5386573056ba5e059eb98f3615d57c3680dc888f003b197584805429d6df3521',
          'src/auth/login.service.ts':
            '5d5bbfd0dc749783000cff2f27ca31212044629a99746a8508d32b3f8ec7c344',
        },
      };
      await writeDriftState(graph.rootPath, origState);
    }
  });

  it('drift --absorb-all reports JSON summary fields', async () => {
    if (!supportsAbsorbAllOption()) return;

    const fixtureCopyRoot = await mkdtemp(path.join(tmpdir(), 'ygg-drift-absorb-'));
    const copiedFixture = path.join(fixtureCopyRoot, 'sample-project');
    await cp(FIXTURE_PROJECT, copiedFixture, { recursive: true });

    try {
      const result = spawnSync('node', [BIN_PATH, 'drift', '--absorb-all', '--format', 'json'], {
        cwd: copiedFixture,
        encoding: 'utf-8',
      });

      const payload = JSON.parse(result.stdout);
      expect(payload).toHaveProperty('absorbedNodes');
      expect(payload).toHaveProperty('skippedMissingNodes');
      expect(payload).toHaveProperty('failedNodes');
      expect(Array.isArray(payload.absorbedNodes)).toBe(true);
      expect(Array.isArray(payload.skippedMissingNodes)).toBe(true);
      expect(Array.isArray(payload.failedNodes)).toBe(true);
    } finally {
      await rm(fixtureCopyRoot, { recursive: true, force: true });
    }
  });

  it('drift --absorb-all exits 1 when absorb attempt fails', async () => {
    if (!supportsAbsorbAllOption()) return;

    const projectRoot = await mkdtemp(path.join(tmpdir(), 'ygg-drift-fail-'));
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const nodeDir = path.join(modelDir, 'svc', 'failing');

    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: X\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );
    await writeFile(path.join(modelDir, 'svc', 'node.yaml'), 'name: svc\ntype: module\n');
    await writeFile(
      path.join(nodeDir, 'node.yaml'),
      'name: failing\ntype: service\nmapping:\n  type: file\n  path: src/not-existing.ts\n',
    );
    await writeFile(path.join(nodeDir, 'description.md'), 'x');
    await writeFile(path.join(yggRoot, '.drift-state'), '{}\n');

    try {
      const result = spawnSync('node', [BIN_PATH, 'drift', '--absorb-all', '--format', 'json'], {
        cwd: projectRoot,
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      if (result.stdout.trim()) {
        const payload = JSON.parse(result.stdout);
        expect(payload.failedNodes?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('drift --format <invalid> returns validation error', async () => {
    if (!distExists) return;

    const result = spawnSync('node', [BIN_PATH, 'drift', '--format', 'yaml'], {
      cwd: FIXTURE_PROJECT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown option|--format/);
  });
});
