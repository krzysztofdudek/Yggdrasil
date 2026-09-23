import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live GO relation pass.
//
// Drives the REAL pass — real `goExtractor` (via `extractorForLanguage`) + the
// production `makeResolvePathToFile` resolver (disk-backed go.mod + readdir) —
// and asserts ZERO `relation-undeclared-dependency` for a battery of Go imports
// that must NEVER become a violation. No `yg-suppress` anywhere: silence must
// come from the extractor / resolver / verifier being correct, not a waiver.
//
// Module path is `example.com/m`. A Go import resolves to a package DIRECTORY;
// the resolver maps it to a representative `.go` file, then the owner index maps
// that file to a node. An import not under the module path resolves to nothing.
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

describe('relation Go anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-go-antifp-'));
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

    // go.mod at the repo root → module path `example.com/m`.
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');

    // Nodes. CRITICAL: node `a` declares NO relations. Every silence below must
    // come from the extractor/resolver/verifier, never from a declared edge.
    //   a        → src/a/**       (importing files; whole package subtree)
    //   a/child  → src/child/**   (nodeId-descendant of `a`; separate dir)
    //   b        → src/b/**       (a mapped node — the only legitimate cross edge,
    //                              which we deliberately never depend on here)
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/child/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);

    // --- target package directories ---
    // mapped node a's "parent" package (ancestor of node a/child) — case (e2).
    writeSrc(root, 'src/a/parent.go', 'package a\n\nconst Parent = 1\n');
    // intra-node sub-package under node a — case (e1).
    writeSrc(root, 'src/a/intra/intra.go', 'package intra\n\nconst Intra = 1\n');
    // mapped node b's package (never depended on here).
    writeSrc(root, 'src/b/bar.go', 'package b\n\nconst Bar = 2\n');
    // UNMAPPED in-module package (D7): a real directory under the module, owned by
    // no node. An import to it resolves to a real .go file but no node owns it.
    writeSrc(root, 'src/unmapped/u.go', 'package unmapped\n\nconst U = 1\n');

    // --- import-bearing files under node `a` ---
    // (a) stdlib import → not under the module path → resolves to NO file.
    writeSrc(
      root,
      'src/a/std.go',
      'package a\n\nimport (\n  "fmt"\n  "os"\n)\n\nfunc useStd() { fmt.Println(os.Getpid()) }\n',
    );
    // (b) external-module import → not under the module path → resolves to nothing.
    writeSrc(
      root,
      'src/a/ext.go',
      'package a\n\nimport "github.com/gorilla/mux"\n\nvar _ = mux.NewRouter\n',
    );
    // (c) dep onto an UNMAPPED in-module package (D7): resolves to a real file,
    //     but no node owns it → coverage matter, never a violation.
    writeSrc(
      root,
      'src/a/d7.go',
      'package a\n\nimport "example.com/m/src/unmapped"\n\nvar _ = unmapped.U\n',
    );
    // (e1) intra-node import (sub-package owned by the SAME node a) → never a boundary.
    writeSrc(
      root,
      'src/a/intra_user.go',
      'package a\n\nimport "example.com/m/src/a/intra"\n\nvar _ = intra.Intra\n',
    );

    // (e2) descendant node `a/child` importing an ANCESTOR node (`a`) package →
    //      sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(
      root,
      'src/child/grand.go',
      'package child\n\nimport "example.com/m/src/a"\n\nvar _ = a.Parent\n',
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
    { name: '(a) stdlib import resolves to no mapped file', node: 'a' },
    { name: '(b) external-module import resolves to no in-graph node', node: 'a' },
    { name: '(c) dep onto an UNMAPPED in-module package is a coverage matter', node: 'a' },
    { name: '(e1) intra-node sub-package import never crosses a boundary', node: 'a' },
    { name: '(e2) descendant importing an ancestor node package is sanctioned', node: 'a/child' },
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
