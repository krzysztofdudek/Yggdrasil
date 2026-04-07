import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/utils/hash.js';
import { collectTrackedFiles } from '../../../src/core/context-files.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASPECT_YAML_WITH_CLAIMS =
  'name: Deterministic\ndescription: Pure transforms only\n' +
  'anchors:\n  - id: no-side-effects\n    claim: "No side effects"\n  - id: pure-transforms\n    claim: "Pure transforms only"\n';

async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  mappingFiles?: Record<string, string>;
  artifacts?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-approve-llm-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'name: Test\nnode_types:\n  service:\n    description: x\n');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

  if (opts.artifacts) {
    for (const [aName, content] of Object.entries(opts.artifacts)) {
      await writeFile(path.join(nodeDir, aName), content);
    }
  } else {
    await writeFile(path.join(nodeDir, 'responsibility.md'), 'This node handles testing.\n');
  }

  // Create parent nodes for nested paths (e.g. 'svc/my-service' needs 'svc' parent)
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

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    async verifyClaim() { return { satisfied: true, reason: 'ok' }; },
    async reviewArtifact() { return { current: true, reason: 'up to date' }; },
    async isAvailable() { return true; },
    async getContextWindowSize() { return 8192; },
    ...overrides,
  };
}

describe('approveNode — LLM verification', () => {
  it('runs LLM claim verification and refuses when claim not satisfied', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-refuse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML_WITH_CLAIMS,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change both axes to pass three-axis check
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated responsibility.\n');

    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      async verifyClaim(params) {
        if (params.claim === 'No side effects') {
          return { satisfied: false, reason: 'Date.now() found — not side-effect free' };
        }
        return { satisfied: true, reason: 'ok' };
      },
    });

    const result = await approveNode(graph, 'svc/my-service', { llmProvider: provider });
    expect(result.action).toBe('refused');
    expect(result.e055Violations).toBeDefined();
    expect(result.e055Violations!.length).toBeGreaterThan(0);
    expect(result.e055Violations![0].reason).toContain('Date.now()');
    expect(result.claimResults?.['deterministic']?.['no-side-effects'].satisfied).toBe(false);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips LLM when no provider configured', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-skip-no-provider', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML_WITH_CLAIMS }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated.\n');

    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service', { llmNotConfigured: true });
    expect(result.llmSkipped).toBe('not-configured');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports LLM unavailable when provider configured but not reachable', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-skip-unavailable', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML_WITH_CLAIMS }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated.\n');

    const graph = await loadGraph(tmpDir);
    // No llmProvider, llmNotConfigured defaults to false → 'unavailable'
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.llmSkipped).toBe('unavailable');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips LLM for blackbox nodes', async () => {
    const { tmpDir } = await createTmpProject('llm-skip-blackbox', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nblackbox: true\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
    });
    await recordBaseline(tmpDir);
    // Only cascade change for blackbox (can't change source on blackbox without blocking)
    // Change an aspect to trigger cascade — but we need the aspect to exist
    // Instead: just test no-change (approved = no-op) with LLM skipped
    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      async verifyClaim() { return { satisfied: false, reason: 'should not be called' }; },
    });
    const result = await approveNode(graph, 'svc/my-service', { llmProvider: provider });
    // No changes → no-change, but LLM is skipped because blackbox
    expect(result.llmSkipped).toBe('blackbox');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('--reviewed with no LLM configured sets llmSkipped to not-configured', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-reviewed-no-llm', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML_WITH_CLAIMS }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated.\n');

    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service', {
      llmNotConfigured: true,
      reviewed: 'artifacts updated, source unchanged',
    });
    expect(result.action).toBe('reviewed');
    expect(result.llmSkipped).toBe('not-configured');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('--reviewed does not bypass LLM refusal', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-reviewed-no-override', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML_WITH_CLAIMS }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated.\n');

    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      async verifyClaim() { return { satisfied: false, reason: 'claim not satisfied' }; },
    });
    const result = await approveNode(graph, 'svc/my-service', {
      llmProvider: provider,
      reviewed: 'code is intentionally non-deterministic for testing',
    });
    // --reviewed bypasses three-axis only — LLM still runs and can refuse
    expect(result.action).toBe('refused');
    expect(result.claimResults).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runs LLM on cascade-only approve with --reviewed', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-cascade-reviewed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML_WITH_CLAIMS,
        files: { 'content.md': 'Determinism rules.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change only the aspect (cascade change) — no source or artifact changes
    await writeFile(path.join(yggRoot, 'aspects/deterministic/content.md'), 'Updated determinism rules.\n');

    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      async verifyClaim() { return { satisfied: true, reason: 'code is compliant' }; },
    });
    const result = await approveNode(graph, 'svc/my-service', {
      llmProvider: provider,
      reviewed: 'aspect updated, source already compliant',
    });
    expect(result.action).toBe('reviewed');
    // LLM runs even with --reviewed — reviewer verifies claims
    expect(result.claimResults).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses when artifact review returns current: false (E056)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-e056-refuse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML_WITH_CLAIMS,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change both axes so three-axis check passes
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\nexport function newEndpoint() {}\n');
    await writeFile(path.join(yggRoot, 'model/svc/my-service/responsibility.md'), 'Updated responsibility.\n');

    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      // Claims pass — no E055
      async verifyClaim() { return { satisfied: true, reason: 'ok' }; },
      // Artifact review fails — E056
      async reviewArtifact() {
        return { current: false, reason: 'responsibility.md does not mention the new endpoint' };
      },
    });

    const result = await approveNode(graph, 'svc/my-service', { llmProvider: provider, verifyArtifacts: true });
    expect(result.action).toBe('refused');
    expect(result.e056Violations).toBeDefined();
    expect(result.e056Violations!.length).toBeGreaterThan(0);
    expect(result.e056Violations![0].reason).toContain('does not mention the new endpoint');
    // E055 should have no violations
    expect(result.e055Violations ?? []).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
