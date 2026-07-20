import { describe, it, expect } from 'vitest';
import { runExtractor } from './extractors/_harness.js';
import { makeResolver } from '../../../src/relations/resolver.js';
import { SymbolTable } from '../../../src/relations/symbol-table.js';
import type { OwnerIndex } from '../../../src/relations/owner-index.js';
import type { DependencyExtractor } from '../../../src/relations/extractors/types.js';
import type { ResolvedDep } from '../../../src/relations/verifier.js';
import { typescriptExtractor } from '../../../src/relations/extractors/typescript.js';
import { pythonExtractor } from '../../../src/relations/extractors/python.js';
import { goExtractor } from '../../../src/relations/extractors/go.js';
import { javaExtractor } from '../../../src/relations/extractors/java.js';
import { phpExtractor } from '../../../src/relations/extractors/php.js';
import { rustExtractor } from '../../../src/relations/extractors/rust.js';
import { cExtractor } from '../../../src/relations/extractors/c.js';
import { cppExtractor } from '../../../src/relations/extractors/cpp.js';

/**
 * Candidate-group parity (Stage 1 of the unified name-resolution mechanism).
 *
 * The shape change makes each detected reference carry an ORDERED `candidates: TargetHint[]`
 * instead of a single `targetHint`, and the pass walks that list (first-unique-match-wins)
 * instead of resolving one hint. For every PATH-resolved language this MUST be a
 * behaviour-preserving refactor:
 *
 *  (1) every extractor wraps each reference as exactly a ONE-ELEMENT group — no extractor is
 *      silently dropped (a dropped extractor would emit an empty group, turning its edges
 *      off = a recall loss) and none accidentally widens to a multi-element group; and
 *  (2) the ordered walk over a one-element group emits BYTE-IDENTICAL `ResolvedDep`s to the
 *      pre-change per-dep path, which resolved `dep.targetHint` (now `dep.candidates[0]`)
 *      directly via `resolver.resolve`.
 *
 * This test independently re-derives the pre-change behaviour (resolve candidates[0]) and
 * the new behaviour (the ordered classify-walk) over the SAME extractor output and asserts
 * they agree, for representative source in every path-resolved language. A divergence here
 * would mean Stage 1 changed an edge — exactly what it must not do.
 */

// A stub path resolver: any specifier that begins with a key in this table maps to the
// recorded file; everything else is undefined. Lets us exercise both resolved and absent
// path outcomes without a real filesystem.
function stubPathResolver(table: Map<string, string>) {
  return (specifier: string): string | undefined => table.get(specifier);
}

// An owner index that maps specific files to nodes; an UNMAPPED file (D7) returns undefined.
function ownerIndexOf(map: Record<string, string>): OwnerIndex {
  return {
    ownerOf: (f: string) => map[f],
    ownerEntryOf: (f: string) =>
      map[f] === undefined ? undefined : { nodePath: map[f], mapping: f, kind: 'exact' },
  };
}

/** The pre-change per-dep resolution: resolve the FIRST (and, for path languages, only)
 *  candidate of each group directly via `resolve`, exactly as `pass.ts` did before. */
function referenceEdges(
  extractor: DependencyExtractor,
  uses: ReturnType<DependencyExtractor['uses']>,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
  language: string,
): ResolvedDep[] {
  const out: ResolvedDep[] = [];
  for (const dep of uses) {
    const r = resolver.resolve(dep.candidates[0], fromFile, language);
    if (r) out.push({ fromFile, line: dep.line, ownerNode: r.ownerNode });
  }
  return out;
}

/** The NEW per-group ordered walk (mirrors `pass.ts`): first RESOLVED candidate emits one
 *  edge and stops; AMBIGUOUS stops with silence; ABSENT continues. */
function walkEdges(
  uses: ReturnType<DependencyExtractor['uses']>,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
  language: string,
): ResolvedDep[] {
  const out: ResolvedDep[] = [];
  for (const dep of uses) {
    for (const cand of dep.candidates) {
      const outcome = resolver.classify(cand, fromFile, language);
      if (outcome.kind === 'resolved') {
        out.push({ fromFile, line: dep.line, ownerNode: outcome.ownerNode });
        break;
      }
      if (outcome.kind === 'ambiguous') break;
    }
  }
  return out;
}

interface PathCase {
  language: string;
  ext: string;
  extractor: DependencyExtractor;
  fromFile: string;
  source: string;
  /** specifier-prefix → repo-rel file the path resolver returns. */
  pathTable: Map<string, string>;
  /** repo-rel file → owning node (omitted file = unmapped → D7 absent). */
  ownerMap: Record<string, string>;
}

const PATH_CASES: PathCase[] = [
  {
    language: 'typescript',
    ext: '.ts',
    extractor: typescriptExtractor,
    fromFile: 'src/a/use.ts',
    source: `import { svc } from './svc';\nimport * as u from '../util/u';\nimport bare from 'node:path';\n`,
    pathTable: new Map([
      ['./svc', 'src/a/svc.ts'],
      ['../util/u', 'src/util/u.ts'],
    ]),
    ownerMap: { 'src/a/svc.ts': 'a', 'src/util/u.ts': 'util' },
  },
  {
    language: 'python',
    ext: '.py',
    extractor: pythonExtractor,
    fromFile: 'src/a/use.py',
    source: `import foo.bar\nfrom pkg import sub\nimport os\n`,
    pathTable: new Map([
      ['foo.bar', 'src/foo/bar.py'],
      ['pkg', 'src/pkg/__init__.py'],
    ]),
    ownerMap: { 'src/foo/bar.py': 'foo', 'src/pkg/__init__.py': 'pkg' },
  },
  {
    language: 'go',
    ext: '.go',
    extractor: goExtractor,
    fromFile: 'src/a/use.go',
    source: `package a\nimport (\n  "example.com/mod/foo"\n  "fmt"\n)\n`,
    pathTable: new Map([['example.com/mod/foo', 'src/foo/foo.go']]),
    ownerMap: { 'src/foo/foo.go': 'foo' },
  },
  {
    language: 'java',
    ext: '.java',
    extractor: javaExtractor,
    fromFile: 'src/a/Use.java',
    source: `import com.acme.foo.Bar;\nimport com.acme.pkg.*;\nimport java.util.List;\nclass Use {}\n`,
    pathTable: new Map([
      ['com.acme.foo.Bar', 'src/foo/Bar.java'],
      ['com.acme.pkg', 'src/pkg/Anything.java'],
    ]),
    ownerMap: { 'src/foo/Bar.java': 'foo', 'src/pkg/Anything.java': 'pkg' },
  },
  {
    language: 'php',
    ext: '.php',
    extractor: phpExtractor,
    fromFile: 'src/a/Use.php',
    source: `<?php\nuse App\\Foo\\Bar;\nuse Vendor\\External\\Thing;\nclass Use_ {}\n`,
    pathTable: new Map([['App\\Foo\\Bar', 'src/Foo/Bar.php']]),
    ownerMap: { 'src/Foo/Bar.php': 'foo' },
  },
  {
    language: 'rust',
    ext: '.rs',
    extractor: rustExtractor,
    fromFile: 'src/a/use.rs',
    source: `use crate::foo::Bar;\nuse std::collections::HashMap;\n`,
    pathTable: new Map([['crate::foo::Bar', 'src/foo/bar.rs']]),
    ownerMap: { 'src/foo/bar.rs': 'foo' },
  },
  {
    language: 'c',
    ext: '.c',
    extractor: cExtractor,
    fromFile: 'src/a/main.c',
    source: `#include "../foo/foo.h"\n#include <stdio.h>\n`,
    pathTable: new Map([['../foo/foo.h', 'src/foo/foo.h']]),
    ownerMap: { 'src/foo/foo.h': 'foo' },
  },
  {
    language: 'cpp',
    ext: '.cpp',
    extractor: cppExtractor,
    fromFile: 'src/a/main.cpp',
    source: `#include "../foo/Foo.hpp"\n#include <vector>\n`,
    pathTable: new Map([['../foo/Foo.hpp', 'src/foo/Foo.hpp']]),
    ownerMap: { 'src/foo/Foo.hpp': 'foo' },
  },
];

describe('candidate-group parity — one-element wrap is byte-identical to the pre-change per-dep path', () => {
  for (const c of PATH_CASES) {
    it(`${c.language}: every group is one-element and the ordered walk equals resolve(candidates[0])`, async () => {
      const { uses } = await runExtractor(c.extractor, c.language, c.ext, c.source);

      // (1) No extractor silently dropped or widened: every detected reference is a
      //     ONE-ELEMENT ordered group. A drop would be a zero-length group (edge off);
      //     a widen would be ≥2 candidates (a different walk).
      expect(uses.length).toBeGreaterThan(0);
      for (const dep of uses) {
        expect(dep.candidates).toHaveLength(1);
      }

      const resolver = makeResolver({
        ownerIndex: ownerIndexOf(c.ownerMap),
        symbolTable: new SymbolTable(), // path languages never touch the table
        resolvePathToFile: stubPathResolver(c.pathTable),
      });

      const reference = referenceEdges(c.extractor, uses, resolver, c.fromFile, c.language);
      const walked = walkEdges(uses, resolver, c.fromFile, c.language);

      // (2) Byte-identical resolved-edge set.
      expect(walked).toEqual(reference);

      // And the case is non-vacuous: at least one real cross-node edge was resolved, so the
      // parity assertion is exercising an actual emitted edge (a recall-loss regression would
      // drop it).
      expect(walked.length).toBeGreaterThan(0);
    });
  }
});
