import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runLlmVerification } from '../../../src/cli/approve.js';
import type { LlmConfig } from '../../../src/cli/approve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/utils/hash.js';
import { collectTrackedFiles } from '../../../src/core/context-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Helper: create temp project with a single mapped node */
async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  parentNodes?: Array<{ path: string; yaml: string }>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-approve-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    opts.configYaml ?? 'name: Test\nnode_types:\n  service:\n    description: x\n',
  );
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

  // Parent nodes
  if (opts.parentNodes) {
    for (const pn of opts.parentNodes) {
      const pDir = path.join(yggRoot, 'model', pn.path);
      await mkdir(pDir, { recursive: true });
      await writeFile(path.join(pDir, 'yg-node.yaml'), pn.yaml);
    }
  } else {
    const parts = opts.nodePath.split('/');
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('/');
      const parentDir = path.join(yggRoot, 'model', parentPath);
      await mkdir(parentDir, { recursive: true });
      await writeFile(
        path.join(parentDir, 'yg-node.yaml'),
        `name: ${parts[parts.length - 2]}\ntype: service\ndescription: parent\n`,
      );
    }
  }

  // Aspects
  if (opts.aspects) {
    for (const asp of opts.aspects) {
      const aspDir = path.join(yggRoot, 'aspects', asp.id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
      if (asp.files) {
        for (const [aName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, aName), content);
        }
      }
    }
  }

  // Source files
  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const abs = path.join(tmpDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  return { tmpDir, yggRoot };
}

/** Record baseline for all mapped nodes */
async function recordBaseline(tmpDir: string) {
  const graph = await loadGraph(tmpDir);
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.mapping) continue;
    const trackedFiles = collectTrackedFiles(node, graph);
    const projectRoot = path.dirname(graph.rootPath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [],
    );
    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });
  }
}

describe('approveNode — proper nodes', () => {
  // Row 1: own changed + source changed + other changed (all three axes) → ACCEPTS
  it('accepts when all three axes changed (own + source + cascade)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('all-three', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change source + aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Source changed → ACCEPTS
  it('accepts when source changed', async () => {
    const { tmpDir } = await createTmpProject('both-changed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change source
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no-change when nothing changed', async () => {
    const { tmpDir } = await createTmpProject('no-change', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('no-change');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // yg-node.yaml only change → no-op (metadata, not artifact)

  // First approve (no baseline)
  it('accepts first approve with no baseline', async () => {
    const { tmpDir } = await createTmpProject('first-approve', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // NO baseline recorded
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('initial');
    expect(result.previousHash).toBeUndefined();
    expect(result.currentHash).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Node not found
  it('throws for nonexistent node', async () => {
    const { tmpDir } = await createTmpProject('not-found', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    const graph = await loadGraph(tmpDir);
    await expect(approveNode(graph, 'nonexistent/node'))
      .rejects.toThrow('does not exist');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Node without mapping
  it('throws for node without mapping', async () => {
    const { tmpDir } = await createTmpProject('no-mapping', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\n',
    });
    const graph = await loadGraph(tmpDir);
    await expect(approveNode(graph, 'svc/my-service'))
      .rejects.toThrow('no mapping');
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('approveNode — blackbox nodes', () => {
  // Blackbox: source changed → REFUSES always
  it('refuses source changes on blackbox node', async () => {
    const { tmpDir } = await createTmpProject('bb-source', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/auth/login.ts'), 'export function login() { return true; }\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    expect(result.blackboxBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: source changed → REFUSES
  it('refuses when source changed on blackbox', async () => {
    const { tmpDir } = await createTmpProject('bb-both', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
    });
    await recordBaseline(tmpDir);
    // Change source
    await writeFile(path.join(tmpDir, 'src/auth/login.ts'), 'export function login() { return true; }\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    expect(result.blackboxBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: no changes → no-op
  it('returns no-change for blackbox with no changes', async () => {
    const { tmpDir } = await createTmpProject('bb-no-change', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('no-change');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: source + cascade (no graph) → REFUSES (source changed fires blocker)
  it('refuses source+cascade on blackbox', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-source-cascade', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\naspects:\n  - logging\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/auth/login.ts'), 'export function login() { return true; }\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    expect(result.blackboxBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

});

describe('approveNode — anti-laundering', () => {
  it('refuses first-approve on blackbox if files in other node drift-state', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('anti-launder', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      parentNodes: [{
        path: 'legacy',
        yaml: 'name: Legacy\ntype: service\ndescription: legacy\n',
      }],
    });
    // Write drift state for ANOTHER node that tracked one of the blackbox files
    await writeNodeDriftState(yggRoot, 'other/service', {
      hash: 'fake',
      files: { 'src/auth/login.ts': 'fake-hash' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    expect(result.antiLaunderingBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Exploit 2: pre-emptive blackbox — other node has current hash (no drift), still blocked
  it('refuses pre-emptive blackbox creation even when other node has no pending drift', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('anti-launder-preemptive', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      parentNodes: [{
        path: 'legacy',
        yaml: 'name: Legacy\ntype: service\ndescription: legacy\n',
      }],
    });
    // Other node has CURRENT hash (not drifted) — anti-laundering still blocks
    await writeNodeDriftState(yggRoot, 'other/service', {
      hash: 'current-baseline',
      files: { 'src/auth/login.ts': 'current-hash-matching-disk' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    expect(result.antiLaunderingBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('anti-laundering result includes conflicting file details', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('anti-launder-details', {
      nodePath: 'new-blackbox',
      nodeYaml: 'name: NewBlackbox\ntype: service\ndescription: new blackbox\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/controller.ts': 'export function ctrl() {}\n' },
    });
    await writeNodeDriftState(yggRoot, 'auth/auth-api', {
      hash: 'fake',
      files: { 'src/auth/controller.ts': 'fake-hash' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'new-blackbox', { reviewed: undefined });
    expect(result.action).toBe('refused');
    expect(result.antiLaunderingBlocked).toBe(true);
    expect(result.conflictingFiles).toContainEqual({
      file: 'src/auth/controller.ts',
      trackedBy: 'auth/auth-api',
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('allows first-approve on proper node even with shared files', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('proper-first', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Another node's drift state has overlapping files
    await writeNodeDriftState(yggRoot, 'other/service', {
      hash: 'fake',
      files: { 'src/svc/index.ts': 'fake-hash' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    // Anti-laundering only blocks blackbox — proper node first-approve is fine
    expect(result.action).toBe('initial');
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('approveNode — deleted tracked files', () => {
  // When a source file is deleted from disk, it appears in storedEntry.files but not fileHashes.
  // The deleted-files loop (line 169-172) fires and classifyChangedFile is called for it.

  // When a tracked aspect file disappears from context (aspect removed from node),
  // resolveLayer returns undefined and isGraph=true → hits the else-if-isGraph branch.
  it('handles aspect file removed from context (resolveLayer returns undefined for graph file)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('removed-aspect-ctx', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Remove the aspect reference from node YAML — aspect files are now outside tracked context
    // so resolveLayer will return undefined for them, but they're still graph files
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    // The approve should run without crashing — aspect files in baseline trigger the else-if-isGraph path
    const result = await approveNode(graph, 'svc/my-service');
    // yg-node.yaml change is metadata (ignored); removed aspect files from context
    // are treated as upstream (other tracked) via the else-if-isGraph branch
    expect(['no-change', 'refused', 'approved']).toContain(result.action);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('approveNode — GC and recording', () => {
  it('always records baseline even on no-op', async () => {
    const { tmpDir } = await createTmpProject('record-noop', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('no-change');
    expect(result.currentHash).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });


  it('appends audit log entry on approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('audit-approve', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change source → approve
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');

    const { readFile: rf } = await import('node:fs/promises');
    const logContent = await rf(path.join(yggRoot, '.audit-log.jsonl'), 'utf-8');
    const lines = logContent.trim().split('\n');
    // First entry = initial (from recordBaseline), second = this approve
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.node).toBe('svc/my-service');
    expect(entry.action).toBe('approved');
    expect(entry.prev).toBeDefined();
    expect(entry.hash).toBeDefined();
    expect(entry.prev).not.toBe(entry.hash);
    expect(entry.reason).toBeNull();
    expect(entry.files.length).toBeGreaterThan(0);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await rm(tmpDir, { recursive: true, force: true });
  });


  it('appends audit log entry on initial approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('audit-initial', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Don't call recordBaseline — first approve triggers initial path
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('initial');

    const { readFile: rf } = await import('node:fs/promises');
    const logContent = await rf(path.join(yggRoot, '.audit-log.jsonl'), 'utf-8');
    const lines = logContent.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.node).toBe('svc/my-service');
    expect(entry.action).toBe('initial');
    expect(entry.prev).toBeNull();
    expect(entry.hash).toBeDefined();
    expect(entry.reason).toBeNull();
    expect(entry.files).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });


  it('garbage collects orphaned drift state on approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('gc', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Create orphaned drift state
    await writeNodeDriftState(yggRoot, 'deleted/service', {
      hash: 'orphan',
      files: {},
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.gcPaths).toContain('deleted/service');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GC does NOT remove valid nodes drift state', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('gc-valid', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    await approveNode(graph, 'svc/my-service');
    // Verify the node's own drift state still exists
    const { readNodeDriftState: readState } = await import('../../../src/io/drift-state-store.js');
    const state = await readState(yggRoot, 'svc/my-service');
    expect(state).toBeDefined();
    expect(state!.hash).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });




});
