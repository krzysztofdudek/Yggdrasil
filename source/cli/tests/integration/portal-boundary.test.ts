import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { computePortalBoundary } from '../../src/portal/engine-api.js';

/**
 * The FULL live boundary (phantom / declared-only / forbidden-type), exercised against
 * REAL on-disk fixture projects (real `.yggdrasil/` graph + real source) — no mocking.
 *
 * These fixtures deliberately construct each boundary class so the join logic in
 * `portal/api/boundary.ts` is covered on its own, independent of the real repo (which —
 * being green — has zero phantom and zero forbidden-type edges).
 */

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function writeNodeRaw(root: string, nodeRel: string, yaml: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), yaml, 'utf-8');
}

describe('portal — FULL live boundary (real fixtures, no mocking)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'portal-boundary-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `version: "6.0.0"\nquality:\n  max_direct_relations: 50\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Architecture: type `ui` may NOT call type `db` (default deny, no allow-list entry). */
  function writeArchitectureUiDb(): void {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      [
        'node_types:',
        '  ui:',
        "    description: 'ui layer'",
        '    log_required: false',
        '    when:',
        '      path: "src/ui/**"',
        '    relations:',
        '      calls: [ui]',
        '      default: deny',
        '  db:',
        "    description: 'db layer'",
        '    log_required: false',
        '    when:',
        '      path: "src/db/**"',
        '    relations:',
        '      default: allow',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('forbidden-type: a detected code edge the architecture matrix forbids by type', async () => {
    writeArchitectureUiDb();
    // ui/widget DECLARES the edge to db/store (so it is NOT a phantom), but the architecture
    // forbids a `ui` node calling a `db` node under ANY structural relation type → forbidden.
    writeNodeRaw(
      root,
      'widget',
      'name: Widget\ntype: ui\nrelations:\n  - target: store\n    type: calls\nmapping:\n  - src/ui/widget.ts\n',
    );
    writeNodeRaw(root, 'store', 'name: Store\ntype: db\nmapping:\n  - src/db/store.ts\n');
    w(root, 'src/ui/widget.ts', "import { query } from '../db/store.js';\nexport const w = () => query();\n");
    w(root, 'src/db/store.ts', 'export const query = () => 1;\n');

    const graph = await loadGraph(root);
    const boundary = await computePortalBoundary(graph, root);
    expect(boundary).not.toBeNull();
    expect(boundary!.forbiddenType).toContainEqual({ source: 'widget', target: 'store' });
    // It is declared, so it is NOT a phantom.
    expect(boundary!.phantom).not.toContainEqual({ source: 'widget', target: 'store' });
  });

  it('declared-only: a declared structural relation with no static code backing', async () => {
    // Same arch, but the dependency is DI/HTTP-style: declared, never statically called.
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      [
        'node_types:',
        '  svc:',
        "    description: 'service'",
        '    log_required: false',
        '    when:',
        '      path: "src/**"',
        '    relations:',
        '      calls: [svc]',
        '      default: allow',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeNodeRaw(
      root,
      'a',
      'name: A\ntype: svc\nrelations:\n  - target: b\n    type: calls\nmapping:\n  - src/a/a.ts\n',
    );
    writeNodeRaw(root, 'b', 'name: B\ntype: svc\nmapping:\n  - src/b/b.ts\n');
    // A declares calls→b but never imports it (no static code edge).
    w(root, 'src/a/a.ts', 'export const a = 1;\n');
    w(root, 'src/b/b.ts', 'export const b = 2;\n');

    const graph = await loadGraph(root);
    const boundary = await computePortalBoundary(graph, root);
    expect(boundary).not.toBeNull();
    expect(boundary!.declaredOnly).toContainEqual({ source: 'a', target: 'b' });
    expect(boundary!.phantom).toEqual([]);
    expect(boundary!.forbiddenType).toEqual([]);
  });

  it('phantom: a detected code edge with NO declared relation', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      [
        'node_types:',
        '  svc:',
        "    description: 'service'",
        '    log_required: false',
        '    when:',
        '      path: "src/**"',
        '    relations:',
        '      calls: [svc]',
        '      default: allow',
        '',
      ].join('\n'),
      'utf-8',
    );
    // A imports B but declares NO relation → phantom.
    writeNodeRaw(root, 'a', 'name: A\ntype: svc\nmapping:\n  - src/a/a.ts\n');
    writeNodeRaw(root, 'b', 'name: B\ntype: svc\nmapping:\n  - src/b/b.ts\n');
    w(root, 'src/a/a.ts', "import { b } from '../b/b.js';\nexport const a = () => b;\n");
    w(root, 'src/b/b.ts', 'export const b = 2;\n');

    const graph = await loadGraph(root);
    const boundary = await computePortalBoundary(graph, root);
    expect(boundary).not.toBeNull();
    expect(boundary!.phantom).toContainEqual({ source: 'a', target: 'b' });
    expect(boundary!.forbiddenType).toEqual([]);
  });

  it('clean: a declared, statically-backed, type-allowed edge is in NO boundary class', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      [
        'node_types:',
        '  svc:',
        "    description: 'service'",
        '    log_required: false',
        '    when:',
        '      path: "src/**"',
        '    relations:',
        '      calls: [svc]',
        '      default: allow',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeNodeRaw(
      root,
      'a',
      'name: A\ntype: svc\nrelations:\n  - target: b\n    type: calls\nmapping:\n  - src/a/a.ts\n',
    );
    writeNodeRaw(root, 'b', 'name: B\ntype: svc\nmapping:\n  - src/b/b.ts\n');
    w(root, 'src/a/a.ts', "import { b } from '../b/b.js';\nexport const a = () => b;\n");
    w(root, 'src/b/b.ts', 'export const b = 2;\n');

    const graph = await loadGraph(root);
    const boundary = await computePortalBoundary(graph, root);
    expect(boundary).not.toBeNull();
    expect(boundary!.phantom).toEqual([]);
    expect(boundary!.declaredOnly).toEqual([]);
    expect(boundary!.forbiddenType).toEqual([]);
  });
});
