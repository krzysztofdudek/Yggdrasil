/**
 * resolveCompanionsForPair for a NODELESS pair — a file enforced by its
 * architecture type alone, with no owning component. Unlike
 * companion-resolve.test.ts (which mocks the hook loader / allowed-reads to
 * pin message shape), these tests drive the REAL runCompanionHook,
 * buildNodelessUnitCtx, and collectArchitectureReach end to end over real
 * on-disk files — the point is proving the real wiring a type-covered
 * file's companion resolution depends on, not a message shape in isolation.
 *
 * The second case's companion.mjs shape (`ctx.graph.node(ctx.node.id)`) is
 * copied from the real precedent at
 * tests/fixtures/e2e-companion/.yggdrasil/aspects/multi-companion/companion.mjs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveCompanionsForPair } from '../../../src/core/companion-resolve.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { ArchitectureDef, Graph, AspectDef } from '../../../src/model/graph.js';
import type { ExpectedPair, TypeCoverageInput } from '../../../src/core/pairs.js';

function writeFile(g: Graph, rel: string, content = ''): void {
  const abs = path.join(path.dirname(g.rootPath), rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function writeCompanion(g: Graph, aspectId: string, body: string): void {
  const dir = path.join(path.dirname(g.rootPath), '.yggdrasil', 'aspects', aspectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'companion.mjs'), body);
}

const ARCHITECTURE: ArchitectureDef = {
  node_types: {
    leaf: {
      description: 'A file classified by its own type, no component.',
      relationDefault: 'deny',
      relations: { uses: ['helper-type'] },
    },
    'helper-type': { description: 'A type-covered helper leaf may depend on.' },
    'forbidden-type': { description: 'A type leaf is NOT permitted to depend on.' },
  },
};

function buildGraph(): Graph {
  const g = buildTestGraphForStructure({ nodes: [] });
  g.architecture = ARCHITECTURE;
  return g;
}

function makeAspect(id: string): AspectDef {
  return { id, name: id, description: 'x', reviewer: { type: 'llm' }, hasCompanion: true } as unknown as AspectDef;
}

function nodelessPair(aspectId: string): ExpectedPair {
  return {
    aspectId, kind: 'llm', unitKey: 'file:src/leaf/a.ts', status: 'enforced', subjectFiles: ['src/leaf/a.ts'],
  } as ExpectedPair;
}

const TC: TypeCoverageInput = {
  covered: new Map([
    ['src/leaf/a.ts', 'leaf'],
    ['src/helper/h.ts', 'helper-type'],
    ['src/forbidden/f.ts', 'forbidden-type'],
  ]),
  ambiguousPaths: [],
};

describe('resolveCompanionsForPair — nodeless pair (no owning component)', () => {
  afterEach(() => cleanupTestGraphs());

  it('resolves a paired file the architecture already permits', async () => {
    const g = buildGraph();
    const root = path.dirname(g.rootPath);
    writeFile(g, 'src/leaf/a.ts', 'export const a = 1;\n');
    writeFile(g, 'src/helper/h.ts', 'export const h = 1;\n');
    writeCompanion(g, 'aspect-with-companion', `export function companion(_ctx) {\n  return [{ path: 'src/helper/h.ts' }];\n}\n`);

    const r = await resolveCompanionsForPair(g, root, nodelessPair('aspect-with-companion'), makeAspect('aspect-with-companion'), TC);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.companions.promptCompanions.map((c) => c.path)).toEqual(['src/helper/h.ts']);
  });

  it('refuses a paired file the architecture does not permit this type to reach', async () => {
    const g = buildGraph();
    const root = path.dirname(g.rootPath);
    writeFile(g, 'src/leaf/a.ts', 'export const a = 1;\n');
    writeFile(g, 'src/forbidden/f.ts', 'export const f = 1;\n');
    writeCompanion(g, 'aspect-forbidden-companion', `export function companion(_ctx) {\n  return [{ path: 'src/forbidden/f.ts' }];\n}\n`);

    const r = await resolveCompanionsForPair(g, root, nodelessPair('aspect-forbidden-companion'), makeAspect('aspect-forbidden-companion'), TC);
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    // Never names a phantom component or constructs a SPECIFIC yg-node.yaml
    // PATH for a nodeless pair (there is no node whose path could appear in
    // one) — "a yg-node.yaml" as a common noun describing creating one is
    // fine (mirrors STRUCTURE_NODE_CONTEXT_UNAVAILABLE's own wording).
    expect(r.messageData.next).not.toContain('.yggdrasil/model/');
    expect(r.messageData.next.toLowerCase()).toContain('yg-architecture.yaml');
  });

  it('fails clearly when the paired-file rule needs a component to work', async () => {
    // Precedent shape: tests/fixtures/e2e-companion/.yggdrasil/aspects/multi-companion/companion.mjs
    // opens with ctx.graph.node(ctx.node.id) — exactly what a nodeless unit's
    // ctx.node / ctx.graph cannot answer. Nothing may be written or paid for.
    const g = buildGraph();
    const root = path.dirname(g.rootPath);
    writeFile(g, 'src/leaf/a.ts', 'export const a = 1;\n');
    writeCompanion(
      g,
      'aspect-with-component-hook',
      `export function companion(ctx) {\n  const self = ctx.graph.node(ctx.node.id);\n  return [];\n}\n`,
    );

    const r = await resolveCompanionsForPair(g, root, nodelessPair('aspect-with-component-hook'), makeAspect('aspect-with-component-hook'), TC);
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/needs a component/);
    expect(r.messageData.next).toMatch(/give this file a component of its own|rewrite/);
    expect(r.messageData.next).not.toMatch(/undefined|\bnode ''/);
  });

  it('a repeated resolution for a file of the same type reuses the shared reach cache (no behavioral change, just cost)', async () => {
    const g = buildGraph();
    const root = path.dirname(g.rootPath);
    writeFile(g, 'src/leaf/a.ts', 'export const a = 1;\n');
    writeFile(g, 'src/helper/h.ts', 'export const h = 1;\n');
    writeCompanion(g, 'cache-probe', `export function companion(_ctx) {\n  return [{ path: 'src/helper/h.ts' }];\n}\n`);

    const reachCache = new Map<string, Set<string>>();
    const r1 = await resolveCompanionsForPair(g, root, nodelessPair('cache-probe'), makeAspect('cache-probe'), TC, reachCache);
    const r2 = await resolveCompanionsForPair(g, root, nodelessPair('cache-probe'), makeAspect('cache-probe'), TC, reachCache);
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    expect(reachCache.has('leaf')).toBe(true);
  });
});
