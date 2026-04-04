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

/**
 * Helper: create a minimal temp project for drift classification tests.
 */
async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  parentNodes?: Array<{ path: string; yaml: string; artifacts?: Record<string, string> }>;
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
    opts.configYaml ?? 'name: Test\nnode_types:\n  service:\n    description: x\n',
  );
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);
  await writeFile(
    path.join(nodeDir, 'responsibility.md'),
    'This node is responsible for testing drift classification scenarios.',
  );

  if (opts.parentNodes) {
    for (const pn of opts.parentNodes) {
      const pDir = path.join(yggRoot, 'model', pn.path);
      await mkdir(pDir, { recursive: true });
      await writeFile(path.join(pDir, 'yg-node.yaml'), pn.yaml);
      if (pn.artifacts) {
        for (const [artName, content] of Object.entries(pn.artifacts)) {
          await writeFile(path.join(pDir, artName), content);
        }
      }
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    expect(result).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 source-drift when source file changes', async () => {
    const { tmpDir } = await createTmpProject('source-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source file
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].nodePath).toBe('svc/my-service');
    expect(e020[0].driftSubtype).toBe('source-drift');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 graph-drift when own artifact changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('graph-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify own artifact
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility content for testing graph drift detection.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('graph-drift');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E021 cascade-drift when aspect file changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify aspect content file
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Log ALL operations, not just mutations.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].nodePath).toBe('svc/my-service');
    expect(e021[0].cascadeCauses!).toHaveLength(1);
    expect(e021[0].cascadeCauses![0].description).toContain('logging');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns both E020 and E021 when direct and cascade changes happen', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('compound', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify BOTH source and aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const nodeIssues = result.filter(i => i.nodePath === 'svc/my-service');
    const e020 = nodeIssues.filter(i => i.code === 'E020');
    const e021 = nodeIssues.filter(i => i.code === 'E021');
    expect(e020).toHaveLength(1);
    expect(e021).toHaveLength(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 unmaterialized when no baseline exists', async () => {
    const { tmpDir } = await createTmpProject('unmaterialized', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('unmaterialized');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 unmaterialized with files-never-created message when source path absent', async () => {
    const { tmpDir } = await createTmpProject('unmaterialized-absent', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/absent/\n',
      // Do NOT create the mapping directory at all
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('unmaterialized');
    expect(e020[0].message).toContain('never created');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 missing when source files are gone', async () => {
    const { tmpDir } = await createTmpProject('missing-src', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Delete all source files
    await rm(path.join(tmpDir, 'src/svc'), { recursive: true, force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('missing');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E020 full-drift when both source and own graph artifacts change', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('full-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify BOTH source file and own artifact
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility for full-drift test.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('full-drift');
    expect(e020[0].message).toContain('Both source files and graph artifacts');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E021 cascade-drift when hierarchy (parent) artifact changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-hierarchy', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        artifacts: { 'responsibility.md': 'Parent responsibility.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify parent artifact
    await writeFile(
      path.join(yggRoot, 'model/svc/responsibility.md'),
      'Updated parent responsibility triggering cascade.\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].cascadeCauses![0].layer).toBe('hierarchy');
    expect(e021[0].cascadeCauses![0].description).toContain('parent node');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects drift when tracked file is removed from context (aspect removed)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('deleted-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Remove aspect reference from node YAML — the aspect files will be in baseline but not in current context
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect some form of drift (E020 because own yg-node.yaml changed,
    // plus deleted aspect files from baseline)
    expect(result.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E021 cascade-drift when flow artifact changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-flow', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Create a flow that references our node
    const flowDir = path.join(yggRoot, 'flows/checkout-flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout Flow\ndescription: test flow\nnodes:\n  - svc/my-service\n');
    await writeFile(path.join(flowDir, 'description.md'), 'Original flow description.\n');
    await recordBaseline(tmpDir);
    // Modify flow artifact
    await writeFile(path.join(flowDir, 'description.md'), 'Updated flow description triggering cascade.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].cascadeCauses!.some(c => c.layer === 'flows')).toBe(true);
    expect(e021[0].cascadeCauses!.some(c => c.description.includes('flow'))).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns E021 cascade-drift when dependency artifact changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-dep', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
          artifacts: { 'responsibility.md': 'Dep responsibility.\n', 'interface.md': 'Dep interface.\n' },
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify dependency interface
    await writeFile(
      path.join(yggRoot, 'model/svc/dep/interface.md'),
      'Updated dependency interface triggering cascade.\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].cascadeCauses!.some(c => c.layer === 'relational')).toBe(true);
    expect(e021[0].cascadeCauses!.some(c => c.description.includes('dependency'))).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });


  it('E021 collapse: multiple upstream changes emit only ONE E021 with all causes merged', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-collapse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
          artifacts: { 'interface.md': 'Dep interface.\n' },
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Trigger cascade from TWO different upstream sources simultaneously:
    // 1. aspect file change
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated logging rules triggering cascade.\n');
    // 2. dependency artifact change
    await writeFile(path.join(yggRoot, 'model/svc/dep/interface.md'), 'Updated dep interface triggering cascade.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    // Must collapse to exactly ONE E021 for this node
    expect(e021).toHaveLength(1);
    // Must contain causes from both upstream changes
    expect(e021[0].cascadeCauses!.length).toBeGreaterThanOrEqual(2);
    const layers = e021[0].cascadeCauses!.map(c => c.layer);
    expect(layers).toContain('aspects');
    expect(layers).toContain('relational');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('E021 verificationLabel is "last verified: pass" when claimResults all satisfied', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('verif-pass', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export function createAuditLog() { return 42; }\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Seed drift state with all-satisfied claimResults (simulating prior LLM-powered approve)
    const storeModule = await import('../../../src/io/drift-state-store.js');
    const existing = await storeModule.readNodeDriftState(yggRoot, 'svc/my-service');
    await storeModule.writeNodeDriftState(yggRoot, 'svc/my-service', {
      ...existing!,
      claimResults: { 'logging': { 'audit-entry': { satisfied: true, reason: 'found audit log' } } },
    });
    // Modify aspect content to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].verificationLabel).toBe('last verified: pass');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('E021 verificationLabel is "last verified: fail" when claimResults has unsatisfied entry', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('verif-fail', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export function hello() { return 42; }\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Seed drift state with a failing claimResults entry
    const storeModule = await import('../../../src/io/drift-state-store.js');
    const existing = await storeModule.readNodeDriftState(yggRoot, 'svc/my-service');
    await storeModule.writeNodeDriftState(yggRoot, 'svc/my-service', {
      ...existing!,
      claimResults: { 'logging': { 'audit-entry': { satisfied: false, reason: 'no audit log found' } } },
    });
    // Modify aspect content to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].verificationLabel).toBe('last verified: fail');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('E021 verificationLabel is "never verified" when no claimResults in drift state', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('verif-none', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // No claimResults seeded -- baseline only
    // Modify aspect to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const e021 = result.filter(i => i.code === 'E021' && i.nodePath === 'svc/my-service');
    expect(e021.length).toBeGreaterThanOrEqual(1);
    expect(e021[0].verificationLabel).toBe('never verified');
    await rm(tmpDir, { recursive: true, force: true });
  });

});

  it('handles drift state without mtimes (legacy baseline)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('no-mtimes', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Overwrite drift state without mtimes (simulating legacy data)
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
    const e020 = result.filter(i => i.code === 'E020');
    expect(e020).toHaveLength(1);
    expect(e020[0].driftSubtype).toBe('source-drift');
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
      nodeYaml: 'name: Sub\ntype: service\ndescription: test\nmapping:\n  - src/svc/sub/\n',
      mappingFiles: { 'src/svc/index.ts': 'parent file\n', 'src/svc/sub/inner.ts': 'child file\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent root\n',
        },
        {
          path: 'svc/my-service',
          yaml: 'name: MyService\ntype: service\ndescription: parent\nmapping:\n  - src/svc/\n',
          artifacts: { 'responsibility.md': 'Parent service.\n' },
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
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

  it('returns E022 for small count (<=5 files)', () => {
    const issue = buildCoverageIssue(['a.ts', 'b.ts'], 10);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe('E022');
    expect(issue!.severity).toBe('error');
    expect(issue!.uncoveredCount).toBe(2);
    expect(issue!.message).toContain('2 source files');
    expect(issue!.message).toContain('a.ts');
    expect(issue!.message).toContain('b.ts');
  });

  it('returns E022 for large count (>5 files) with guidance before examples', () => {
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const issue = buildCoverageIssue(files, 100);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe('E022');
    expect(issue!.uncoveredCount).toBe(20);
    // Guidance should come before "Examples of uncovered files"
    const msg = issue!.message;
    const guidanceIdx = msg.indexOf('Add to an existing');
    const examplesIdx = msg.indexOf('Examples of uncovered files');
    expect(guidanceIdx).toBeLessThan(examplesIdx);
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
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
  it('suggests cascade when E021 is present without E020', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('suggest-cascade', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Only modify aspect (cascade) -- do NOT modify source or own artifacts
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules for cascade suggestion test.\n');
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    // E021 should be present, E020 should not
    const e020 = result.issues.filter(i => i.code === 'E020');
    const e021 = result.issues.filter(i => i.code === 'E021');
    expect(e020).toHaveLength(0);
    expect(e021.length).toBeGreaterThanOrEqual(1);
    // Suggested next should reference cascade context review
    if (result.suggestedNext && e021.length > 0) {
      expect(result.suggestedNext).toContain('svc/my-service');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests structural fix when E001-E013 are the highest priority', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('suggest-structural', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nrelations:\n  - target: nonexistent/node\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    // Should have a structural error (broken relation)
    const structural = result.issues.filter(i => i.code >= 'E001' && i.code <= 'E013');
    expect(structural.length).toBeGreaterThanOrEqual(1);
    // With no drift errors, suggestion should reference structural fix
    if (result.suggestedNext && !result.issues.some(i => i.code === 'E020' || i.code === 'E021')) {
      expect(result.suggestedNext).toContain('Fix');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests coverage when only E022 errors exist', async () => {
    const { tmpDir } = await createTmpProject('suggest-coverage', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    // Pass uncovered files to trigger E022
    const result = await runCheck(graph, ['src/svc/index.ts', 'src/other/file.ts', 'lib/util.ts']);
    const e022 = result.issues.filter(i => i.code === 'E022');
    expect(e022).toHaveLength(1);
    // suggestedNext might reference structural or completeness errors from validation,
    // but if E022 is the only category it should suggest coverage
    if (result.suggestedNext && !result.issues.some(i => i.code === 'E020' || i.code === 'E021' || (i.code >= 'E001' && i.code <= 'E013'))) {
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
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    // Pass all git files as covered
    const result = await runCheck(graph, ['src/svc/index.ts']);
    expect(result.nodeCount).toBeGreaterThanOrEqual(1);
    expect(result.projectName).toBe('Test');
    expect(result.aspectCount).toBeGreaterThanOrEqual(0);
    expect(result.flowCount).toBeGreaterThanOrEqual(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes E020 drift issues in orchestrated result', async () => {
    const { tmpDir } = await createTmpProject('check-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source to trigger drift
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    const e020 = result.issues.filter(i => i.code === 'E020');
    expect(e020.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes E022 coverage issues when uncovered files exist', async () => {
    const { tmpDir } = await createTmpProject('check-coverage', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts', 'src/other/util.ts']);
    const e022 = result.issues.filter(i => i.code === 'E022');
    expect(e022).toHaveLength(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips E022 when gitTrackedFiles is null', async () => {
    const { tmpDir } = await createTmpProject('check-no-git', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, null);
    const e022 = result.issues.filter(i => i.code === 'E022');
    expect(e022).toHaveLength(0);
    expect(result.totalFiles).toBe(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes W005 when orphaned drift state exists', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('check-orphan', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': '' },
    });
    await recordBaseline(tmpDir);
    // Write orphaned drift state
    await writeNodeDriftState(yggRoot, 'ghost/deleted', {
      hash: 'aaaa', files: {},
    });
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);
    const w005 = result.issues.filter(i => i.code === 'W005');
    expect(w005.length).toBeGreaterThanOrEqual(1);
    expect(w005[0].nodePath).toBe('ghost/deleted');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests completeness fix when only completeness errors exist', async () => {
    // A node without responsibility.md will trigger E030 (missing-artifact)
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
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'name: Test\nnode_types:\n  service:\n    description: x\n');
    await writeFile(path.join(parentDir, 'yg-node.yaml'), 'name: Svc\ntype: service\ndescription: parent\n');
    await writeFile(path.join(parentDir, 'responsibility.md'), 'Parent.\n');
    // Node WITHOUT responsibility.md (triggers E030)
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: Bare\ntype: service\ndescription: bare node\n');
    // No mapping -> no drift, no coverage issues

    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, []);
    // Should have completeness errors (E030) but no drift/structural/coverage
    const completeness = result.issues.filter(i => i.code && i.code >= 'E030');
    expect(completeness.length).toBeGreaterThanOrEqual(1);
    // suggestedNext should point to completeness
    if (result.suggestedNext) {
      expect(result.suggestedNext).toContain('E030');
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('suggests next command based on priority', async () => {
    const { tmpDir } = await createTmpProject('check-suggest', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
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
});
