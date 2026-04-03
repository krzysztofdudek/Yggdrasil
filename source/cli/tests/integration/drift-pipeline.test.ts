import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../src/core/graph-loader.js';
import { detectDrift, syncDriftState } from '../../src/core/drift-detector.js';
import { writeDriftState } from '../../src/io/drift-state-store.js';

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
      // Restore original drift-state fixture for other tests
      await writeDriftState(graph.rootPath, {
        'auth/auth-api': {
          hash: 'a2eb7b76ae118cbdc298b76bc3a9fdc1d3762a6eb91bfa9b2ebacc83dc5d3024',
          files: {
            '.yggdrasil/model/auth/auth-api/yg-node.yaml':
              '3d098d77d943adbd7f5c4bc4e706fa1af240478000e134a9b2915bc90872b073',
            '.yggdrasil/model/auth/auth-api/interface.md':
              '0f51ce7dfb041e50cce9724dad79a1d3f4f33cedff1cbbff711d9b8f3dacfa63',
            '.yggdrasil/model/auth/auth-api/responsibility.md':
              '53a9a8691ed075666bd983cf1b9e65dd970a0b617f71a36dccce7923c6dd8e7c',
            '.yggdrasil/model/auth/yg-node.yaml':
              '014a364b08a9cb75f573fa0bf6dfbf81599bce937127bc3d1bd642950b4e26ce',
            '.yggdrasil/model/auth/responsibility.md':
              '1b01b640496a7015c5351d9b0015789faad8ad44c7b0c14f8ef567227f64321a',
            '.yggdrasil/aspects/requires-logging/yg-aspect.yaml':
              '08dd592c74f6889713e09c899e003badf00430c7d25a74768449eb0d7fb7beb0',
            '.yggdrasil/aspects/requires-logging/content.md':
              '13fff2681612d392624588850569f287bb450307e2ee9750987b281279dd64f3',
            '.yggdrasil/flows/checkout-flow/yg-flow.yaml':
              '6541aeb6cea1ad1047151018ce2869b4dcae297728573b9cc1bef76b50cb2c34',
            '.yggdrasil/flows/checkout-flow/description.md':
              '84056fed046bd51b834af307ee1208c4617eca1df652773c84e4c18f96bcf0fa',
            '.yggdrasil/flows/checkout-flow/sequence.md':
              '0d361f1ec1dcc665108a03c10286cbac679e52dba14b8ddaf3a48d31f7effbe8',
            'src/auth/auth.controller.ts':
              '5386573056ba5e059eb98f3615d57c3680dc888f003b197584805429d6df3521',
            'src/auth/login.service.ts':
              '5d5bbfd0dc749783000cff2f27ca31212044629a99746a8508d32b3f8ec7c344',
          },
        },
        'orders/order-service': {
          hash: '0000000000000000000000000000000000000000000000000000000000000000',
          files: {
            'src/orders/order.service.ts':
              '0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
        'users/missing-service': {
          hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          files: {
            'src/users/missing.service.ts':
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      });
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
      path.join(yggRoot, 'yg-config.yaml'),
      'name: X\nnode_types:\n  service:\n    description: x\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );
    await writeFile(path.join(modelDir, 'svc', 'yg-node.yaml'), 'name: svc\ntype: module\n');
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
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

  it('blackbox nodes excluded from drift pipeline', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'ygg-drift-bb-'));
    const yggRoot = path.join(projectRoot, '.yggdrasil');

    // Create .yggdrasil structure with two nodes
    await mkdir(path.join(yggRoot, 'model', 'svc', 'regular'), { recursive: true });
    await mkdir(path.join(yggRoot, 'model', 'svc', 'blackbox-svc'), { recursive: true });

    // Config
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'name: bb-test\nnode_types:\n  service:\n    description: svc\n  module:\n    description: mod\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );

    // Parent node
    await writeFile(path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'), 'name: svc\ntype: module\n');

    // Regular node with mapping
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'regular', 'yg-node.yaml'),
      'name: regular\ntype: service\nmapping:\n  - paths:\n      - src/regular.ts\n',
    );
    await writeFile(path.join(yggRoot, 'model', 'svc', 'regular', 'responsibility.md'), 'Regular node');

    // Blackbox node with mapping
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'blackbox-svc', 'yg-node.yaml'),
      'name: blackbox-svc\ntype: service\nblackbox: true\nmapping:\n  - paths:\n      - src/blackbox/\n',
    );
    await writeFile(path.join(yggRoot, 'model', 'svc', 'blackbox-svc', 'responsibility.md'), 'Blackbox node');

    // Create source files
    await mkdir(path.join(projectRoot, 'src', 'blackbox'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'regular.ts'), '// regular code');
    await writeFile(path.join(projectRoot, 'src', 'blackbox', 'index.ts'), '// blackbox internals');

    try {
      const graph = await loadGraph(projectRoot);

      // Sync the regular node
      await syncDriftState(graph, 'svc/regular');

      // Detect drift
      const report = await detectDrift(graph);

      // Regular node should be in the report
      const regularEntry = report.entries.find((e) => e.nodePath === 'svc/regular');
      expect(regularEntry).toBeDefined();
      expect(regularEntry!.status).toBe('ok');

      // Blackbox node should NOT be in the report
      const bbEntry = report.entries.find((e) => e.nodePath === 'svc/blackbox-svc');
      expect(bbEntry).toBeUndefined();

      // Total checked should only count non-blackbox nodes
      expect(report.entries.every((e) => e.nodePath !== 'svc/blackbox-svc')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('check <invalid-flag> returns error for unknown option', async () => {
    if (!distExists) return;

    const result = spawnSync('node', [BIN_PATH, 'check', '--format', 'yaml'], {
      cwd: FIXTURE_PROJECT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown option|--format/);
  });
});
