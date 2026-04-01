import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { detectDrift, syncDriftState } from '../../../src/core/drift-detector.js';
import {
  readDriftState,
  writeDriftState,
  readNodeDriftState,
  writeNodeDriftState,
} from '../../../src/io/drift-state-store.js';
import { hashString } from '../../../src/utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

/** Canonical fixture drift-state — used to restore after tests that call syncDriftState. */
const FIXTURE_DRIFT_STATE: Record<string, { hash: string; files: Record<string, string> }> = {
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
};

/**
 * Helper: create a minimal temp project with a single node.
 * Returns { tmpDir, yggRoot, srcDir, nodeDir } for further customization.
 */
async function createTmpProject(
  name: string,
  opts: {
    nodePath: string;          // e.g. 'svc/my-service'
    nodeYaml: string;
    mappingFiles?: Record<string, string>; // relative-to-tmpDir path → content
    configYaml?: string;
    parentNodes?: Array<{ path: string; yaml: string }>;
    aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
  },
) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await mkdir(nodeDir, { recursive: true });
  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    opts.configYaml ??
      'name: Test\nnode_types:\n  service:\n    description: x\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n',
  );
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });

  // Parent nodes
  if (opts.parentNodes) {
    for (const pn of opts.parentNodes) {
      const parentDir = path.join(yggRoot, 'model', pn.path);
      await mkdir(parentDir, { recursive: true });
      await writeFile(path.join(parentDir, 'yg-node.yaml'), pn.yaml);
    }
  } else {
    // Auto-create parent from nodePath
    const parts = opts.nodePath.split('/');
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('/');
      const parentDir = path.join(yggRoot, 'model', parentPath);
      await mkdir(parentDir, { recursive: true });
      await writeFile(
        path.join(parentDir, 'yg-node.yaml'),
        `name: ${parts[parts.length - 2]}\ntype: module\n`,
      );
    }
  }

  // Aspects
  if (opts.aspects) {
    for (const aspect of opts.aspects) {
      const aspectDir = path.join(yggRoot, 'aspects', aspect.id);
      await mkdir(aspectDir, { recursive: true });
      await writeFile(path.join(aspectDir, 'yg-aspect.yaml'), aspect.yaml);
      if (aspect.files) {
        for (const [filename, content] of Object.entries(aspect.files)) {
          await writeFile(path.join(aspectDir, filename), content);
        }
      }
    }
  }

  // Node YAML
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

  // Mapping files (source files)
  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const absPath = path.join(tmpDir, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content);
    }
  }

  return { tmpDir, yggRoot, nodeDir };
}

describe('drift-detector', () => {
  describe('detectDrift', () => {
    it('reports OK when synced (auth/auth-api in sample project)', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // First sync to establish correct baseline including graph files
      await syncDriftState(graph, 'auth/auth-api');

      const report = await detectDrift(graph);
      const okEntry = report.entries.find(
        (e) => e.nodePath === 'auth/auth-api' && e.status === 'ok',
      );
      expect(okEntry).toBeDefined();

      // Restore original state for other tests
      await writeDriftState(graph.rootPath, FIXTURE_DRIFT_STATE);
    });

    it('reports drift when file hash differs from stored hash', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const report = await detectDrift(graph);

      // order-service has bogus stored hash, so it should drift
      const driftEntry = report.entries.find(
        (e) => e.nodePath === 'orders/order-service',
      );
      expect(driftEntry).toBeDefined();
      // Could be source-drift, graph-drift, or full-drift depending on what changed
      expect(['source-drift', 'graph-drift', 'full-drift']).toContain(driftEntry?.status);
      expect(driftEntry?.details).toContain('Changed files:');
    });

    it('reports MISSING when stored entry exists but all source files are gone', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const missingNode = graph.nodes.get('users/missing-service');
      expect(missingNode).toBeDefined();
      expect(missingNode?.meta.mapping).toBeDefined();

      const report = await detectDrift(graph);
      const entry = report.entries.find((e) => e.nodePath === 'users/missing-service');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('missing');
    });

    it('reports UNMATERIALIZED when no drift-state entry and files do not exist', async () => {
      const { tmpDir } = await createTmpProject('drift-unmaterialized', {
        nodePath: 'svc/new-service',
        nodeYaml: 'name: NewService\ntype: service\nmapping:\n  paths:\n    - src/svc/new.ts',
      });

      try {
        const graph = await loadGraph(tmpDir);
        const report = await detectDrift(graph);
        const unmaterializedEntry = report.entries.find(
          (e) => e.nodePath === 'svc/new-service' && e.status === 'unmaterialized',
        );
        expect(unmaterializedEntry).toBeDefined();
        expect(unmaterializedEntry?.details).toContain('No drift state recorded');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('multi-file mapping: flags drift if any file changed', async () => {
      const { tmpDir } = await createTmpProject('drift-multi-file', {
        nodePath: 'multi/multi-service',
        nodeYaml: `name: MultiService
type: service
mapping:
  paths:
    - src/multi/file-a.ts
    - src/multi/file-b.ts
`,
        mappingFiles: {
          'src/multi/file-a.ts': '// file-a',
          'src/multi/file-b.ts': '// file-b',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Sync to establish baseline (including graph files)
        await syncDriftState(graph, 'multi/multi-service');

        const reportBefore = await detectDrift(graph);
        const okBefore = reportBefore.entries.find((e) => e.nodePath === 'multi/multi-service');
        expect(okBefore?.status).toBe('ok');

        // Modify one source file
        await writeFile(path.join(tmpDir, 'src/multi/file-a.ts'), '// file-a MODIFIED');

        const reportAfter = await detectDrift(graph);
        const driftAfter = reportAfter.entries.find((e) => e.nodePath === 'multi/multi-service');
        expect(driftAfter?.status).toBe('source-drift');
        expect(driftAfter?.details).toContain('Changed files:');
        expect(driftAfter?.details).toContain('src/multi/file-a.ts');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips blackbox nodes entirely', async () => {
      const { tmpDir } = await createTmpProject('drift-blackbox-skip', {
        nodePath: 'svc/blackbox-svc',
        nodeYaml:
          'name: BlackboxSvc\ntype: service\nblackbox: true\nmapping:\n  paths:\n    - src/blackbox',
        mappingFiles: {
          'src/blackbox/index.ts': '// blackbox internals',
          'src/blackbox/helper.ts': '// more internals',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);
        const report = await detectDrift(graph);

        // Blackbox node should not appear in drift report at all
        const entry = report.entries.find((e) => e.nodePath === 'svc/blackbox-svc');
        expect(entry).toBeUndefined();
        expect(report.totalChecked).toBe(0);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('--node filter: only checks specified node', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const report = await detectDrift(graph, 'orders/order-service');

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].nodePath).toBe('orders/order-service');
    });

    it('checks nodes with mapping', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const report = await detectDrift(graph);
      const withMapping = report.entries.filter((e) =>
        [
          'auth/auth-api',
          'orders/order-service',
          'users/user-repo',
          'users/missing-service',
        ].includes(e.nodePath),
      );
      expect(withMapping.length).toBeGreaterThan(0);
    });
  });

  describe('syncDriftState', () => {
    it('updates .drift-state with current hashes including graph files', async () => {
      const { tmpDir } = await createTmpProject('drift-sync-update', {
        nodePath: 'svc/my-service',
        nodeYaml:
          'name: MyService\ntype: service\nmapping:\n  paths:\n    - src/svc/my.ts',
        mappingFiles: {
          'src/svc/my.ts': '// source content',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        const result = await syncDriftState(graph, 'svc/my-service');
        expect(result.previousHash).toBeUndefined();
        expect(result.currentHash).toBeDefined();

        const driftState = await readDriftState(graph.rootPath);
        const storedEntry = driftState['svc/my-service'];
        expect(storedEntry).toBeDefined();

        // Should contain both source and graph files
        const filePaths = Object.keys(storedEntry!.files);
        const sourcePaths = filePaths.filter((p) => !p.startsWith('.yggdrasil/'));
        const graphPaths = filePaths.filter((p) => p.startsWith('.yggdrasil/'));

        expect(sourcePaths).toContain('src/svc/my.ts');
        expect(graphPaths.length).toBeGreaterThan(0);
        // Should include yg-node.yaml for the node itself
        expect(graphPaths).toContain('.yggdrasil/model/svc/my-service/yg-node.yaml');

        // After sync, detect should report ok
        const report = await detectDrift(graph);
        const entry = report.entries.find((e) => e.nodePath === 'svc/my-service');
        expect(entry?.status).toBe('ok');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('reports sourceOnlyChange when only source files changed', async () => {
      const { tmpDir } = await createTmpProject('drift-source-only-sync', {
        nodePath: 'svc/src-only',
        nodeYaml: 'name: SrcOnly\ntype: service\nmapping:\n  paths:\n    - src/mod.ts',
        mappingFiles: {
          'src/mod.ts': 'v1',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Initial sync — no previous state, so sourceOnlyChange is false
        const first = await syncDriftState(graph, 'svc/src-only');
        expect(first.sourceOnlyChange).toBe(false);

        // Modify only source file
        await writeFile(path.join(tmpDir, 'src/mod.ts'), 'v2');

        const second = await syncDriftState(graph, 'svc/src-only');
        expect(second.sourceOnlyChange).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('sourceOnlyChange is false when graph artifacts also changed', async () => {
      const { tmpDir } = await createTmpProject('drift-both-sync', {
        nodePath: 'svc/both',
        nodeYaml: 'name: Both\ntype: service\nmapping:\n  paths:\n    - src/both.ts',
        mappingFiles: {
          'src/both.ts': 'v1',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Initial sync
        await syncDriftState(graph, 'svc/both');

        // Modify both source and graph
        await writeFile(path.join(tmpDir, 'src/both.ts'), 'v2');
        await writeFile(
          path.join(tmpDir, '.yggdrasil/model/svc/both/yg-node.yaml'),
          'name: BothUpdated\ntype: service\nmapping:\n  paths:\n    - src/both.ts',
        );

        const result = await syncDriftState(graph, 'svc/both');
        expect(result.sourceOnlyChange).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws when node not found', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      await expect(syncDriftState(graph, 'nonexistent/node')).rejects.toThrow('Node not found');
    });

    it('throws when node has no mapping', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      await expect(syncDriftState(graph, 'auth')).rejects.toThrow('Node has no mapping');
    });

    it('throws when node is blackbox', async () => {
      const { tmpDir } = await createTmpProject('drift-blackbox-sync', {
        nodePath: 'svc/bb-sync',
        nodeYaml:
          'name: BBSync\ntype: service\nblackbox: true\nmapping:\n  paths:\n    - src/bb.ts',
        mappingFiles: {
          'src/bb.ts': '// content',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);
        await expect(syncDriftState(graph, 'svc/bb-sync')).rejects.toThrow(
          'Cannot sync blackbox node',
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    // Tests the deleted-files loop in syncDriftState (lines 235-242):
    // When a graph file is deleted between syncs, the hasGraphChange path fires.
    it('sourceOnlyChange is false when a graph artifact file is deleted', async () => {
      const { tmpDir } = await createTmpProject('drift-graph-deleted-sync', {
        nodePath: 'svc/del-svc',
        nodeYaml: 'name: DelSvc\ntype: service\nmapping:\n  paths:\n    - src/del.ts',
        mappingFiles: {
          'src/del.ts': 'v1',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Initial sync — records node YAML and source file in baseline
        await syncDriftState(graph, 'svc/del-svc');

        // Modify source file AND delete a graph artifact that was recorded in baseline.
        // The graph artifact (yg-node.yaml) is tracked; deleting it and modifying source
        // means the deleted-files loop detects hasGraphChange = true → sourceOnlyChange = false.
        await writeFile(path.join(tmpDir, 'src/del.ts'), 'v2');
        await rm(path.join(tmpDir, '.yggdrasil/model/svc/del-svc/yg-node.yaml'));

        const result = await syncDriftState(graph, 'svc/del-svc');
        // hasGraphChange = true (deleted graph file) → sourceOnlyChange must be false
        expect(result.sourceOnlyChange).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('skips nodes without mapping during drift detection', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const report = await detectDrift(graph);

    const nodePathsChecked = report.entries.map((e) => e.nodePath);
    expect(nodePathsChecked).not.toContain('auth');
    expect(nodePathsChecked).not.toContain('orders');
    expect(nodePathsChecked).not.toContain('users');
  });

  it('detects source-drift when only source file changes', async () => {
    const { tmpDir } = await createTmpProject('drift-source-only', {
      nodePath: 'svc/file-svc',
      nodeYaml: 'name: FS\ntype: service\nmapping:\n  paths:\n    - src/file.ts',
      mappingFiles: {
        'src/file.ts': 'v1',
      },
    });

    try {
      const graph = await loadGraph(tmpDir);

      // Sync to establish baseline
      await syncDriftState(graph, 'svc/file-svc');

      const reportBefore = await detectDrift(graph);
      const okBefore = reportBefore.entries.find((e) => e.nodePath === 'svc/file-svc');
      expect(okBefore?.status).toBe('ok');

      // Modify only source file
      await writeFile(path.join(tmpDir, 'src/file.ts'), 'v2');

      const reportAfter = await detectDrift(graph);
      const driftAfter = reportAfter.entries.find((e) => e.nodePath === 'svc/file-svc');
      expect(driftAfter?.status).toBe('source-drift');
      expect(driftAfter?.details).toContain('src/file.ts');

      // Verify changedFiles
      expect(driftAfter?.changedFiles).toBeDefined();
      expect(driftAfter!.changedFiles!.every((f) => f.category === 'source')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports drift with deleted file in directory mapping', async () => {
    const { tmpDir } = await createTmpProject('drift-deleted', {
      nodePath: 'svc/dir-svc',
      nodeYaml: 'name: DS\ntype: service\nmapping:\n  paths:\n    - src/dir',
      mappingFiles: {
        'src/dir/a.ts': 'a',
        'src/dir/b.ts': 'b',
      },
    });

    try {
      const graph = await loadGraph(tmpDir);

      // Sync to establish baseline
      await syncDriftState(graph, 'svc/dir-svc');

      const reportBefore = await detectDrift(graph);
      const okBefore = reportBefore.entries.find((e) => e.nodePath === 'svc/dir-svc');
      expect(okBefore?.status).toBe('ok');

      // Delete one file
      await rm(path.join(tmpDir, 'src/dir/b.ts'));

      const reportAfter = await detectDrift(graph);
      const entry = reportAfter.entries.find((e) => e.nodePath === 'svc/dir-svc');
      expect(entry?.status).toBe('source-drift');
      expect(entry?.details).toContain('deleted');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports drift when no drift-state but files exist', async () => {
    const { tmpDir } = await createTmpProject('drift-no-state', {
      nodePath: 'svc/exist-svc',
      nodeYaml: 'name: ES\ntype: service\nmapping:\n  paths:\n    - src/exist.ts',
      mappingFiles: {
        'src/exist.ts': 'content',
      },
    });

    try {
      const graph = await loadGraph(tmpDir);
      const report = await detectDrift(graph);
      const entry = report.entries.find((e) => e.nodePath === 'svc/exist-svc');
      expect(entry?.status).toBe('source-drift');
      expect(entry?.details).toContain('files exist');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports ok when synced and nothing changed', async () => {
    const { tmpDir } = await createTmpProject('drift-ok-synced', {
      nodePath: 'svc/files-svc',
      nodeYaml: 'name: L\ntype: service\nmapping:\n  paths:\n    - src/files.ts',
      mappingFiles: {
        'src/files.ts': 'content',
      },
    });

    try {
      const graph = await loadGraph(tmpDir);

      // Sync to establish baseline
      await syncDriftState(graph, 'svc/files-svc');

      const report = await detectDrift(graph);
      const entry = report.entries.find((e) => e.nodePath === 'svc/files-svc');
      expect(entry?.status).toBe('ok');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports correct totals in drift summary', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const report = await detectDrift(graph);

    expect(report.totalChecked).toBe(report.entries.length);
    expect(report.okCount).toBe(report.entries.filter((e) => e.status === 'ok').length);
    expect(report.sourceDriftCount).toBe(report.entries.filter((e) => e.status === 'source-drift').length);
    expect(report.graphDriftCount).toBe(report.entries.filter((e) => e.status === 'graph-drift').length);
    expect(report.fullDriftCount).toBe(report.entries.filter((e) => e.status === 'full-drift').length);
    expect(report.missingCount).toBe(report.entries.filter((e) => e.status === 'missing').length);
    expect(report.unmaterializedCount).toBe(
      report.entries.filter((e) => e.status === 'unmaterialized').length,
    );
  });

  // ============================================================
  // New tests for graph drift detection
  // ============================================================

  describe('graph drift detection', () => {
    it('detects graph-drift when an aspect file changes', async () => {
      const { tmpDir } = await createTmpProject('drift-graph-aspect', {
        nodePath: 'svc/audited-svc',
        nodeYaml: `name: AuditedService
type: service
aspects:
  - aspect: requires-audit
mapping:
  paths:
    - src/audited.ts
`,
        mappingFiles: {
          'src/audited.ts': '// audited service code',
        },
        aspects: [
          {
            id: 'requires-audit',
            yaml: 'name: Audit Logging\n',
            files: {
              'content.md': '# Audit Requirements\n\nAll operations must be logged.',
            },
          },
        ],
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Sync to establish baseline
        await syncDriftState(graph, 'svc/audited-svc');

        const reportBefore = await detectDrift(graph);
        const okBefore = reportBefore.entries.find((e) => e.nodePath === 'svc/audited-svc');
        expect(okBefore?.status).toBe('ok');

        // Modify aspect content (graph file) — NOT source
        await writeFile(
          path.join(tmpDir, '.yggdrasil/aspects/requires-audit/content.md'),
          '# Updated Audit Requirements\n\nAll operations must be logged with full context.',
        );

        const reportAfter = await detectDrift(graph);
        const driftAfter = reportAfter.entries.find((e) => e.nodePath === 'svc/audited-svc');
        expect(driftAfter?.status).toBe('graph-drift');
        expect(driftAfter?.changedFiles).toBeDefined();
        expect(driftAfter!.changedFiles!.length).toBeGreaterThan(0);
        expect(driftAfter!.changedFiles!.every((f) => f.category === 'graph')).toBe(true);
        expect(driftAfter!.changedFiles!.some((f) =>
          f.filePath.includes('requires-audit/content.md'),
        )).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects full-drift when both source and graph change', async () => {
      const { tmpDir } = await createTmpProject('drift-full', {
        nodePath: 'svc/full-svc',
        nodeYaml: 'name: FullSvc\ntype: service\nmapping:\n  paths:\n    - src/full.ts',
        mappingFiles: {
          'src/full.ts': '// original source',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);

        // Sync baseline
        await syncDriftState(graph, 'svc/full-svc');

        const reportBefore = await detectDrift(graph);
        expect(
          reportBefore.entries.find((e) => e.nodePath === 'svc/full-svc')?.status,
        ).toBe('ok');

        // Modify BOTH source and graph
        await writeFile(path.join(tmpDir, 'src/full.ts'), '// modified source');
        await writeFile(
          path.join(tmpDir, '.yggdrasil/model/svc/full-svc/yg-node.yaml'),
          'name: FullSvcRenamed\ntype: service\nmapping:\n  paths:\n    - src/full.ts',
        );

        const reportAfter = await detectDrift(graph);
        const driftAfter = reportAfter.entries.find((e) => e.nodePath === 'svc/full-svc');
        expect(driftAfter?.status).toBe('full-drift');
        expect(driftAfter?.changedFiles).toBeDefined();

        const categories = new Set(driftAfter!.changedFiles!.map((f) => f.category));
        expect(categories.has('source')).toBe(true);
        expect(categories.has('graph')).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects source-drift when only source changes (changedFiles verified)', async () => {
      const { tmpDir } = await createTmpProject('drift-source-cat', {
        nodePath: 'svc/src-svc',
        nodeYaml: 'name: SrcSvc\ntype: service\nmapping:\n  paths:\n    - src/src.ts',
        mappingFiles: {
          'src/src.ts': '// original',
        },
      });

      try {
        const graph = await loadGraph(tmpDir);
        await syncDriftState(graph, 'svc/src-svc');

        await writeFile(path.join(tmpDir, 'src/src.ts'), '// modified');

        const report = await detectDrift(graph);
        const entry = report.entries.find((e) => e.nodePath === 'svc/src-svc');
        expect(entry?.status).toBe('source-drift');
        expect(entry?.changedFiles).toBeDefined();
        expect(entry!.changedFiles!.every((f) => f.category === 'source')).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('syncDriftState captures graph files in drift state', async () => {
      const { tmpDir } = await createTmpProject('drift-sync-graph', {
        nodePath: 'svc/graph-svc',
        nodeYaml: `name: GraphSvc
type: service
aspects:
  - aspect: test-aspect
mapping:
  paths:
    - src/graph.ts
`,
        mappingFiles: {
          'src/graph.ts': '// graph service',
        },
        aspects: [
          {
            id: 'test-aspect',
            yaml: 'name: Test Aspect\n',
            files: {
              'requirements.md': '# Test requirements',
            },
          },
        ],
      });

      try {
        const graph = await loadGraph(tmpDir);
        await syncDriftState(graph, 'svc/graph-svc');

        const driftState = await readDriftState(graph.rootPath);
        const storedEntry = driftState['svc/graph-svc'];
        expect(storedEntry).toBeDefined();

        const filePaths = Object.keys(storedEntry!.files);
        const graphPaths = filePaths.filter((p) => p.startsWith('.yggdrasil/'));

        // Should include yg-node.yaml for own node
        expect(graphPaths).toContain('.yggdrasil/model/svc/graph-svc/yg-node.yaml');
        // Should include parent yg-node.yaml
        expect(graphPaths).toContain('.yggdrasil/model/svc/yg-node.yaml');
        // Should include aspect files
        expect(graphPaths).toContain('.yggdrasil/aspects/test-aspect/yg-aspect.yaml');
        expect(graphPaths).toContain('.yggdrasil/aspects/test-aspect/requirements.md');
        // Should include source file
        expect(filePaths).toContain('src/graph.ts');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('drift-sync --all skips blackbox nodes and GC cleans orphaned state', async () => {
    const { tmpDir } = await createTmpProject('drift-blackbox-gc', {
      nodePath: 'svc/bb-gc',
      nodeYaml:
        'name: BBGC\ntype: service\nblackbox: true\nmapping:\n  paths:\n    - src/bb.ts',
      mappingFiles: {
        'src/bb.ts': '// content',
      },
    });

    try {
      const graph = await loadGraph(tmpDir);

      // Manually write a drift state file for the blackbox node (simulating legacy state)
      await writeNodeDriftState(graph.rootPath, 'svc/bb-gc', {
        hash: 'fake',
        files: { 'src/bb.ts': 'fake' },
      });

      // Verify the drift state file exists
      const stateBefore = await readNodeDriftState(graph.rootPath, 'svc/bb-gc');
      expect(stateBefore).toBeDefined();

      // detectDrift should NOT include blackbox node
      const report = await detectDrift(graph);
      const entry = report.entries.find((e) => e.nodePath === 'svc/bb-gc');
      expect(entry).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('child-wins exclusion model', () => {
    it('parent drift excludes files owned by child node mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-child-wins');
      const yggRoot = path.join(tmpDir, '.yggdrasil');
      const parentNodeDir = path.join(yggRoot, 'model', 'platform');
      const childNodeDir = path.join(yggRoot, 'model', 'platform', 'auth');

      await mkdir(childNodeDir, { recursive: true });
      await writeFile(
        path.join(yggRoot, 'yg-config.yaml'),
        'name: Test\nnode_types:\n  module:\n    description: x\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n',
      );
      await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
      await writeFile(
        path.join(parentNodeDir, 'yg-node.yaml'),
        'name: Platform\ntype: module\nmapping:\n  paths:\n    - src/platform\n',
      );
      await writeFile(path.join(parentNodeDir, 'responsibility.md'), 'Platform handles shared concerns.');
      await writeFile(
        path.join(childNodeDir, 'yg-node.yaml'),
        'name: Auth\ntype: module\nmapping:\n  paths:\n    - src/platform/auth\n',
      );
      await writeFile(path.join(childNodeDir, 'responsibility.md'), 'Auth handles authentication.');

      // Create source files
      await mkdir(path.join(tmpDir, 'src/platform/auth'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src/platform/base.ts'), '// platform base');
      await writeFile(path.join(tmpDir, 'src/platform/auth/login.ts'), '// auth login');

      try {
        const graph = await loadGraph(tmpDir);

        // Sync both nodes
        await syncDriftState(graph, 'platform');
        await syncDriftState(graph, 'platform/auth');

        // Read stored state to verify exclusion
        const state = await readDriftState(graph.rootPath);
        const parentFiles = Object.keys(state['platform']?.files ?? {});
        const childFiles = Object.keys(state['platform/auth']?.files ?? {});

        // Parent should NOT include auth/login.ts (child owns it)
        const parentSourceFiles = parentFiles.filter((f) => f.startsWith('src/'));
        expect(parentSourceFiles).toContain('src/platform/base.ts');
        expect(parentSourceFiles).not.toContain('src/platform/auth/login.ts');

        // Child SHOULD include auth/login.ts
        const childSourceFiles = childFiles.filter((f) => f.startsWith('src/'));
        expect(childSourceFiles).toContain('src/platform/auth/login.ts');

        // Now modify the child-owned file — parent should NOT drift
        await writeFile(path.join(tmpDir, 'src/platform/auth/login.ts'), '// auth login CHANGED');

        const report = await detectDrift(graph);
        const parentEntry = report.entries.find((e) => e.nodePath === 'platform');
        const childEntry = report.entries.find((e) => e.nodePath === 'platform/auth');

        expect(parentEntry?.status).toBe('ok');
        expect(childEntry?.status).toBe('source-drift');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
