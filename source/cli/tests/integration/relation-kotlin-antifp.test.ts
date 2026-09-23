import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live KOTLIN relation pass — the FIRST
// language resolving through the shared SymbolTable, not a path mapping.
//
// Drives the REAL pass — real `kotlinExtractor` (via `extractorForLanguage`) and
// the production `makeResolvePathToFile` (which returns undefined for kotlin, so
// every resolution happens through the SymbolTable) against files on disk — and
// asserts ZERO `relation-undeclared-dependency` for a battery of imports that must
// NEVER become a violation. No `yg-suppress` anywhere: silence must come from the
// extractor / symbol table / verifier being correct, not from a waiver.
//
// Kotlin's package is DECOUPLED from the directory, so the layout intentionally
// places packages in directories that do NOT mirror them.
//   a        → src/featA/**   (importing files; declares NO relations)
//   a/child  → src/childC/**  (nodeId-descendant of `a`)
//   b        → src/featB/**   (a mapped node — the only legit cross edge, never used)
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

describe('relation Kotlin anti-false-positive (D8 soundness gate, symbol-table)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-kotlin-antifp-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });

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

    // Nodes. CRITICAL: node `a` declares NO relations. Every silence below must
    // come from the extractor/symbol-table/verifier, never from a declared edge.
    writeNode(root, 'a', 'A', ['src/featA/**']);
    writeNode(root, 'a/child', 'AChild', ['src/childC/**']);
    writeNode(root, 'b', 'B', ['src/featB/**']);

    // --- target files (note: directory != package, the Kotlin difference) ---
    // ancestor (node a) file + intra-node sibling, both in package com.a.
    writeSrc(root, 'src/featA/Parent.kt', 'package com.a\nclass Parent\n');
    writeSrc(root, 'src/featA/Intra2.kt', 'package com.a\nclass Intra2\n');
    // mapped node b (never depended on here) — package com.b.
    writeSrc(root, 'src/featB/Bar.kt', 'package com.b\nclass Bar\n');
    // unmapped .kt file (D7): exists on disk, owned by no node.
    writeSrc(root, 'src/unmapped/Target.kt', 'package com.unmapped\nclass Target\n');
    // AMBIGUOUS FQN: two in-graph files (different nodes) declare com.dup.Thing.
    writeSrc(root, 'src/featB/Thing.kt', 'package com.dup\nclass Thing\n');
    writeSrc(root, 'src/childC/Thing.kt', 'package com.dup\nclass Thing\n');

    // --- import-bearing files under node `a` ---
    // (a) stdlib / third-party imports → resolve to NO mapped file (no in-graph
    //     file declares these FQNs).
    writeSrc(
      root,
      'src/featA/Ext.kt',
      [
        'package com.a',
        'import kotlin.collections.List',
        'import java.util.ArrayList',
        'import kotlinx.coroutines.flow.Flow',
        'class Ext',
        '',
      ].join('\n'),
    );
    // (b) dependency onto an UNMAPPED .kt file (D7): the FQN resolves to a real
    //     declaring file, but no node owns it → coverage matter, never a violation.
    writeSrc(
      root,
      'src/featA/D7.kt',
      'package com.a\nimport com.unmapped.Target\nclass D7\n',
    );
    // (c) reflection / dynamic: Class.forName("com.b.Bar") is a string literal, NOT
    //     an import → not detected by the extractor at all.
    writeSrc(
      root,
      'src/featA/Dyn.kt',
      [
        'package com.a',
        'class Dyn {',
        '  fun m() {',
        '    Class.forName("com.b.Bar")',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // (d) intra-node import (same node a) → never crosses a boundary.
    writeSrc(
      root,
      'src/featA/Intra1.kt',
      'package com.a\nimport com.a.Intra2\nclass Intra1\n',
    );
    // (e) descendant node `a/child` importing an ANCESTOR node (`a`) file →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(
      root,
      'src/childC/Grand.kt',
      'package com.child\nimport com.a.Parent\nclass Grand\n',
    );
    // (f) use of an AMBIGUOUS FQN (com.dup.Thing, declared by two files) → the
    //     SymbolTable cannot resolve it uniquely → silence, never a violation.
    writeSrc(
      root,
      'src/featA/Amb.kt',
      'package com.a\nimport com.dup.Thing\nclass Amb\n',
    );
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

    const allViolations = [...result.violationsByNode.values()].flatMap((v) => v.violations);
    expect(
      allViolations,
      `expected no undeclared-dependency violations, got: ${JSON.stringify(allViolations)}`,
    ).toHaveLength(0);

    for (const nodeId of ['a', 'a/child', 'b']) {
      expect(result.violationsByNode.get(nodeId)?.verdict, `node ${nodeId}`).toBe('approved');
    }
  });

  const cases: Array<{ name: string; node: string }> = [
    { name: '(a) stdlib/third-party import resolves to no mapped file', node: 'a' },
    { name: '(b) dep onto an UNMAPPED .kt file is a coverage matter, not a violation', node: 'a' },
    { name: '(c) Class.forName reflection is a string, not an import', node: 'a' },
    { name: '(d) intra-node import never crosses a boundary', node: 'a' },
    { name: '(e) descendant importing an ancestor node file is sanctioned', node: 'a/child' },
    { name: '(f) use of an ambiguous FQN resolves to undefined (silence)', node: 'a' },
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
