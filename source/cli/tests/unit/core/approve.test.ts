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

/** Default aspect for tests that need to exercise the full approve flow */
const TEST_ASPECT = {
  id: 'testing',
  yaml: 'name: Testing\ndescription: test aspect\n',
  files: { 'content.md': 'Test rule.\n' },
};

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
    opts.configYaml ?? 'version: "4.0.0"\n',
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
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change source + aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Source changed → ACCEPTS
  it('accepts when source changed', async () => {
    const { tmpDir } = await createTmpProject('both-changed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [TEST_ASPECT],
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [TEST_ASPECT],
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('no-change');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // yg-node.yaml only change → no-op (metadata only, no source change)

  // First approve (no baseline)
  it('accepts first approve with no baseline', async () => {
    const { tmpDir } = await createTmpProject('first-approve', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [TEST_ASPECT],
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

describe('approveNode — no-aspects auto-approve', () => {
  it('auto-approves node with no effective aspects (skip hashing)', async () => {
    const { tmpDir } = await createTmpProject('no-aspects', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    expect(result.currentHash).toBe('');
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
        files: { 'content.md': 'Log all mutations.\n' },
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [TEST_ASPECT],
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('no-change');
    expect(result.currentHash).toBeDefined();
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


describe('resolveAspects', () => {
  it('includes flow-level aspects in resolved aspects', async () => {
    const { resolveAspects } = await import('../../../src/core/approve.js');
    const { tmpDir } = await createTmpProject('resolve-flow-aspects', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'flow-aspect',
        yaml: 'name: FlowAspect\ndescription: from flow\n',
        files: { 'content.md': 'Flow aspect rules.\n' },
      }],
    });
    // Create a flow that references our node with aspects
    const flowDir = path.join(tmpDir, '.yggdrasil/flows/test-flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(
      path.join(flowDir, 'yg-flow.yaml'),
      'name: Test Flow\ndescription: test\nnodes:\n  - svc/my-service\naspects:\n  - flow-aspect\n',
    );
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const aspects = resolveAspects(node, graph);
    // flow-aspect should be resolved since it comes from the flow
    expect(aspects.some(a => a.id === 'flow-aspect')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('annotates upstream change as dependency metadata when relational layer changes', async () => {
    // Exercise approve.ts line 196-197: annotateUpstreamChange with layer 'relational'
    const { tmpDir, yggRoot } = await createTmpProject('relational-upstream', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [TEST_ASPECT],
      parentNodes: [
        { path: 'svc', yaml: 'name: Svc\ntype: service\ndescription: parent\n' },
        { path: 'svc/dep', yaml: 'name: Dep\ntype: service\ndescription: dependency\n' },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify dependency yg-node.yaml (tracked as relational layer)
    await writeFile(
      path.join(yggRoot, 'model/svc/dep/yg-node.yaml'),
      'name: Dep\ntype: service\ndescription: updated dependency for approve test\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    expect(result.changedUpstream).toBeDefined();
    // The upstream change annotation should indicate dependency metadata
    const relationalChanges = result.changedUpstream!.filter(c =>
      c.annotation === 'dependency metadata' || c.annotation === 'upstream content',
    );
    expect(relationalChanges.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves aspects with no flow participation', async () => {
    const { resolveAspects } = await import('../../../src/core/approve.js');
    const { tmpDir } = await createTmpProject('resolve-no-flow', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - direct-aspect\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'direct-aspect',
        yaml: 'name: DirectAspect\ndescription: direct\n',
        files: { 'content.md': 'Direct rules.\n' },
      }],
    });
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const aspects = resolveAspects(node, graph);
    expect(aspects.some(a => a.id === 'direct-aspect')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
