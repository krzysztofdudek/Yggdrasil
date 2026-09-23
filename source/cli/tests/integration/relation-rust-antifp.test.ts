import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live RUST relation pass.
//
// Drives the REAL pass — real `rustExtractor` (via `extractorForLanguage`) + the
// production `makeResolvePathToFile` resolver (disk-backed Cargo.toml + crate
// module-tree existence) — and asserts ZERO `relation-undeclared-dependency` for a
// battery of Rust `use` imports that must NEVER become a violation. No
// `yg-suppress` anywhere: silence must come from the extractor / resolver /
// verifier being correct, not a waiver.
//
// The crate is named `mycrate` with `src/` as the module-tree root. A Rust path
// resolves to a `.rs` FILE through the module tree; the owner index maps that file
// to a node. A path rooted at an external crate (std/serde/…) resolves to nothing.
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

describe('relation Rust anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-rust-antifp-'));
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

    // Cargo.toml at the repo root → crate `mycrate`, src/ is the module-tree root.
    writeFileSync(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "mycrate"\nversion = "0.1.0"\nedition = "2021"\n',
      'utf-8',
    );

    // Nodes. CRITICAL: node `a` declares NO relations. Every silence below must come
    // from the extractor/resolver/verifier, never from a declared edge.
    //   a        → src/a.rs + src/a/**   (module crate::a and its submodules)
    //   a/child  → src/child/**          (nodeId-descendant of `a`; separate dir)
    //   b        → src/b/**              (a mapped node — the only legitimate cross
    //                                      edge, which we deliberately never depend on)
    writeNode(root, 'a', 'A', ['src/a.rs', 'src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/child/**']);
    writeNode(root, 'b', 'B', ['src/b/mod.rs', 'src/b/**']);

    // --- crate entry + target module files ---
    writeSrc(root, 'src/lib.rs', 'pub mod a;\npub mod b;\npub mod child;\npub mod unmapped;\n');
    // module crate::a (node a's "parent" file — ancestor of node a/child).
    writeSrc(root, 'src/a.rs', 'pub mod intra;\npub const PARENT: u32 = 1;\n');
    // intra-node submodule under node a — crate::a::intra.
    writeSrc(root, 'src/a/intra.rs', 'pub const INTRA: u32 = 1;\n');
    // mapped node b's module (never depended on here).
    writeSrc(root, 'src/b/mod.rs', 'pub const BAR: u32 = 2;\n');
    // UNMAPPED in-crate module (D7): a real module file owned by no node.
    writeSrc(root, 'src/unmapped.rs', 'pub const U: u32 = 1;\n');

    // --- import-bearing files under node `a` ---
    // (a) stdlib import → external crate root → resolves to NO file.
    writeSrc(
      root,
      'src/a/std_user.rs',
      'use std::collections::HashMap;\npub fn f() -> HashMap<u32, u32> { HashMap::new() }\n',
    );
    // (b) external third-party crate import (serde) → resolves to nothing.
    writeSrc(root, 'src/a/ext_user.rs', 'use serde::Serialize;\n#[allow(unused)]\nfn g<T: Serialize>(_: T) {}\n');
    // (c) dep onto an UNMAPPED in-crate module (D7): resolves to a real file, but no
    //     node owns it → coverage matter, never a violation.
    writeSrc(root, 'src/a/d7.rs', 'use crate::unmapped::U;\npub const X: u32 = U;\n');
    // (d) macro-generated dep: a path inside a macro invocation is unparsed tokens →
    //     no use_declaration → never flagged.
    writeSrc(
      root,
      'src/a/macro_user.rs',
      'pub fn p() {\n  println!("{}", crate::b::BAR);\n}\n',
    );
    // (e1) intra-node import (submodule owned by the SAME node a) → never a boundary.
    writeSrc(root, 'src/a/intra_user.rs', 'use crate::a::intra::INTRA;\npub const Y: u32 = INTRA;\n');

    // (e2) descendant node `a/child` importing an ANCESTOR node (`a`) module →
    //      sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(root, 'src/child/grand.rs', 'use crate::a::PARENT;\npub const Z: u32 = PARENT;\n');
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
    { name: '(b) external-crate import resolves to no in-graph node', node: 'a' },
    { name: '(c) dep onto an UNMAPPED in-crate module is a coverage matter', node: 'a' },
    { name: '(d) macro-generated path is never a use → never flagged', node: 'a' },
    { name: '(e1) intra-node submodule import never crosses a boundary', node: 'a' },
    { name: '(e2) descendant importing an ancestor node module is sanctioned', node: 'a/child' },
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
