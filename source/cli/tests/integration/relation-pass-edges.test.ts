import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';
import type { DependencyExtractor } from '../../src/relations/extractors/types.js';

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`, 'utf-8');
}
function writeNodeRaw(root: string, nodeRel: string, yaml: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), yaml, 'utf-8');
}
function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('relation pass — edge cases (live)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-edges-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n  bag:\n    description: 'organizational (no mapping)'\n    log_required: false\n`,
      'utf-8',
    );
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `version: "6.0.0"\nquality:\n  max_direct_relations: 10\n`, 'utf-8');
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('survives a no-language file and a non-parseable TS file (node still approved)', async () => {
    writeNode(root, 'a', 'A', 'src/a');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'README.unknownext'), 'not source\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'a', 'broken.ts'), 'const = = = ;;; @@@ <<<\n', 'utf-8');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache'),
    });
    expect(result.violationsByNode.get('a')!.verdict).toBe('approved');
  });

  it('skips a node with no mapping; refuses a node with three undeclared cross-node includes; cache re-run is byte-stable', async () => {
    writeNodeRaw(root, 'org', 'name: Org\ntype: bag\n');
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    writeNode(root, 'c', 'C', 'src/c');
    writeNode(root, 'd', 'D', 'src/d');
    w(root, 'src/a/main.c', '#include "../d/hd.h"\n#include "../b/hb.h"\n#include "../c/hc.h"\n');
    w(root, 'src/b/hb.h', '/* b */\n');
    w(root, 'src/c/hc.h', '/* c */\n');
    w(root, 'src/d/hd.h', '/* d */\n');
    w(root, 'src/c/zeta.ts', 'export const z = 1;\n');
    w(root, 'src/b/mid.ts', 'export const m = 1;\n');
    w(root, 'src/d/alpha.ts', 'export const a = 1;\n');

    const passDeps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-shared'),
    };
    const graph = await loadGraph(root);
    const first = await runRelationPass(graph, root, passDeps);

    expect(first.violationsByNode.has('org')).toBe(false); // no mapped files → no result
    const a = first.violationsByNode.get('a');
    expect(a?.verdict).toBe('refused');
    expect(a!.violations.length).toBe(3); // three undeclared cross-node includes

    // Re-run with the SAME speed cache dir: the persisted symbol index is loaded
    // from cache, and the live verdicts are identical.
    const graph2 = await loadGraph(root);
    const second = await runRelationPass(graph2, root, passDeps);
    expect(second.violationsByNode.get('a')!.verdict).toBe('refused');
    expect(second.violationsByNode.get('a')!.violations.length).toBe(3);
    expect(second.violationsByNode.get('b')!.verdict).toBe('approved');
  });

  it('skips a mapped file whose language has no extractor', async () => {
    writeNode(root, 'a', 'A', 'src/a');
    w(root, 'src/a/foo.ts', 'export const foo = 1;\n');
    w(root, 'src/a/bar.py', 'x = 1\n');
    const tsOnly = (language: string): DependencyExtractor | undefined =>
      language === 'typescript' ? extractorForLanguage('typescript') : undefined;
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: tsOnly,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-noext'),
    });
    expect(result.violationsByNode.get('a')!.verdict).toBe('approved');
  });

  // ── Additive read-only accessor: detectedEdgesByNode ──────────────────────
  //
  // detectedEdgesByNode is the FULL set of uniquely-resolved cross-node edges — the
  // SUPERSET of violationsByNode (the undeclared subset). It must include a DECLARED edge
  // (which is correctly absent from the verdict) AND every undeclared edge, while never
  // including a self / ancestor / descendant edge. The portal boundary's declared-only and
  // forbidden-type classes are joins over this set, so this is the contract they rely on.
  it('detectedEdgesByNode is the full superset (declared + undeclared), excluding self/lineage', async () => {
    // Node A depends (via three C includes) on B, C, and D. A DECLARES only the B edge.
    writeNodeRaw(root, 'a', 'name: A\ntype: service\nrelations:\n  - target: b\n    type: calls\nmapping:\n  - src/a\n');
    writeNode(root, 'b', 'B', 'src/b');
    writeNode(root, 'c', 'C', 'src/c');
    writeNode(root, 'd', 'D', 'src/d');
    w(root, 'src/a/main.c', '#include "../b/hb.h"\n#include "../c/hc.h"\n#include "../d/hd.h"\n');
    w(root, 'src/b/hb.h', '/* b */\n');
    w(root, 'src/c/hc.h', '/* c */\n');
    w(root, 'src/d/hd.h', '/* d */\n');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-detected'),
    });

    // detected = the FULL superset: B (declared) + C + D (undeclared).
    const detected = result.detectedEdgesByNode.get('a');
    expect(detected).toBeDefined();
    expect([...detected!].sort()).toEqual(['b', 'c', 'd']);

    // violations = only the UNDECLARED subset: C and D. The declared B edge is excluded.
    const a = result.violationsByNode.get('a');
    expect(a?.verdict).toBe('refused');
    const violationTargets = new Set(a!.violations.map((v) => v.ownerNode));
    expect(violationTargets.has('b')).toBe(false); // declared → not a violation
    expect(violationTargets.has('c')).toBe(true);
    expect(violationTargets.has('d')).toBe(true);

    // The set difference detected − violations is exactly the declared edge.
    const detectedSet = new Set(detected);
    const declaredOnly = [...detectedSet].filter((t) => !violationTargets.has(t));
    expect(declaredOnly).toEqual(['b']);

    // A node with no detected cross-node edge has no entry (B/C/D map only headers).
    expect(result.detectedEdgesByNode.has('b')).toBe(false);
  });

  it('refuses a node that depends on an owned-but-unenumerated (gitignored) header', async () => {
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    w(root, 'src/a/main.c', '#include "../b/helper.h"\n');
    w(root, 'src/b/helper.h', '/* helper */\n');
    w(root, '.gitignore', 'src/b/helper.h\n');
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-gi'),
    });
    const a = result.violationsByNode.get('a');
    expect(a?.verdict).toBe('refused');
    expect(a!.violations.some((v) => v.ownerNode === 'b')).toBe(true);
  });
});
