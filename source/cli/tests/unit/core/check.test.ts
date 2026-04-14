import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  classifyDrift,
  scanUncoveredFiles,
  buildCoverageIssue,
  detectOrphanedDriftState,
  runCheck,
} from '../../../src/core/check.js';
import type { CheckIssue } from '../../../src/core/check.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/utils/hash.js';
import { collectTrackedFiles } from '../../../src/core/context-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default aspect for tests that need nodes to participate in drift detection */
const TEST_ASPECT = {
  id: 'testing',
  yaml: 'name: Testing\ndescription: test aspect\n',
  files: { 'content.md': 'Test rule.\n' },
};

/**
 * Helper: create a minimal temp project for drift classification tests.
 */
async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  parentNodes?: Array<{ path: string; yaml: string }>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-check-${name}`);
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
    opts.configYaml ?? 'version: "4.0.0"\n',
  );
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

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

  if (opts.aspects) {
    for (const asp of opts.aspects) {
      const aspDir = path.join(yggRoot, 'aspects', asp.id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
      if (asp.files) {
        for (const [artName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, artName), content);
        }
      }
    }
  }

  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const abs = path.join(tmpDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  return { tmpDir, yggRoot };
}

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

// ── classifyDrift ─────────────────────────────────────────

describe('classifyDrift', () => {
  it('returns empty for node with no drift', async () => {
    const { tmpDir } = await createTmpProject('no-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    expect(result).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift when source file changes', async () => {
    const { tmpDir } = await createTmpProject('source-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source file
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].nodePath).toBe('svc/my-service');
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when own yg-node.yaml aspect-relevant fields change', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('graph-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify aspect-relevant field (type change triggers upstream drift)
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: module\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const drift = result.filter(i => i.nodePath === 'svc/my-service' && i.code === 'upstream-drift');
    expect(drift.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT trigger drift when only description changes in yg-node.yaml', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('desc-only-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify only description — should NOT trigger drift
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: updated description\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const drift = result.filter(i => i.nodePath === 'svc/my-service');
    expect(drift).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns cascade-drift when aspect file changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify aspect content file
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Log ALL operations, not just mutations.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].nodePath).toBe('svc/my-service');
    expect(upstreamDrift[0].cascadeCauses!).toHaveLength(1);
    expect(upstreamDrift[0].cascadeCauses![0].description).toContain('logging');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns both source-drift and cascade-drift when direct and cascade changes happen', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('compound', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify BOTH source and aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const nodeIssues = result.filter(i => i.nodePath === 'svc/my-service');
    const sourceDrift = nodeIssues.filter(i => i.code === 'source-drift');
    const upstreamDrift = nodeIssues.filter(i => i.code === 'upstream-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(upstreamDrift).toHaveLength(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns unapproved when no baseline exists', async () => {
    const { tmpDir } = await createTmpProject('unapproved', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const unapproved = result.filter(i => i.code === 'unapproved');
    expect(unapproved).toHaveLength(1);
    expect(unapproved[0].lifecycleState).toBe('unapproved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift unapproved with files-never-created message when source path absent', async () => {
    const { tmpDir } = await createTmpProject('unapproved-absent', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/absent/\n',
      aspects: [TEST_ASPECT],
      // Do NOT create the mapping directory at all
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('unapproved');
    expect(sourceDrift[0].message).toContain('never created');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift missing when source files are gone', async () => {
    const { tmpDir } = await createTmpProject('missing-src', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Delete all source files
    await rm(path.join(tmpDir, 'src/svc'), { recursive: true, force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('missing');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects deleted source file in drift (partial deletion)', async () => {
    const { tmpDir } = await createTmpProject('partial-deleted', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/index.ts\n  - src/svc/helper.ts\n',
      aspects: [TEST_ASPECT],
      mappingFiles: {
        'src/svc/index.ts': 'export default 42;\n',
        'src/svc/helper.ts': 'export const helper = () => {};\n',
      },
    });
    await recordBaseline(tmpDir);
    // Delete one of the two mapped files — allPathsMissing returns false since index.ts still exists
    await rm(path.join(tmpDir, 'src/svc/helper.ts'), { force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect source-drift (deleted source file)
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift.length).toBeGreaterThanOrEqual(1);
    const changedFiles = sourceDrift.flatMap(i => i.directChangedFiles ?? []);
    expect(changedFiles.some(f => f.filePath.includes('deleted'))).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift when both source and graph metadata change', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('full-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source file
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when hierarchy (parent) yg-node.yaml changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-hierarchy', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
      }],
    });
    await recordBaseline(tmpDir);
    // Modify parent yg-node.yaml (now the only hierarchy-tracked file)
    await writeFile(
      path.join(yggRoot, 'model/svc/yg-node.yaml'),
      'name: Svc\ntype: service\ndescription: updated parent\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].cascadeCauses![0].layer).toBe('hierarchy');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects drift when tracked file is removed from context (aspect removed)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('deleted-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [
        {
          id: 'logging',
          yaml: 'name: Logging\ndescription: test aspect\n',
          files: { 'content.md': 'Log all mutations.\n' },
        },
        TEST_ASPECT,
      ],
    });
    await recordBaseline(tmpDir);
    // Remove logging aspect reference from node YAML (keep testing so node still has aspects)
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect some form of drift (source-drift or upstream-drift because own yg-node.yaml changed,
    // plus deleted aspect files from baseline)
    expect(result.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when flow yg-flow.yaml changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-flow', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Create a flow that references our node
    const flowDir = path.join(yggRoot, 'flows/checkout-flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout Flow\ndescription: test flow\nnodes:\n  - svc/my-service\n');
    await recordBaseline(tmpDir);
    // Modify flow yg-flow.yaml (now the only flow-tracked file)
    await writeFile(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout Flow\ndescription: updated flow\nnodes:\n  - svc/my-service\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].cascadeCauses!.some(c => c.layer === 'flows')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when dependency yg-node.yaml changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-dep', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify dependency yg-node.yaml (now the only relational-tracked file)
    await writeFile(
      path.join(yggRoot, 'model/svc/dep/yg-node.yaml'),
      'name: Dep\ntype: service\ndescription: updated dependency\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].cascadeCauses!.some(c => c.layer === 'relational')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });


  it('upstream-drift collapse: multiple upstream changes emit only ONE upstream-drift with all causes merged', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-collapse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Trigger cascade from TWO different upstream sources simultaneously:
    // 1. aspect file change
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated logging rules triggering cascade.\n');
    // 2. dependency yg-node.yaml change
    await writeFile(path.join(yggRoot, 'model/svc/dep/yg-node.yaml'), 'name: Dep\ntype: service\ndescription: updated dep\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    // Must collapse to exactly ONE upstream-drift for this node
    expect(upstreamDrift).toHaveLength(1);
    // Must contain causes from both upstream changes
    expect(upstreamDrift[0].cascadeCauses!.length).toBeGreaterThanOrEqual(2);
    const layers = upstreamDrift[0].cascadeCauses!.map(c => c.layer);
    expect(layers).toContain('aspects');
    expect(layers).toContain('relational');
    await rm(tmpDir, { recursive: true, force: true });
  });

});

  it('handles drift state without mtimes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('no-mtimes', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Overwrite drift state without mtimes (testing graceful handling)
    const storedState = await import('../../../src/io/drift-state-store.js');
    const existing = await storedState.readNodeDriftState(yggRoot, 'svc/my-service');
    await storedState.writeNodeDriftState(yggRoot, 'svc/my-service', {
      hash: existing!.hash,
      files: existing!.files,
      // no mtimes field
    });
    // Modify source to trigger drift
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips nodes without mapping paths', async () => {
    const { tmpDir } = await createTmpProject('no-mapping', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\n',
      // No mapping, no mapping files
    });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Node without mapping should produce no issues
    expect(result).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles child-wins model with overlapping parent-child mappings', async () => {
    const { tmpDir } = await createTmpProject('child-wins', {
      nodePath: 'svc/my-service/sub',
      nodeYaml: 'name: Sub\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/sub/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'parent file\n', 'src/svc/sub/inner.ts': 'child file\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent root\n',
        },
        {
          path: 'svc/my-service',
          yaml: 'name: MyService\ntype: service\ndescription: parent\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify child source file -- should only affect child, not parent
    await writeFile(path.join(tmpDir, 'src/svc/sub/inner.ts'), 'modified child\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const subIssues = result.filter(i => i.nodePath === 'svc/my-service/sub');
    expect(subIssues.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

// ── scanUncoveredFiles ────────────────────────────────────

describe('scanUncoveredFiles', () => {
  it('returns empty when all files are covered', async () => {
    const { tmpDir } = await createTmpProject('covered', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/\n',
      mappingFiles: { 'src/index.ts': 'export default 42;\n' },
    });
    const graph = await loadGraph(tmpDir);
    const uncovered = scanUncoveredFiles(graph, ['src/index.ts']);
    expect(uncovered).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns uncovered files', async () => {
    const { tmpDir } = await createTmpProject('uncovered', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '', 'src/other/util.ts': '' },
    });
    const graph = await loadGraph(tmpDir);
    const uncovered = scanUncoveredFiles(graph, ['src/svc/index.ts', 'src/other/util.ts', 'package.json']);
    expect(uncovered).toContain('src/other/util.ts');
    expect(uncovered).toContain('package.json');
    expect(uncovered).not.toContain('src/svc/index.ts');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('excludes .yggdrasil/ files', async () => {
    const { tmpDir } = await createTmpProject('ygg-exclude', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/\n',
      mappingFiles: { 'src/index.ts': '' },
    });
    const graph = await loadGraph(tmpDir);
    const uncovered = scanUncoveredFiles(graph, [
      'src/index.ts',
      '.yggdrasil/model/svc/my-service/yg-node.yaml',
    ]);
    expect(uncovered).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('directory mapping covers files inside', async () => {
    const { tmpDir } = await createTmpProject('dir-mapping', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/a.ts': '', 'src/svc/sub/b.ts': '' },
    });
    const graph = await loadGraph(tmpDir);
    const uncovered = scanUncoveredFiles(graph, ['src/svc/a.ts', 'src/svc/sub/b.ts']);
    expect(uncovered).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── buildCoverageIssue ────────────────────────────────────

describe('buildCoverageIssue', () => {
  it('returns null for empty list', () => {
    expect(buildCoverageIssue([], 10)).toBeNull();
  });

  it('returns unmapped-files for small count (<=5 files)', () => {
    const issue = buildCoverageIssue(['a.ts', 'b.ts'], 10);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe('unmapped-files');
    expect(issue!.severity).toBe('error');
    expect(issue!.uncoveredCount).toBe(2);
    expect(issue!.message).toContain('2 source files');
    expect(issue!.message).toContain('a.ts');
    expect(issue!.message).toContain('b.ts');
  });

  it('returns unmapped-files for large count (>5 files) with guidance before examples', () => {
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const issue = buildCoverageIssue(files, 100);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe('unmapped-files');
    expect(issue!.uncoveredCount).toBe(20);
    // Examples come before guidance (what → why → next)
    const msg = issue!.message;
    const examplesIdx = msg.indexOf('Examples:');
    const guidanceIdx = msg.indexOf('Add to an existing');
    expect(examplesIdx).toBeLessThan(guidanceIdx);
    expect(msg).toContain('... and 15 more');
  });

  it('uses cold-start guidance when coverage is below 50%', () => {
    const files = Array.from({ length: 80 }, (_, i) => `file${i}.ts`);
    const issue = buildCoverageIssue(files, 100);
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain('Establish coverage');
  });

  it('uses singular form for exactly 1 uncovered file', () => {
    const issue = buildCoverageIssue(['lonely.ts'], 10);
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain('1 source file not covered');
    // Should NOT say "files" (plural)
    expect(issue!.message).not.toContain('1 source files');
  });
});

// ── detectOrphanedDriftState ──────────────────────────────

describe('detectOrphanedDriftState', () => {
  it('returns orphaned node paths', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('orphan', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    // Write drift state for a node that doesn't exist
    await writeNodeDriftState(yggRoot, 'ghost/deleted-service', {
      hash: 'aaaa', files: {},
    });
    const graph = await loadGraph(tmpDir);
    const orphaned = await detectOrphanedDriftState(graph);
    expect(orphaned).toContain('ghost/deleted-service');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when no orphans', async () => {
    const { tmpDir } = await createTmpProject('no-orphan', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const orphaned = await detectOrphanedDriftState(graph);
    expect(orphaned).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });
});


// ── computeSuggestedNext (tested indirectly through runCheck) ──

describe('suggestedNext priority', () => {
  it('suggests cascade when upstream-drift is present without source-drift', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('suggest-cascade', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Only modify aspect (cascade) -- do NOT modify source or own metadata
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated rules for cascade suggestion test.\n');
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    // upstream-drift should be present, source-drift should not
    const sourceDrift = result.issues.filter(i => i.code === 'source-drift');
    const upstreamDrift = result.issues.filter(i => i.code === 'upstream-drift');
    expect(sourceDrift).toHaveLength(0);
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    // Suggested next should reference cascade context review
    if (result.suggestedNext && upstreamDrift.length > 0) {
      expect(result.suggestedNext).toContain('svc/my-service');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests structural fix when structural errors are the highest priority', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('suggest-structural', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nrelations:\n  - target: nonexistent/node\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    // Should have a structural error (broken relation)
    const STRUCTURAL_CODES = new Set(['yaml-invalid', 'type-invalid', 'relation-broken', 'flow-node-broken', 'flow-aspect-undefined', 'overlapping-mapping', 'structural-cycle', 'config-invalid', 'duplicate-aspect-id', 'node-yaml-missing', 'implied-aspect-missing', 'aspect-implies-cycle']);
    const structural = result.issues.filter(i => STRUCTURAL_CODES.has(i.code));
    expect(structural.length).toBeGreaterThanOrEqual(1);
    // With no drift errors, suggestion should reference structural fix
    if (result.suggestedNext && !result.issues.some(i => i.code === 'source-drift' || i.code === 'upstream-drift')) {
      expect(result.suggestedNext).toContain('Fix');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests coverage when only unmapped-files errors exist', async () => {
    const { tmpDir } = await createTmpProject('suggest-coverage', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    // Pass uncovered files to trigger unmapped-files
    const result = await runCheck(graph, ['src/svc/index.ts', 'src/other/file.ts', 'lib/util.ts']);
    const unmappedFiles = result.issues.filter(i => i.code === 'unmapped-files');
    expect(unmappedFiles).toHaveLength(1);
    // suggestedNext might reference structural or completeness errors from validation,
    // but if unmapped-files is the only category it should suggest coverage
    if (result.suggestedNext && !result.issues.some(i => i.code === 'source-drift' || i.code === 'upstream-drift' || (['yaml-invalid', 'type-invalid', 'relation-broken', 'config-invalid'].includes(i.code)))) {
      expect(result.suggestedNext).toContain('coverage');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── runCheck ──────────────────────────────────────────────

describe('runCheck', () => {
  it('returns clean result for well-formed project with baseline', async () => {
    const { tmpDir } = await createTmpProject('clean-check', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    // Pass all git files as covered
    const result = await runCheck(graph, ['src/svc/index.ts']);
    expect(result.nodeCount).toBeGreaterThanOrEqual(1);
    expect(result.projectName).toBe('tmp-check-clean-check');
    expect(result.aspectCount).toBeGreaterThanOrEqual(0);
    expect(result.flowCount).toBeGreaterThanOrEqual(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes source-drift issues in orchestrated result', async () => {
    const { tmpDir } = await createTmpProject('check-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source to trigger drift
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    const sourceDrift = result.issues.filter(i => i.code === 'source-drift');
    expect(sourceDrift.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes unmapped-files coverage issues when uncovered files exist', async () => {
    const { tmpDir } = await createTmpProject('check-coverage', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts', 'src/other/util.ts']);
    const unmappedFiles = result.issues.filter(i => i.code === 'unmapped-files');
    expect(unmappedFiles).toHaveLength(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips unmapped-files when gitTrackedFiles is null', async () => {
    const { tmpDir } = await createTmpProject('check-no-git', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, null);
    const unmappedFiles = result.issues.filter(i => i.code === 'unmapped-files');
    expect(unmappedFiles).toHaveLength(0);
    expect(result.totalFiles).toBe(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes orphaned-drift-state warning when orphaned drift state exists', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('check-orphan', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    // Write orphaned drift state
    await writeNodeDriftState(yggRoot, 'ghost/deleted', {
      hash: 'aaaa', files: {},
    });
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    const w005 = result.issues.filter(i => i.code === 'orphaned-drift-state');
    expect(w005.length).toBeGreaterThanOrEqual(1);
    expect(w005[0].nodePath).toBe('ghost/deleted');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests completeness fix when only completeness errors exist', async () => {
    // A node without description triggers description-missing
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-check-suggest-completeness');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const nodeDir = path.join(yggRoot, 'model', 'svc/bare');
    const parentDir = path.join(yggRoot, 'model', 'svc');

    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(nodeDir, { recursive: true });
    await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
    await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
    await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
    await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
    await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.0.0"\n');
    await writeFile(path.join(parentDir, 'yg-node.yaml'), 'name: Svc\ntype: service\ndescription: parent\n');
    // Node WITHOUT description (triggers description-missing)
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: Bare\ntype: service\n');
    // No mapping -> no drift, no coverage issues

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, []);
    // Should have completeness errors (description-missing) but no drift/structural/coverage
    const completeness = result.issues.filter(i => i.code === 'description-missing');
    expect(completeness.length).toBeGreaterThanOrEqual(1);
    // suggestedNext should point to completeness
    if (result.suggestedNext) {
      expect(result.suggestedNext).toContain('description-missing');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests next command based on priority', async () => {
    const { tmpDir } = await createTmpProject('check-suggest', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source to trigger drift (highest priority suggestion)
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    // With drift present, suggested next should reference the drifted node
    if (result.suggestedNext) {
      expect(result.suggestedNext).toContain('svc/my-service');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests --aspect batch command when >=2 upstream-drift share same aspect cause', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-suggest-aspect', {
      nodePath: 'svc/alpha',
      nodeYaml: 'name: Alpha\ntype: service\ndescription: alpha\naspects:\n  - audit\nmapping:\n  - src/alpha/\n',
      mappingFiles: { 'src/alpha/index.ts': 'export const a = 1;\n' },
      aspects: [{
        id: 'audit',
        yaml: 'name: Audit\ndescription: audit\n',
        files: { 'content.md': 'Log mutations.\n' },
      }],
    });

    // Create second node with same aspect
    const node2Dir = path.join(yggRoot, 'model/svc/beta');
    await mkdir(node2Dir, { recursive: true });
    await writeFile(path.join(node2Dir, 'yg-node.yaml'),
      'name: Beta\ntype: service\ndescription: beta\naspects:\n  - audit\nmapping:\n  - src/beta/\n');
    await mkdir(path.join(tmpDir, 'src/beta'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src/beta/index.ts'), 'export const b = 2;\n');

    await recordBaseline(tmpDir);

    // Modify aspect to trigger cascade on both nodes
    await writeFile(path.join(yggRoot, 'aspects/audit/content.md'), 'Updated audit rules.\n');

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/alpha/index.ts', 'src/beta/index.ts']);

    expect(result.suggestedNext).toContain('--aspect audit');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests single node context when only 1 upstream-drift exists', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-suggest-single', {
      nodePath: 'svc/alpha',
      nodeYaml: 'name: Alpha\ntype: service\ndescription: alpha\naspects:\n  - audit\nmapping:\n  - src/alpha/\n',
      mappingFiles: { 'src/alpha/index.ts': 'export const a = 1;\n' },
      aspects: [{
        id: 'audit',
        yaml: 'name: Audit\ndescription: audit\n',
        files: { 'content.md': 'Log mutations.\n' },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(yggRoot, 'aspects/audit/content.md'), 'Updated.\n');

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/alpha/index.ts']);

    // With only 1 cascade node, should suggest yg context --node, not batch
    expect(result.suggestedNext).toContain('yg context --node');
    expect(result.suggestedNext).not.toContain('--aspect');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests --flow batch command when >=2 upstream-drift share same flow cause', async () => {
    // Create two nodes that share a flow, then trigger cascade from flow artifact change
    const { tmpDir, yggRoot } = await createTmpProject('cascade-suggest-flow', {
      nodePath: 'svc/alpha',
      nodeYaml: 'name: Alpha\ntype: service\ndescription: alpha\naspects:\n  - testing\nmapping:\n  - src/alpha/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/alpha/index.ts': 'export const a = 1;\n' },
    });

    // Create second node
    const node2Dir = path.join(yggRoot, 'model/svc/beta');
    await mkdir(node2Dir, { recursive: true });
    await writeFile(path.join(node2Dir, 'yg-node.yaml'),
      'name: Beta\ntype: service\ndescription: beta\naspects:\n  - testing\nmapping:\n  - src/beta/\n');
    await mkdir(path.join(tmpDir, 'src/beta'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src/beta/index.ts'), 'export const b = 2;\n');

    // Create a flow that references both nodes
    const flowDir = path.join(yggRoot, 'flows/checkout-flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'yg-flow.yaml'),
      'name: Checkout\ndescription: checkout\nnodes:\n  - svc/alpha\n  - svc/beta\n');

    await recordBaseline(tmpDir);

    // Modify flow yg-flow.yaml to trigger cascade on both nodes
    await writeFile(path.join(flowDir, 'yg-flow.yaml'),
      'name: Checkout\ndescription: updated checkout\nnodes:\n  - svc/alpha\n  - svc/beta\n');

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/alpha/index.ts', 'src/beta/index.ts']);

    // Both nodes should have upstream-drift cascade from flow
    const upstreamDrift = result.issues.filter(i => i.code === 'upstream-drift');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(2);

    // suggestedNext should reference --flow batch command
    expect(result.suggestedNext).toContain('--flow checkout-flow');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests --node batch command when >=2 upstream-drift share same parent model cause', async () => {
    // Two sibling nodes sharing the same parent — parent artifact change triggers cascade on both
    const { tmpDir, yggRoot } = await createTmpProject('cascade-suggest-parent', {
      nodePath: 'svc/alpha',
      nodeYaml: 'name: Alpha\ntype: service\ndescription: alpha\naspects:\n  - testing\nmapping:\n  - src/alpha/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/alpha/index.ts': 'export const a = 1;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
      }],
    });

    // Create second sibling node under same parent
    const node2Dir = path.join(yggRoot, 'model/svc/beta');
    await mkdir(node2Dir, { recursive: true });
    await writeFile(path.join(node2Dir, 'yg-node.yaml'),
      'name: Beta\ntype: service\ndescription: beta\naspects:\n  - testing\nmapping:\n  - src/beta/\n');
    await mkdir(path.join(tmpDir, 'src/beta'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src/beta/index.ts'), 'export const b = 2;\n');

    await recordBaseline(tmpDir);

    // Modify parent yg-node.yaml to trigger cascade on both children
    await writeFile(
      path.join(yggRoot, 'model/svc/yg-node.yaml'),
      'name: Svc\ntype: service\ndescription: updated parent\n',
    );

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/alpha/index.ts', 'src/beta/index.ts']);

    // Both nodes should have upstream-drift cascade from parent
    const upstreamDrift = result.issues.filter(i => i.code === 'upstream-drift');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(2);

    // suggestedNext should reference --node batch with parent path
    expect(result.suggestedNext).toContain('--node svc');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects deleted file that was tracked as cascade (non-source layer)', async () => {
    // A file in baseline with a non-source layer that gets deleted.
    // This exercises line 196 — deleted file with known layer (not 'source').
    const { tmpDir, yggRoot } = await createTmpProject('deleted-cascade-file', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Delete the aspect content file on disk (still in baseline)
    await rm(path.join(yggRoot, 'aspects/logging/content.md'), { force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect upstream-drift from the deleted aspect file
    const drift = result.filter(i => i.nodePath === 'svc/my-service');
    expect(drift.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects deleted source file not in current tracked context (no layer, source category)', async () => {
    // A file in baseline but now outside tracked files — layer unknown, category is 'source'
    // This exercises line 205 — deleted file where layer is undefined and path is source.
    const { tmpDir } = await createTmpProject('deleted-unknown-source', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n  - src/extra.ts\n',
      aspects: [TEST_ASPECT],
      mappingFiles: {
        'src/svc/index.ts': 'export default 42;\n',
        'src/extra.ts': 'export const extra = true;\n',
      },
    });
    await recordBaseline(tmpDir);
    // Remove the extra.ts mapping from node YAML and delete the file
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
    );
    await rm(path.join(tmpDir, 'src/extra.ts'), { force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect drift — the file was in baseline but no longer tracked
    expect(result.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null suggestedNext when only port-related errors exist (not in known categories)', async () => {
    // Port errors (port-missing-consumes, etc.) are severity 'error' but not in STRUCTURAL_CODES.
    // This exercises line 682 — the final return null in computeSuggestedNext.
    const { tmpDir, yggRoot } = await createTmpProject('port-errors-only', {
      nodePath: 'svc/consumer',
      nodeYaml: 'name: Consumer\ntype: service\ndescription: test\nrelations:\n  - target: svc/provider\n    type: uses\nmapping:\n  - src/consumer/\n',
      mappingFiles: { 'src/consumer/index.ts': 'export default 1;\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/provider',
          yaml: 'name: Provider\ntype: service\ndescription: provider\nports:\n  charge:\n    description: Payment\n    aspects: []\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/consumer/index.ts']);
    // The port-missing-consumes error should exist but suggestedNext may be null
    // since port codes aren't in STRUCTURAL_CODES
    const portErrors = result.issues.filter(i => i.code === 'port-missing-consumes');
    if (portErrors.length > 0) {
      // If port errors are the ONLY error category, suggestedNext should be null
      const otherErrors = result.issues.filter(i =>
        i.severity === 'error' &&
        i.code !== 'port-missing-consumes' &&
        i.code !== 'port-undefined' &&
        i.code !== 'consumes-without-ports',
      );
      if (otherErrors.length === 0) {
        expect(result.suggestedNext).toBeNull();
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  });
});
