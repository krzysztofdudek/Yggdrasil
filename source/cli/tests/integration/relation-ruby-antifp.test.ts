import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live RUBY relation pass — the LAST and
// honestly LOWEST-detectability language. Ruby uses BOTH require_relative PATH
// hints and constant SYMBOL hints, but class/module reopening makes most
// constants ambiguous → silenced.
//
// Drives the REAL pass — real `rubyExtractor` (via `extractorForLanguage`) and
// the production `makeResolvePathToFile` (the `ruby` branch resolves
// require_relative; constants route through the SymbolTable) — and asserts ZERO
// `relation-undeclared-dependency` for a battery of cases that must NEVER become
// a violation. No `yg-suppress` anywhere: silence must come from the
// extractor / symbol table / verifier being correct, not from a waiver.
//
//   a        → src/a/**       (importing files; declares NO relations)
//   a/child  → src/childpkg/** (nodeId-descendant of `a`)
//   b        → src/b/**        (a mapped node — the only legit cross edge, never used)
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

describe('relation Ruby anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-ruby-antifp-'));
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
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/childpkg/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);

    // --- target files ---
    // ancestor (node a) constant + intra-node sibling.
    writeSrc(root, 'src/a/parent.rb', 'class Parent\nend\n');
    writeSrc(root, 'src/a/intra2.rb', 'class Intra2\nend\n');
    // mapped node b (never depended on here).
    writeSrc(root, 'src/b/bar.rb', 'class Bar\nend\n');
    // UNMAPPED .rb file (D7): exists on disk, owned by no node.
    writeSrc(root, 'src/unmapped/target.rb', 'class Target\nend\n');
    // AMBIGUOUS constant via REOPENING: two in-graph files (different nodes) define Thing.
    writeSrc(root, 'src/b/thing.rb', 'class Thing\nend\n');
    writeSrc(root, 'src/childpkg/thing.rb', 'class Thing\nend\n');

    // --- dependency-bearing files under node `a` ---
    // (a) gem `require` (NOT require_relative) → the extractor never emits a path hint.
    writeSrc(
      root,
      'src/a/ext.rb',
      ["require 'json'", "require 'active_record'", "require 'order/processor'", 'class Ext\nend', ''].join('\n'),
    );
    // (b) Zeitwerk/Rails autoload: a constant used with NO require, defined elsewhere. The
    //     constant is AMBIGUOUS (Thing has 2 defs) → SymbolTable cannot resolve → silence.
    writeSrc(root, 'src/a/autoload.rb', 'class Autoload\n  def run\n    Thing.new\n  end\nend\n');
    // (c) const_get / send metaprogramming: the target is a dynamic STRING, never a
    //     `constant` node → not detected at all.
    writeSrc(
      root,
      'src/a/dyn.rb',
      ['class Dyn', '  def run', "    Object.const_get('Bar')", "    obj.send(:charge)", '  end', 'end', ''].join('\n'),
    );
    // (d) monkey-patching / reopening: reopening Thing across files makes it ambiguous;
    //     a reopen here adds another def of an in-graph constant → still silenced on use.
    writeSrc(root, 'src/a/reopen.rb', 'class Thing\n  def patched; end\nend\n');
    // (e) dep onto an UNMAPPED file via require_relative (D7): resolves to a real file,
    //     but no node owns it → coverage matter, never a violation.
    writeSrc(root, 'src/a/d7.rb', "require_relative '../unmapped/target'\nclass D7\nend\n");
    // (f) intra-node dependency (same node a): uses Intra2, a sibling in node a.
    writeSrc(root, 'src/a/intra1.rb', "require_relative './intra2'\nx = Intra2\nclass Intra1\nend\n");
    // (g) descendant node `a/child` depending on an ANCESTOR node (`a`) constant →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(root, 'src/childpkg/grand.rb', 'class Grand < Parent\nend\n');
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
    { name: '(a) gem `require` (not require_relative) emits no path hint', node: 'a' },
    { name: '(b) Zeitwerk autoload of an ambiguous constant resolves to undefined', node: 'a' },
    { name: '(c) const_get/send metaprogramming targets a string, not a constant', node: 'a' },
    { name: '(d) monkey-patch/reopening keeps the constant ambiguous → silence', node: 'a' },
    { name: '(e) dep onto an UNMAPPED file is a coverage matter, not a violation', node: 'a' },
    { name: '(f) intra-node dependency never crosses a boundary', node: 'a' },
    { name: '(g) descendant depending on an ancestor node constant is sanctioned', node: 'a/child' },
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

// ---------------------------------------------------------------------------
// Containment: one Ruby file that traps the grammar's scanner (a heredoc delimiter of
// 256+ characters on tree-sitter-ruby 0.23.1) used to poison the cached parser, so every
// later Ruby file failed too and the real edges were never computed. And the
// extension-less Ruby files (Rakefile) are parsed like any `.rb` file.
// ---------------------------------------------------------------------------
describe('relation Ruby pass — one pathological file fails alone; Rakefile is Ruby', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-ruby-contain-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `version: "6.0.0"\n`, 'utf-8');
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);
    const delimiter = 'A'.repeat(256);
    writeSrc(root, 'src/a/aa_first.rb', `x = <<~${delimiter}\nhello\n${delimiter}\n`);
    writeSrc(root, 'src/a/zz_use.rb', 'y = Flag\n');
    writeSrc(root, 'src/a/Rakefile', 'require_relative "../b/flag"\n');
    writeSrc(root, 'src/b/flag.rb', 'class Flag\nend\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the edges of every other Ruby file and parses the Rakefile', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache'),
    });
    const rows = (result.violationsByNode.get('a')?.violations ?? []).map((v) => `${v.fromFile}:${v.line}->${v.ownerNode}`);
    expect(rows).toContain('src/a/zz_use.rb:1->b');
    expect(rows).toContain('src/a/Rakefile:1->b');
    // Only the pathological file itself may fail (it parses once the grammar carries the
    // upstream scanner fix).
    for (const failure of result.parseFailures) {
      expect(failure.fileCount).toBe(1);
      expect(failure.examplePath).toBe('src/a/aa_first.rb');
    }
  });
});
