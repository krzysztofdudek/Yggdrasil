import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live TypeScript relation pass.
//
// This suite drives the REAL pass — real `typescriptExtractor` (via
// `extractorForLanguage`) + the production `makeResolvePathToFile` resolver
// against files on disk — and asserts ZERO `relation-undeclared-dependency`
// for a battery of imports that must NEVER become a violation. There is no
// `yg-suppress` in any fixture here: silence must come from the extractor /
// resolver / verifier being correct, not from a waiver.
//
// If any case below produces a refusal, that is a real bug in the extractor,
// resolver, or verifier — not a test to relax.
// ---------------------------------------------------------------------------

function writeNode(root: string, nodeRel: string, name: string, mappings: string[]): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  const mapping = mappings.map((m) => `  - ${m}`).join('\n');
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n${mapping}\n`,
    'utf-8',
  );
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('relation TS anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-antifp-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });

    // Architecture: a single mapping-capable type 'service' covering everything.
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `version: "6.0.0"\nquality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );

    // Nodes. CRITICAL: node `a` declares NO relations at all. Every silence
    // below must therefore come from the extractor/resolver/verifier, never
    // from a declared edge. Directories are kept disjoint (no negation globs):
    //   a        → src/a/**       (no child files live under src/a)
    //   a/child  → src/child/**   (nodeId-descendant of `a`; separate dir)
    //   b        → src/b/**
    // src/unmapped/** is owned by NO node (the D7 coverage case). The
    // ancestor/descendant relationship for case (f) is by NODE ID (`a/child`
    // descends from `a`), not by directory nesting.
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/child/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);

    // --- target files (the things imports may point at) ---
    // mapped node b's file (whole-statement `import type` must NOT flag it)
    writeSrc(root, 'src/b/bar.ts', 'export interface T { v: number }\nexport const bar = 2;\n');
    // unmapped file (case a): exists on disk, owned by no node
    writeSrc(root, 'src/unmapped/target.ts', 'export const target = 1;\n');
    // ancestor (node a) file imported from descendant node `a/child` (case f)
    writeSrc(root, 'src/a/parent.ts', 'export const parent = 1;\n');
    // intra-node sibling (case e)
    writeSrc(root, 'src/a/intra2.ts', 'export const intra2 = 1;\n');
    // asset file that maps to no node (case g) — and is not a TS source ext
    writeSrc(root, 'src/a/style.css', '.x { color: red }\n');

    // --- import-bearing files under node `a` ---
    // (a) dependency onto an UNMAPPED file (D7): resolves to a real file, but
    //     no node owns it → coverage matter, never a violation.
    writeSrc(root, 'src/a/d7.ts', "import { target } from '../unmapped/target.js';\nexport const d7 = target;\n");
    // (b) bare / external import → never resolves to an in-graph node.
    writeSrc(root, 'src/a/ext.ts', "import { z } from 'zod';\nexport const ext = z;\n");
    // (c) whole-statement `import type` → carries no runtime edge; the
    //     extractor drops it even though it points at mapped node b.
    writeSrc(root, 'src/a/typeimp.ts', "import type { T } from '../b/bar.js';\nexport const typeimp: T | null = null;\n");
    // (d) dynamic import with a non-literal specifier → no static edge.
    writeSrc(root, 'src/a/dyn.ts', "const m = './intra2.js';\nexport async function load() { return import(m); }\n");
    // (e) intra-node import (same node a) → never crosses a boundary.
    writeSrc(root, 'src/a/intra1.ts', "import { intra2 } from './intra2.js';\nexport const intra1 = intra2;\n");
    // (g) asset import → '.css' is not a TS source ext and never resolves.
    writeSrc(root, 'src/a/styled.ts', "import './style.css';\nexport const styled = 1;\n");
    // (f) descendant node `a/child` importing an ANCESTOR node (`a`) file →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(root, 'src/child/grand.ts', "import { parent } from '../a/parent.js';\nexport const grand = parent;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits ZERO undeclared-dependency violations across every anti-FP case', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache'),
    });

    // Aggregate every violation across every node — the suite is airtight only
    // if the WHOLE graph is silent, so we never special-case a node.
    const allViolations = [...result.violationsByNode.values()].flatMap((v) => v.violations);
    expect(
      allViolations,
      `expected no undeclared-dependency violations, got: ${JSON.stringify(allViolations)}`,
    ).toHaveLength(0);

    // Every node with mapped source must carry an `approved` verdict.
    for (const nodeId of ['a', 'a/child', 'b']) {
      expect(result.violationsByNode.get(nodeId)?.verdict, `node ${nodeId}`).toBe('approved');
    }
  });

  // Per-case isolation: each case lives in its own file under node `a` (or its
  // descendant), so a regression in any single rule is pinpointed by name. We
  // assert node `a` (and its descendant for case f) stays approved with that
  // file's edge present — the same graph, sliced by which file drives the case.
  const cases: Array<{ name: string; node: string }> = [
    { name: '(a) dep onto an UNMAPPED file is a coverage matter, not a violation', node: 'a' },
    { name: '(b) bare/external import never resolves to an in-graph node', node: 'a' },
    { name: '(c) whole-statement `import type` carries no runtime edge', node: 'a' },
    { name: '(d) dynamic import of a variable has no static specifier', node: 'a' },
    { name: '(e) intra-node import never crosses a boundary', node: 'a' },
    { name: '(g) asset import never resolves to a TS source', node: 'a' },
    { name: '(f) descendant importing an ancestor node file is sanctioned', node: 'a/child' },
  ];
  for (const c of cases) {
    it(`anti-FP ${c.name}`, async () => {
      const graph = await loadGraph(root);
      const result = await runRelationPass(graph, root, {
        extractorFor: extractorForLanguage,
        resolvePathToFile: makeResolvePathToFile(root),
        symbolIndexDir: path.join(root, '.yg-cache'),
      });
      const v = result.violationsByNode.get(c.node);
      expect(v?.verdict, c.name).toBe('approved');
      expect(v?.violations, c.name).toHaveLength(0);
    });
  }
});
