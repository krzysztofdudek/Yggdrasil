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
import type { LlmProvider } from '../../../src/llm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASPECT_YAML =
  'name: Deterministic\ndescription: Pure transforms only\n';

async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  mappingFiles?: Record<string, string>;
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
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.0.0"\n');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

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
    verifyAspect: async () => ({ satisfied: true, reason: 'ok' }),
    needsChunking: true,
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
    ...overrides,
  };
}

function makeLlmConfig(provider: LlmProvider | undefined, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider,
    maxTokens: undefined,
    consensus: undefined,
    ...overrides,
  };
}

describe('LLM verification (CLI layer)', () => {
  it('runs LLM aspect verification and refuses when aspect not satisfied', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('llm-refuse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change source to trigger approval
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    const provider = makeMockProvider({
      async verifyAspect() {
        return { satisfied: false, reason: 'Date.now() found — not side-effect free' };
      },
    });

    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, makeLlmConfig(provider));
    expect(result.action).toBe('refused');
    expect(result.aspectViolations).toBeDefined();
    expect(result.aspectViolations!.length).toBeGreaterThan(0);
    expect(result.aspectViolations![0].reason).toContain('Date.now()');
    expect(result.aspectResults?.['deterministic']?.satisfied).toBe(false);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports LLM unavailable when no provider given', async () => {
    const { tmpDir } = await createTmpProject('llm-skip-unavailable', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, makeLlmConfig(undefined));
    expect(result.llmSkipped).toBe('unavailable');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

});
