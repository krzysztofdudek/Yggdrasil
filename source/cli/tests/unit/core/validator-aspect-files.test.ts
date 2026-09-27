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
  files: ('content.md' | 'check.mjs' | 'companion.mjs')[],
): Promise<void> {
  const aspectDir = path.join(rootPath, 'aspects', aspectId);
  await mkdir(aspectDir, { recursive: true });
  for (const file of files) {
    await writeFile(path.join(aspectDir, file), `// ${file} placeholder`);
  }
}

function makeAspect(id: string, reviewer?: AspectDef['reviewer'] | 'llm' | 'deterministic'): AspectDef {
  const reviewerSpec: AspectDef['reviewer'] =
    reviewer === undefined ? { type: 'llm' } :
    typeof reviewer === 'string' ? { type: reviewer as 'llm' | 'deterministic' } :
    reviewer;
  return {
    name: id,
    id,
    description: `Test aspect ${id}`,
    artifacts: [],
    reviewer: reviewerSpec,
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

describe('validator — aspect rule-source mutual exclusion', () => {
  it('reports aspect-missing-rule-source when reviewer is llm and content.md is absent', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created in the aspect dir — not even the dir itself
    const aspect = makeAspect('my-llm-aspect', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
  });

  it('reports aspect-missing-rule-source when reviewer is ast and check.mjs is absent', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created
    const aspect = makeAspect('my-ast-aspect', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
  });

  it('reports aspect-both-rule-sources AND aspect-unexpected-rule-source when reviewer is llm and both files exist', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'dual-llm', ['content.md', 'check.mjs']);
    const aspect = makeAspect('dual-llm', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-both-rule-sources');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reports aspect-both-rule-sources AND aspect-unexpected-rule-source when reviewer is ast and both files exist', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'dual-ast', ['content.md', 'check.mjs']);
    const aspect = makeAspect('dual-ast', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-both-rule-sources');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('does not report missing or unexpected errors when reviewer is ast and only check.mjs exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'clean-ast', ['check.mjs']);
    const aspect = makeAspect('clean-ast', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-missing-rule-source');
    expect(codes).not.toContain('aspect-unexpected-rule-source');
    expect(codes).not.toContain('aspect-both-rule-sources');
  });

  it('does not report missing-rule-source when reviewer is undefined and content.md exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'default-llm', ['content.md']);
    const aspect = makeAspect('default-llm'); // reviewer: undefined → treated as llm
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-missing-rule-source');
  });

  it('reports aspect-missing-rule-source AND aspect-unexpected-rule-source when reviewer is llm and only check.mjs exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'llm-wrong-file', ['check.mjs']);
    const aspect = makeAspect('llm-wrong-file', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reports aspect-missing-rule-source AND aspect-unexpected-rule-source when reviewer is ast and only content.md exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'ast-wrong-file', ['content.md']);
    const aspect = makeAspect('ast-wrong-file', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });
});

describe('validator — companion.mjs validation', () => {
  it('emits aspect-companion-without-content when companion.mjs present but no content.md (llm aspect missing rule source)', async () => {
    const rootPath = await createTempYggdrasil();
    // companion.mjs only — no content.md, no check.mjs
    await createAspectDir(rootPath, 'companion-no-content', ['companion.mjs']);
    const aspect = makeAspect('companion-no-content', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-companion-without-content');
  });

  it('emits aspect-companion-with-check ONLY (not also aspect-companion-without-content) when companion.mjs + check.mjs both present on an llm aspect', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'companion-with-check', ['content.md', 'check.mjs', 'companion.mjs']);
    // Force reviewer type to llm so both files are in play
    const aspect = makeAspect('companion-with-check', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-companion-with-check');
    expect(codes).not.toContain('aspect-companion-without-content');
  });

  it('emits aspect-companion-with-check ONLY when companion.mjs + check.mjs but no content.md', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'companion-check-only', ['check.mjs', 'companion.mjs']);
    const aspect = makeAspect('companion-check-only', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-companion-with-check');
    expect(codes).not.toContain('aspect-companion-without-content');
  });

  it('does NOT emit companion errors when companion.mjs + content.md exist (valid llm aspect with companion)', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'companion-valid', ['content.md', 'companion.mjs']);
    const aspect = makeAspect('companion-valid', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-companion-without-content');
    expect(codes).not.toContain('aspect-companion-with-check');
  });

  it('emits aspect-companion-without-content when an aggregate aspect ships companion.mjs', async () => {
    const rootPath = await createTempYggdrasil();
    // aggregate: implies something, no content.md, no check.mjs — but has companion.mjs
    await createAspectDir(rootPath, 'aggregate-with-companion', ['companion.mjs']);
    const aspect: import('../../../src/model/graph.js').AspectDef = {
      ...makeAspect('aggregate-with-companion', { type: 'aggregate' }),
      implies: ['some-other-aspect'],
    };
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-companion-without-content');
  });
});

describe('validator — the companion: key is refused wherever companion.mjs is', () => {
  function withKey(aspect: AspectDef): AspectDef {
    return { ...aspect, companionPath: 'tools/my-companion.mjs' };
  }

  it('a script rule with a companion: key → aspect-companion-with-check naming the key', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'script-with-key', ['check.mjs']);
    const graph = makeGraph(rootPath, { aspects: [withKey(makeAspect('script-with-key', 'deterministic'))] });
    const issue = (await validate(graph)).issues.find((i) => i.code === 'aspect-companion-with-check');
    expect(issue).toBeDefined();
    expect(issue!.messageData?.what).toContain("companion: 'tools/my-companion.mjs'");
    expect(issue!.messageData?.next).toContain('the companion: key');
  });

  it('a bundle with a companion: key → aspect-companion-without-content', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'bundle-with-key', []);
    const bundle = { ...makeAspect('bundle-with-key', { type: 'aggregate' } as AspectDef['reviewer']), implies: ['other'] };
    const graph = makeGraph(rootPath, { aspects: [withKey(bundle)] });
    const codes = (await validate(graph)).issues.map((i) => i.code);
    expect(codes).toContain('aspect-companion-without-content');
  });

  it('a reviewer rule with no content.md and a companion: key → aspect-companion-without-content', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'llm-key-no-content', []);
    const graph = makeGraph(rootPath, { aspects: [withKey(makeAspect('llm-key-no-content', 'llm'))] });
    const codes = (await validate(graph)).issues.map((i) => i.code);
    expect(codes).toContain('aspect-companion-without-content');
  });

  it('a reviewer rule with content.md and a companion: key → no companion error', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'llm-key-ok', ['content.md']);
    const graph = makeGraph(rootPath, { aspects: [withKey(makeAspect('llm-key-ok', 'llm'))] });
    const codes = (await validate(graph)).issues.map((i) => i.code);
    expect(codes).not.toContain('aspect-companion-without-content');
    expect(codes).not.toContain('aspect-companion-with-check');
  });
});
