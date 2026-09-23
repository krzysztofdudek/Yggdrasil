import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live PHP relation pass.
//
// Drives the REAL pass — real `phpExtractor` (via `extractorForLanguage`) + the
// production `makeResolvePathToFile` resolver (composer.json PSR-4) against files
// on disk — and asserts ZERO `relation-undeclared-dependency` for a battery of
// imports/usages that must NEVER become a violation. No `yg-suppress` anywhere:
// silence must come from the extractor / resolver / verifier being correct, not
// from a waiver.
//
// PSR-4: App\ → src/. Nodes map directories under src/:
//   a        → src/A/**       (importing files; declares NO relations)
//   a/child  → src/Child/**   (nodeId-descendant of `a`; separate dir/namespace)
//   b        → src/B/**        (a mapped node — the only legit cross edge,
//                               deliberately never depended on)
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

describe('relation PHP anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-php-antifp-'));
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
    // composer.json PSR-4: App\ → src/. The single source of namespace→path truth.
    writeFileSync(
      path.join(root, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
      'utf-8',
    );

    // Nodes. CRITICAL: node `a` declares NO relations. Every silence below must
    // come from the extractor/resolver/verifier, never from a declared edge.
    writeNode(root, 'a', 'A', ['src/A/**']);
    writeNode(root, 'a/child', 'AChild', ['src/Child/**']);
    writeNode(root, 'b', 'B', ['src/B/**']);

    // --- target files ---
    // ancestor (node a) file + intra-node sibling
    writeSrc(root, 'src/A/Parent.php', '<?php\nnamespace App\\A;\nclass Parent_ {}\n');
    writeSrc(root, 'src/A/Intra2.php', '<?php\nnamespace App\\A;\nclass Intra2 {}\n');
    // mapped node b (never depended on here)
    writeSrc(root, 'src/B/Bar.php', '<?php\nnamespace App\\B;\nclass Bar {}\n');
    // unmapped .php file (D7): exists on disk + resolvable via PSR-4, owned by no node.
    writeSrc(
      root,
      'src/Unmapped/Target.php',
      '<?php\nnamespace App\\Unmapped;\nclass Target {}\n',
    );

    // --- import-bearing files under node `a` ---
    // (a) vendor / external import → namespace not in PSR-4 map → resolves to NO file.
    writeSrc(
      root,
      'src/A/Ext.php',
      [
        '<?php',
        'namespace App\\A;',
        'use Psr\\Log\\LoggerInterface;',
        'use Symfony\\Component\\HttpFoundation\\Request;',
        'class Ext {}',
        '',
      ].join('\n'),
    );
    // (b) dependency onto an UNMAPPED .php file (D7): the FQN resolves to a real
    //     file, but no node owns it → coverage matter, never a violation.
    writeSrc(
      root,
      'src/A/D7.php',
      '<?php\nnamespace App\\A;\nuse App\\Unmapped\\Target;\nclass D7 {}\n',
    );
    // (c) dynamic instantiation: `$class = 'App\\B\\Bar'; new $class();` is a
    //     variable_name in the class position, NOT a use-declaration → not detected.
    writeSrc(
      root,
      'src/A/Dyn.php',
      [
        '<?php',
        'namespace App\\A;',
        'class Dyn {',
        '  function m() {',
        "    $class = 'App\\\\B\\\\Bar';",
        '    $o = new $class();',
        '    return $o;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // (d) intra-node import (same node a) → never crosses a boundary.
    writeSrc(
      root,
      'src/A/Intra1.php',
      '<?php\nnamespace App\\A;\nuse App\\A\\Intra2;\nclass Intra1 {}\n',
    );

    // (e) descendant node `a/child` importing an ANCESTOR node (`a`) file →
    //     sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(
      root,
      'src/Child/Grand.php',
      '<?php\nnamespace App\\Child;\nuse App\\A\\Parent_;\nclass Grand {}\n',
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
    { name: '(a) vendor/external import resolves to no PSR-4 file', node: 'a' },
    { name: '(b) dep onto an UNMAPPED .php file is a coverage matter, not a violation', node: 'a' },
    { name: '(c) dynamic `new $class()` is a variable, not a use-declaration', node: 'a' },
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
