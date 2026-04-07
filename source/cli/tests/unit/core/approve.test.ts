import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
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
  artifacts?: Record<string, string>;
  parentNodes?: Array<{ path: string; yaml: string; artifacts?: Record<string, string> }>;
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

  // Write artifacts
  if (opts.artifacts) {
    for (const [name, content] of Object.entries(opts.artifacts)) {
      await writeFile(path.join(nodeDir, name), content);
    }
  } else {
    await writeFile(
      path.join(nodeDir, 'responsibility.md'),
      'This node handles testing of the approve function in detail.',
    );
  }

  // Parent nodes
  if (opts.parentNodes) {
    for (const pn of opts.parentNodes) {
      const pDir = path.join(yggRoot, 'model', pn.path);
      await mkdir(pDir, { recursive: true });
      await writeFile(path.join(pDir, 'yg-node.yaml'), pn.yaml);
      if (pn.artifacts) {
        for (const [aName, content] of Object.entries(pn.artifacts)) {
          await writeFile(path.join(pDir, aName), content);
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
    // Change all three: source + artifact + aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility reflecting all three axes changed here.',
    );
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 1: own changed + source changed → ACCEPTS
  it('accepts when both own artifacts and source changed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('both-changed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change source + artifact
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility reflecting the new default value of 99.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 2: own changed + source unchanged → REFUSES
  it('refuses when own artifacts changed but source unchanged', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('graph-only', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change only artifact
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility only, source not touched at all here.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 2 with --reviewed: ACCEPTS
  it('accepts graph-only change with --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('graph-ack', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Typo fix in responsibility, no source impact at all here.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service', { reviewed: 'typo fix in docs' });
    expect(result.action).toBe('reviewed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 3: source changed + own unchanged → REFUSES
  it('refuses when source changed but own artifacts unchanged', async () => {
    const { tmpDir } = await createTmpProject('source-only', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    expect(result.axes?.source).toBe('changed');
    expect(result.axes?.ownArtifacts).toBe('unchanged');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 3 with --reviewed: ACCEPTS
  it('accepts source-only change with --reviewed', async () => {
    const { tmpDir } = await createTmpProject('source-ack', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service', { reviewed: 'formatter ran, no semantic change' });
    expect(result.action).toBe('reviewed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --reviewed: reviewer still runs (key behavioral change from --acknowledge)
  it('runs LLM verification even with --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('reviewed-llm', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - test-aspect\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'test-aspect',
        yaml: 'name: TestAspect\ndescription: test\nanchors:\n  - id: must-export\n    claim: "File must export a default value"\n',
        files: { 'content.md': 'Must export a default value.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);

    // Mock LLM provider that fails a claim
    const mockProvider = {
      async verifyClaim() { return { satisfied: false, reason: 'Mock: claim not satisfied' }; },
      async reviewArtifact() { return { current: true, reason: 'ok' }; },
      async isAvailable() { return true; },
      async getContextWindowSize() { return 8192; },
    };

    const result = await approveNode(graph, 'svc/my-service', {
      reviewed: 'formatting change',
      llmProvider: mockProvider,
    });

    // Key assertion: even with --reviewed, LLM refusal wins
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toContain('Reviewer verification found issues');
    expect(result.e055Violations).toBeDefined();
    expect(result.e055Violations!.length).toBeGreaterThan(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 4: cascade only → REFUSES (requires --reviewed)
  it('refuses when only other tracked files changed (cascade)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-only', {
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
    // Change aspect (cascade trigger)
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Log ALL operations.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    expect(result.axes?.otherTracked).toBe('changed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 4 with --reviewed: ACCEPTS
  it('accepts cascade with --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-ack', {
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
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Log ALL operations.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service', { reviewed: 'source already compliant' });
    expect(result.action).toBe('reviewed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 5: no changes → no-op
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
  it('treats yg-node.yaml change as no-op (structural metadata)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('yaml-only', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change only yg-node.yaml (add description)
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: updated description\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    // yg-node.yaml is not an artifact — hash changed but no axis detects it → no-op
    expect(result.action).toBe('no-change');
    await rm(tmpDir, { recursive: true, force: true });
  });

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

  // --reviewed with empty reason → error
  it('rejects empty reviewed reason', async () => {
    const { tmpDir } = await createTmpProject('empty-ack', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    await expect(approveNode(graph, 'svc/my-service', { reviewed: '' }))
      .rejects.toThrow('non-empty');
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

  // Blackbox: source changed + --reviewed → REFUSES
  it('refuses --reviewed on blackbox source change', async () => {
    const { tmpDir } = await createTmpProject('bb-source-ack', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/auth/login.ts'), 'export function login() { return true; }\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth', { reviewed: 'reason' });
    expect(result.action).toBe('refused');
    expect(result.blackboxBlocked).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: yg-node.yaml only change (description, relation) → no-op
  it('treats yg-node.yaml-only change on blackbox as no-op', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-graph', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
    });
    await recordBaseline(tmpDir);
    // Only change yg-node.yaml (graph metadata)
    await writeFile(
      path.join(yggRoot, 'model/legacy/auth/yg-node.yaml'),
      'name: LegacyAuth\ntype: service\ndescription: updated legacy auth description\nblackbox: true\nmapping:\n  - src/auth/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    // yg-node.yaml is metadata → no axis detects change → no-op
    expect(result.action).toBe('no-change');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: cascade → requires --reviewed
  it('refuses cascade on blackbox without --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-cascade', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\naspects:\n  - logging\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated logging rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: cascade + --reviewed → ACCEPTS
  it('accepts cascade on blackbox with --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-cascade-ack', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\naspects:\n  - logging\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated logging rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth', { reviewed: 'blackbox intact, upstream reviewed' });
    expect(result.action).toBe('reviewed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: graph (.md) + cascade (no source) → REFUSES without --reviewed
  it('refuses graph+cascade on blackbox without --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-graph-cascade', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\naspects:\n  - logging\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      artifacts: {
        'responsibility.md': 'Legacy auth module handles authentication flows for the system.',
      },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test\n',
        files: { 'rules.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change own .md artifact + aspect (cascade) but NOT source
    await writeFile(
      path.join(yggRoot, 'model/legacy/auth/responsibility.md'),
      'Updated responsibility for graph+cascade blackbox test scenario.',
    );
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    // With --reviewed it should accept
    const graph2 = await loadGraph(tmpDir);
    const result2 = await approveNode(graph2, 'legacy/auth', { reviewed: 'graph+cascade reviewed' });
    expect(result2.action).toBe('reviewed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Blackbox: source + graph both changed → REFUSES (covers "Both changed" row)
  it('refuses when both source and graph changed on blackbox', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-both', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      artifacts: {
        'responsibility.md': 'Legacy auth module handles authentication flows for the system.',
      },
    });
    await recordBaseline(tmpDir);
    // Change both source AND own artifact
    await writeFile(path.join(tmpDir, 'src/auth/login.ts'), 'export function login() { return true; }\n');
    await writeFile(
      path.join(yggRoot, 'model/legacy/auth/responsibility.md'),
      'Updated: Legacy auth now returns true for all login attempts.',
    );
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

  // Blackbox: .md artifact changed only (no source, no cascade) → REFUSES without --reviewed
  it('refuses .md artifact change on blackbox without --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('bb-md-only', {
      nodePath: 'legacy/auth',
      nodeYaml: 'name: LegacyAuth\ntype: service\ndescription: legacy auth\nblackbox: true\nmapping:\n  - src/auth/\n',
      mappingFiles: { 'src/auth/login.ts': 'export function login() {}\n' },
      artifacts: {
        'responsibility.md': 'Legacy auth module handles authentication flows in detail.',
      },
    });
    await recordBaseline(tmpDir);
    await writeFile(
      path.join(yggRoot, 'model/legacy/auth/responsibility.md'),
      'Updated responsibility for blackbox .md-only change test scenario.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'legacy/auth');
    expect(result.action).toBe('refused');
    // With --reviewed it should accept
    const graph2 = await loadGraph(tmpDir);
    const result2 = await approveNode(graph2, 'legacy/auth', { reviewed: '.md enrichment only' });
    expect(result2.action).toBe('reviewed');
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
  it('classifies deleted source file as source change', async () => {
    const { tmpDir } = await createTmpProject('deleted-source', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: {
        'src/svc/index.ts': 'export default 42;\n',
        'src/svc/helper.ts': 'export const helper = true;\n',
      },
    });
    await recordBaseline(tmpDir);
    // Delete one source file — it will be in storedEntry.files but not in fileHashes
    await rm(path.join(tmpDir, 'src/svc/helper.ts'));
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    // Source was deleted without updating artifacts → refused
    expect(result.action).toBe('refused');
    expect(result.axes?.source).toBe('changed');
    await rm(tmpDir, { recursive: true, force: true });
  });

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

  it('stores reviewed reason in drift state', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('store-reason', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    await approveNode(graph, 'svc/my-service', { reviewed: 'formatter ran' });
    // Read drift state and verify reason is stored
    const { readNodeDriftState: readState } = await import('../../../src/io/drift-state-store.js');
    const state = await readState(yggRoot, 'svc/my-service');
    expect(state?.reviewedReason).toBe('formatter ran');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends audit log entry on approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('audit-approve', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Change both source and artifact → both sides updated → approve
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/responsibility.md'),
      'Updated responsibility content for audit test.\n',
    );
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

  it('audit log includes reviewed reason', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('audit-ack', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    await approveNode(graph, 'svc/my-service', { reviewed: 'formatter ran' });

    const { readFile: rf } = await import('node:fs/promises');
    const logContent = await rf(path.join(yggRoot, '.audit-log.jsonl'), 'utf-8');
    const lastLine = logContent.trim().split('\n').pop()!;
    const entry = JSON.parse(lastLine);
    expect(entry.action).toBe('reviewed');
    expect(entry.reason).toBe('formatter ran');

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

  it('audit log entry on no-change approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('audit-no-change', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // No changes — triggers no-change path
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('no-change');

    const { readFile: rf } = await import('node:fs/promises');
    const logContent = await rf(path.join(yggRoot, '.audit-log.jsonl'), 'utf-8');
    const lastLine = logContent.trim().split('\n').pop()!;
    const entry = JSON.parse(lastLine);
    expect(entry.action).toBe('no-change');
    expect(entry.node).toBe('svc/my-service');
    expect(entry.prev).toBe(entry.hash);
    expect(entry.reason).toBeNull();

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

  it('cascade from hierarchy change annotates as parent artifact', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-hierarchy', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        artifacts: { 'responsibility.md': 'Parent responsibility initial content here.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(
      path.join(yggRoot, 'model/svc/responsibility.md'),
      'Updated parent responsibility content reflecting change.',
    );
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    expect(result.changedOther).toBeDefined();
    expect(result.changedOther!.some(c => c.annotation === 'parent artifact')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cascade from dependency change annotates as dependency interface', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-dep', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nrelations:\n  - target: svc/dep-service\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
      }],
    });
    // Create the dependency node
    const depDir = path.join(yggRoot, 'model/svc/dep-service');
    await mkdir(depDir, { recursive: true });
    await writeFile(path.join(depDir, 'yg-node.yaml'), 'name: DepService\ntype: service\ndescription: dep\n');
    await writeFile(path.join(depDir, 'responsibility.md'), 'Dependency responsibility initial content.\n');
    await writeFile(path.join(depDir, 'interface.md'), 'Dependency interface initial content.\n');
    await recordBaseline(tmpDir);
    // Change dependency interface
    await writeFile(path.join(depDir, 'interface.md'), 'Updated dependency interface content here.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    expect(result.changedOther).toBeDefined();
    expect(result.changedOther!.some(c => c.annotation === 'dependency interface')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cascade changedOther includes correct annotation', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-annotation', {
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
    await writeFile(path.join(yggRoot, 'aspects/logging/rules.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('refused');
    expect(result.changedOther).toBeDefined();
    expect(result.changedOther!.length).toBeGreaterThan(0);
    expect(result.changedOther![0].annotation).toBe('aspect content');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reviewed reason preserved across subsequent regular approve', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('reason-persist', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Review with reason
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    let graph = await loadGraph(tmpDir);
    await approveNode(graph, 'svc/my-service', { reviewed: 'formatter ran' });
    // Regular approve (no changes) — reason should persist
    graph = await loadGraph(tmpDir);
    await approveNode(graph, 'svc/my-service');
    const { readNodeDriftState: readState } = await import('../../../src/io/drift-state-store.js');
    const state = await readState(yggRoot, 'svc/my-service');
    expect(state?.reviewedReason).toBe('formatter ran');
    await rm(tmpDir, { recursive: true, force: true });
  });
});
