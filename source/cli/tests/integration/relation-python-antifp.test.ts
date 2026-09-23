import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live PYTHON relation pass.
//
// Drives the REAL pass — real `pythonExtractor` (via `extractorForLanguage`) +
// the production `makeResolvePathToFile` resolver against files on disk — and
// asserts ZERO `relation-undeclared-dependency` for a battery of imports that
// must NEVER become a violation. No `yg-suppress` anywhere: silence must come
// from the extractor / resolver / verifier being correct, not from a waiver.
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

describe('relation Python anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-py-antifp-'));
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
    //   a        → src/a/**      (importing files)
    //   a/child  → src/child/**  (nodeId-descendant of `a`; separate dir)
    //   b        → src/b/**      (a mapped node — the only legitimate cross edge,
    //                             which we deliberately never depend on here)
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/child/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);

    // --- target files ---
    writeSrc(root, 'src/a/__init__.py', '');
    writeSrc(root, 'src/a/parent.py', 'PARENT = 1\n'); // ancestor (node a) file
    writeSrc(root, 'src/a/intra2.py', 'INTRA2 = 1\n'); // intra-node sibling
    writeSrc(root, 'src/b/bar.py', 'BAR = 2\n'); // mapped node b (never depended on)
    // unmapped .py file (D7): exists on disk, owned by no node.
    writeSrc(root, 'src/unmapped/target.py', 'TARGET = 1\n');
    writeSrc(root, 'src/unmapped/__init__.py', '');

    // --- import-bearing files under node `a` ---
    // (a) stdlib / third-party imports → resolve to NO mapped file.
    writeSrc(root, 'src/a/ext.py', 'import os\nimport requests\nVAL = os.getpid()\n');
    // (b) dependency onto an UNMAPPED file (D7): the module resolves to a real
    //     file, but no node owns it → coverage matter, never a violation.
    //     `unmapped.target` resolves from the repo root to src/unmapped/target.py
    //     ONLY if src/ is a source root — but src/unmapped IS unmapped, so even a
    //     hit there is owned by no node. We import it as a top-level package.
    writeSrc(root, 'src/a/d7.py', 'from unmapped import target\nVAL = target.TARGET\n');
    // (c) importlib dynamic import → a `call`, not an import_statement → not
    //     detected by the extractor at all.
    writeSrc(
      root,
      'src/a/dyn.py',
      'import importlib\nmod = importlib.import_module("b.bar")\nVAL = mod\n',
    );
    // (d) `from __future__` → distinct future_import_statement node → skipped.
    writeSrc(root, 'src/a/fut.py', 'from __future__ import annotations\nVAL = 1\n');
    // (e) intra-node import (same node a) → never crosses a boundary.
    writeSrc(root, 'src/a/intra1.py', 'from a.intra2 import INTRA2\nVAL = INTRA2\n');

    // (f) descendant node `a/child` importing an ANCESTOR node (`a`) file →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(root, 'src/child/grand.py', 'from a.parent import PARENT\nVAL = PARENT\n');
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
    { name: '(b) dep onto an UNMAPPED .py file is a coverage matter, not a violation', node: 'a' },
    { name: '(c) importlib.import_module is a call, not an import_statement', node: 'a' },
    { name: '(d) from __future__ import is skipped by construction', node: 'a' },
    { name: '(e) intra-node import never crosses a boundary', node: 'a' },
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
