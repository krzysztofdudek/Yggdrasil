import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live JAVA relation pass.
//
// Drives the REAL pass — real `javaExtractor` (via `extractorForLanguage`) + the
// production `makeResolvePathToFile` resolver against files on disk — and asserts
// ZERO `relation-undeclared-dependency` for a battery of imports that must NEVER
// become a violation. No `yg-suppress` anywhere: silence must come from the
// extractor / resolver / verifier being correct, not from a waiver.
//
// Layout: Java sources live under src/main/java/<pkg-path>. Nodes map directories:
//   a        → src/main/java/com/a/**       (importing files; declares NO relations)
//   a/child  → src/main/java/com/child/**   (nodeId-descendant of `a`; separate dir)
//   b        → src/main/java/com/b/**        (a mapped node — the only legit cross
//                                             edge, deliberately never depended on)
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

describe('relation Java anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-java-antifp-'));
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
    // come from the extractor/resolver/verifier, never from a declared edge.
    writeNode(root, 'a', 'A', ['src/main/java/com/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/main/java/com/child/**']);
    writeNode(root, 'b', 'B', ['src/main/java/com/b/**']);

    // --- target files ---
    // ancestor (node a) file + intra-node sibling
    writeSrc(
      root,
      'src/main/java/com/a/Parent.java',
      'package com.a;\npublic class Parent {}\n',
    );
    writeSrc(
      root,
      'src/main/java/com/a/Intra2.java',
      'package com.a;\npublic class Intra2 {}\n',
    );
    // mapped node b (never depended on here)
    writeSrc(
      root,
      'src/main/java/com/b/Bar.java',
      'package com.b;\npublic class Bar {}\n',
    );
    // unmapped .java file (D7): exists on disk, owned by no node.
    writeSrc(
      root,
      'src/main/java/com/unmapped/Target.java',
      'package com.unmapped;\npublic class Target {}\n',
    );

    // --- import-bearing files under node `a` ---
    // (a) JDK / third-party imports → resolve to NO mapped file.
    writeSrc(
      root,
      'src/main/java/com/a/Ext.java',
      [
        'package com.a;',
        'import java.util.List;',
        'import javax.annotation.Nullable;',
        'import com.google.common.collect.ImmutableList;',
        'public class Ext {}',
        '',
      ].join('\n'),
    );
    // (b) dependency onto an UNMAPPED .java file (D7): the FQN resolves to a real
    //     file, but no node owns it → coverage matter, never a violation.
    writeSrc(
      root,
      'src/main/java/com/a/D7.java',
      'package com.a;\nimport com.unmapped.Target;\npublic class D7 {}\n',
    );
    // (c) reflection: Class.forName("com.b.Bar") is a string literal, NOT an
    //     import_declaration → not detected by the extractor at all.
    writeSrc(
      root,
      'src/main/java/com/a/Dyn.java',
      [
        'package com.a;',
        'public class Dyn {',
        '  void m() throws Exception {',
        '    Class.forName("com.b.Bar");',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // (d) intra-node import (same node a) → never crosses a boundary.
    writeSrc(
      root,
      'src/main/java/com/a/Intra1.java',
      'package com.a;\nimport com.a.Intra2;\npublic class Intra1 {}\n',
    );

    // (e) descendant node `a/child` importing an ANCESTOR node (`a`) file →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(
      root,
      'src/main/java/com/child/Grand.java',
      'package com.child;\nimport com.a.Parent;\npublic class Grand {}\n',
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
    { name: '(a) JDK/third-party import resolves to no mapped file', node: 'a' },
    { name: '(b) dep onto an UNMAPPED .java file is a coverage matter, not a violation', node: 'a' },
    { name: '(c) Class.forName reflection is a string, not an import_declaration', node: 'a' },
    { name: '(d) intra-node import never crosses a boundary', node: 'a' },
    { name: '(e) descendant importing an ancestor node file is sanctioned', node: 'a/child' },
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
