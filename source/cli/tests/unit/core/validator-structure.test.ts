import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempYggdrasil(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yg-test-'));
  tempDirs.push(base);
  const yggDir = path.join(base, '.yggdrasil');
  await mkdir(yggDir, { recursive: true });
  return yggDir;
}

async function createAspectDir(
  rootPath: string,
  aspectId: string,
  files: ('content.md' | 'check.mjs')[],
): Promise<void> {
  const aspectDir = path.join(rootPath, 'aspects', aspectId);
  await mkdir(aspectDir, { recursive: true });
  for (const file of files) {
    await writeFile(path.join(aspectDir, file), `// ${file} placeholder`);
  }
}

function makeAspect(id: string, reviewer: AspectDef['reviewer']): AspectDef {
  return {
    name: id,
    id,
    description: `Test aspect ${id}`,
    artifacts: [],
    reviewer,
  };
}

function makeGraph(rootPath: string, overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath,
    ...overrides,
  };
}

// --- Test cases ---

describe('validator — aspect-rule-sources for structure', () => {
  it('rejects structure aspect with content.md (aspect-unexpected-rule-source)', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 's1', ['content.md']);
    const aspect = makeAspect('s1', { type: 'deterministic' });
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const issue = result.issues.find((i) => i.code === 'aspect-unexpected-rule-source');

    expect(issue).toBeDefined();
    expect(issue?.messageData.why).toContain('A script rule');
  });

  it('rejects structure aspect without check.mjs (aspect-missing-rule-source)', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created in the aspect dir
    const aspect = makeAspect('s2', { type: 'deterministic' });
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const issue = result.issues.find((i) => i.code === 'aspect-missing-rule-source');

    expect(issue).toBeDefined();
    expect(issue?.messageData.why).toContain('A script rule');
  });

  it('accepts structure aspect with check.mjs only', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 's3', ['check.mjs']);
    const aspect = makeAspect('s3', { type: 'deterministic' });
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-unexpected-rule-source');
    expect(codes).not.toContain('aspect-missing-rule-source');
    expect(codes).not.toContain('aspect-both-rule-sources');
  });

  it('rejects structure aspect with both check.mjs and content.md', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 's4', ['check.mjs', 'content.md']);
    const aspect = makeAspect('s4', { type: 'deterministic' });
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-both-rule-sources');
    expect(codes).toContain('aspect-unexpected-rule-source');
    const issue = result.issues.find((i) => i.code === 'aspect-unexpected-rule-source');
    expect(issue?.messageData.why).toContain('A script rule');
  });
});
