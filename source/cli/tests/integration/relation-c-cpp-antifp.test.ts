import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// D8 (no-waiver) soundness gate for the live C + C++ relation pass.
//
// Drives the REAL pass — real `cExtractor`/`cppExtractor` (via
// `extractorForLanguage`) + the production `makeResolvePathToFile` resolver
// (shared quoted-#include resolution, disk-backed existence) — and asserts ZERO
// `relation-undeclared-dependency` for a battery of C/C++ #includes that must
// NEVER become a violation. No `yg-suppress` anywhere: silence must come from the
// extractor / resolver / verifier being correct, not a waiver.
//
// C/C++ have no module system: the ONLY edge is a QUOTED `#include "header.h"`,
// resolved relative to the includer (then common include roots) to a HEADER file
// whose owning node is the dependency target. Angle includes (<system.h>) and
// includes to unmapped/ancestor/intra-node headers must all be silent.
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

describe('relation C/C++ anti-false-positive (D8 soundness gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-c-cpp-antifp-'));
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

    // Nodes. CRITICAL: node `a` declares NO relations. Every silence below must come
    // from the extractor/resolver/verifier, never from a declared edge.
    //   a        → src/a/**       (importing files + node a's own header/impl)
    //   a/child  → src/child/**   (nodeId-descendant of `a`; separate dir)
    //   b        → src/b/**       (a mapped node — the only legitimate cross edge,
    //                              deliberately never depended on here)
    writeNode(root, 'a', 'A', ['src/a/**']);
    writeNode(root, 'a/child', 'AChild', ['src/child/**']);
    writeNode(root, 'b', 'B', ['src/b/**']);

    // --- target / owned header files ---
    // node a's own header + impl (header/impl pair in the SAME node).
    writeSrc(root, 'src/a/widget.h', '#pragma once\nint widget(void);\n');
    writeSrc(root, 'src/a/widget.c', '#include "widget.h"\nint widget(void) { return 1; }\n');
    // node a's parent-level header (ancestor of node a/child) — for the ancestor case.
    writeSrc(root, 'src/a/parent.h', '#pragma once\nint parent(void);\n');
    // mapped node b's header (never depended on here).
    writeSrc(root, 'src/b/bar.h', '#pragma once\nint bar(void);\n');
    // UNMAPPED header (D7): a real file owned by no node.
    writeSrc(root, 'src/unmapped/util.h', '#pragma once\nint util(void);\n');

    // --- import-bearing files under node `a` ---
    // (sys) C file with only a system <...> include → never reaches the resolver.
    writeSrc(root, 'src/a/sys.c', '#include <stdio.h>\nvoid s(void) { (void)printf; }\n');
    // (sys-cpp) C++ file with a system <...> include → never reaches the resolver.
    writeSrc(root, 'src/a/sys.cpp', '#include <vector>\nvoid sv() {}\n');
    // (unmapped) quoted include to a header owned by NO node (D7) → coverage matter.
    writeSrc(root, 'src/a/uses_unmapped.c', '#include "../unmapped/util.h"\nint uu(void) { return util(); }\n');
    // (intra) intra-node quoted include (impl includes its own node's header).
    //   src/a/widget.c above already does this; add a second intra include for clarity.
    writeSrc(root, 'src/a/intra.cpp', '#include "widget.h"\nvoid iu() { (void)widget(); }\n');
    // (header/impl) a .cpp including a sibling .hpp in the SAME node a.
    writeSrc(root, 'src/a/gadget.hpp', '#pragma once\nvoid gadget();\n');
    writeSrc(root, 'src/a/gadget.cpp', '#include "gadget.hpp"\nvoid gadget() {}\n');

    // (ancestor) descendant node a/child including an ANCESTOR node (a) header →
    //   sanctioned by the ancestor/descendant rule, never a violation.
    writeSrc(root, 'src/child/grand.c', '#include "../a/parent.h"\nint g(void) { return parent(); }\n');
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
    { name: '(sys) a <system> include never reaches the resolver', node: 'a' },
    { name: '(unmapped) quoted include to an unmapped header is a coverage matter', node: 'a' },
    { name: '(intra) intra-node include never crosses a boundary', node: 'a' },
    { name: '(header/impl) a header/impl pair in the same node is intra-node', node: 'a' },
    { name: '(ancestor) descendant including an ancestor node header is sanctioned', node: 'a/child' },
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
