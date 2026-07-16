import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withParsedFile } from '../../../src/ast/parser.js';
import { ensureLoaderRegistered } from '../../../src/ast/loader-hook.js';
import { LANGUAGES } from '../../../src/utils/language-registry.js';
import {
  countFeatures,
  isValidFeatureVector,
  FEATURE_VOCAB,
  ALL_FEATURE_CATEGORIES,
  type FeatureCategory,
  type FeatureVector,
} from '../../../src/relations/feature-vector.js';
import type { Node } from 'web-tree-sitter';

// ---------------------------------------------------------------------------
// Step 3 — the node-dump derivation helper. Parses a fixture and returns a
// frequency map of NAMED node.type values. This is the "derive and verify"
// instrument: every FEATURE_VOCAB cell was grounded against a real parse (this
// helper) AND against each grammar's node-types.json catalog. Here it doubles as
// an INDEPENDENT oracle for the counts countFeatures produces — it shares no code
// with countFeatures (no depth logic, no FEATURE_VOCAB), so agreement is a real
// cross-check, not a tautology.
// ---------------------------------------------------------------------------
function nodeTypeFrequencies(root: Node): Map<string, number> {
  const freq = new Map<string, number>();
  const visit = (n: Node): void => {
    if (n.isNamed) freq.set(n.type, (freq.get(n.type) ?? 0) + 1);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(root);
  return freq;
}

/** Total named nodes = sum of all frequencies (independent of countFeatures). */
function totalNamed(freq: Map<string, number>): number {
  let n = 0;
  for (const v of freq.values()) n += v;
  return n;
}

/** Expected count for a category = sum of the fixture's freq over that category's vocab. */
function expectedCategory(freq: Map<string, number>, language: string, cat: FeatureCategory): number {
  let n = 0;
  for (const t of FEATURE_VOCAB[language][cat]) n += freq.get(t) ?? 0;
  return n;
}

async function features(file: string, src: string, language: string): Promise<FeatureVector> {
  return withParsedFile(file, src, (tree) => countFeatures(tree.rootNode, language));
}

async function freqOf(file: string, src: string): Promise<Map<string, number>> {
  return withParsedFile(file, src, (tree) => nodeTypeFrequencies(tree.rootNode));
}

// ---------------------------------------------------------------------------
// Per-language fixtures with HAND-COMPUTED category counts. Fixtures are kept
// small enough that each construct is countable by eye; nodeCount and the
// category tallies are additionally cross-checked against the independent
// frequency oracle above.
// ---------------------------------------------------------------------------

interface LangCase {
  language: string;
  file: string;
  src: string;
  categories: Record<FeatureCategory, number>;
}

const CASES: LangCase[] = [
  {
    language: 'typescript',
    file: 'a.ts',
    src: [
      'import { a } from "./m";',
      'export class C extends D {}',
      'function f(x: number): string {',
      '  if (x > 0) { for (let i = 0; i < 2; i++) { g(i); } }',
      '  return "ok";',
      '}',
    ].join('\n'),
    categories: {
      'function-like': 1, // function_declaration
      'class-like': 1, // class_declaration
      'import-like': 1, // import_statement only — `export class C` is outbound linkage, not an import
      'branch-like': 2, // if_statement + for_statement
      'call-like': 1, // g(i)
      'literal-like': 5, // strings "./m", "ok" + numbers 0, 0, 2
    },
  },
  {
    language: 'python',
    file: 'a.py',
    src: [
      'import os',
      'from sys import path',
      'class A(B):',
      '    def m(self):',
      '        if x:',
      '            return f("s")',
      '        return 1',
    ].join('\n'),
    categories: {
      'function-like': 1, // function_definition
      'class-like': 1, // class_definition
      'import-like': 2, // import_statement + import_from_statement
      'branch-like': 1, // if_statement
      'call-like': 1, // f("s")
      'literal-like': 2, // string "s" + integer 1
    },
  },
  {
    language: 'go',
    file: 'a.go',
    src: [
      'package a',
      'import "fmt"',
      'type T struct{ X int }',
      'func F(n int) int {',
      '\tif n > 0 {',
      '\t\tfmt.Println("hi")',
      '\t}',
      '\treturn h(n)',
      '}',
    ].join('\n'),
    categories: {
      'function-like': 1, // function_declaration
      'class-like': 1, // type_spec (struct)
      'import-like': 1, // import_spec
      'branch-like': 1, // if_statement
      'call-like': 2, // fmt.Println(...) + h(n)
      'literal-like': 3, // interpreted strings "fmt", "hi" + int 0
    },
  },
  {
    language: 'java',
    file: 'A.java',
    src: [
      'import java.util.List;',
      'class A {',
      '  void m(int a) {',
      '    if (a > 0) { g(a); }',
      '    String s = "x";',
      '  }',
      '}',
    ].join('\n'),
    categories: {
      'function-like': 1, // method_declaration
      'class-like': 1, // class_declaration
      'import-like': 1, // import_declaration
      'branch-like': 1, // if_statement
      'call-like': 1, // g(a)
      'literal-like': 2, // decimal_integer_literal 0 + string_literal "x"
    },
  },
  {
    language: 'csharp',
    file: 'A.cs',
    src: [
      'using System;',
      'class A {',
      '  void M(int a) {',
      '    if (a > 0) { G(a); }',
      '    string s = "x";',
      '  }',
      '}',
    ].join('\n'),
    categories: {
      'function-like': 1, // method_declaration
      'class-like': 1, // class_declaration
      'import-like': 1, // using_directive
      'branch-like': 1, // if_statement
      'call-like': 1, // G(a)
      'literal-like': 2, // integer_literal 0 + string_literal "x"
    },
  },
];

describe('countFeatures — per-language structural counts on real parses', () => {
  for (const c of CASES) {
    it(`${c.language}: exact category counts + nodeCount cross-check`, async () => {
      ensureLoaderRegistered();
      const fv = await features(c.file, c.src, c.language);
      const freq = await freqOf(c.file, c.src);

      // All six category keys always present.
      expect(Object.keys(fv.categories).sort()).toEqual([...ALL_FEATURE_CATEGORIES].sort());

      // Hand-computed category counts.
      for (const cat of ALL_FEATURE_CATEGORIES) {
        expect(fv.categories[cat], `${c.language} ${cat}`).toBe(c.categories[cat]);
        // Independent cross-check against the frequency oracle.
        expect(fv.categories[cat], `${c.language} ${cat} (oracle)`).toBe(
          expectedCategory(freq, c.language, cat),
        );
      }

      // nodeCount equals the total named nodes counted by the independent oracle.
      expect(fv.nodeCount).toBe(totalNamed(freq));
      expect(fv.nodeCount).toBeGreaterThan(0);

      // Depth quartiles: three integers, sorted non-decreasing, within [0, nodeCount).
      const [q25, q50, q75] = fv.depthQuartiles;
      for (const q of [q25, q50, q75]) {
        expect(Number.isInteger(q)).toBe(true);
        expect(q).toBeGreaterThanOrEqual(0);
        expect(q).toBeLessThan(fv.nodeCount);
      }
      expect(q25).toBeLessThanOrEqual(q50);
      expect(q50).toBeLessThanOrEqual(q75);
    });
  }
});

describe('countFeatures — edge cases (depthQuartiles well-defined, no divide-by-zero)', () => {
  it('empty file → a single named root node, all categories zero', async () => {
    ensureLoaderRegistered();
    const fv = await features('empty.ts', '', 'typescript');
    // An empty TS source still parses to a single named `program` root.
    expect(fv.nodeCount).toBe(1);
    expect(fv.depthQuartiles).toEqual([0, 0, 0]);
    for (const cat of ALL_FEATURE_CATEGORIES) expect(fv.categories[cat]).toBe(0);
  });

  it('single statement → exact nodeCount + nearest-rank quartiles', async () => {
    ensureLoaderRegistered();
    // `1;` parses to program > expression_statement > number: three named nodes at
    // depths 0, 1, 2. Nearest-rank on [0,1,2] gives q25=0, q50=1, q75=2.
    const fv = await features('one.ts', '1;', 'typescript');
    expect(fv.nodeCount).toBe(3);
    expect(fv.depthQuartiles).toEqual([0, 1, 2]);
    expect(fv.categories['literal-like']).toBe(1); // the `number` literal
    expect(fv.categories['call-like']).toBe(0);
  });

  it('unknown language → all-zero categories, still counts nodes (graceful, never throws)', async () => {
    ensureLoaderRegistered();
    const fv = await features('a.ts', 'const x = 1;', 'no-such-language');
    expect(fv.nodeCount).toBeGreaterThan(0);
    for (const cat of ALL_FEATURE_CATEGORIES) expect(fv.categories[cat]).toBe(0);
  });
});

describe('FEATURE_VOCAB integrity', () => {
  it('every language declares all six categories with no cross-category node-type collisions', () => {
    for (const [language, vocab] of Object.entries(FEATURE_VOCAB)) {
      expect(Object.keys(vocab).sort(), language).toEqual([...ALL_FEATURE_CATEGORIES].sort());
      const seen = new Map<string, FeatureCategory>();
      for (const cat of ALL_FEATURE_CATEGORIES) {
        for (const t of vocab[cat]) {
          expect(seen.has(t), `${language}: '${t}' in both ${seen.get(t)} and ${cat}`).toBe(false);
          seen.set(t, cat);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// STANDING derive-and-verify guard. Only 5 of the 13 languages have exact-count
// fixtures above, so a typo or grammar drift in any un-exercised FEATURE_VOCAB
// cell would otherwise silently produce wrong counts. This makes "every vocab
// string is a REAL named node type in that grammar" a permanent, enforced
// property: for EVERY language and EVERY node-type string in EVERY category, the
// string must exist in that grammar's own node-type catalog (the same
// `node-types.json` the grammars ship — the authoritative list of node types the
// grammar can produce). A declared-empty cell contributes nothing (fine — its
// documented reason stands); the guard validates only the strings that ARE present.
// ---------------------------------------------------------------------------
describe('FEATURE_VOCAB is grounded in every grammar node-type catalog (derive-and-verify, standing)', () => {
  const GRAMMARS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/grammars');

  /** Named node types a grammar can produce, from its `node-types.json` (top-level + named
   *  subtypes) — the same catalog the FEATURE_VOCAB cells were originally grounded against. */
  function catalogNamedTypes(language: string): Set<string> {
    const def = LANGUAGES[language];
    expect(def, `no grammar registered for extractor language '${language}'`).toBeTruthy();
    const catalogPath = path.join(GRAMMARS_DIR, def.wasmFile.replace(/\.wasm$/, '.node-types.json'));
    expect(
      existsSync(catalogPath),
      `grammar node-type catalog not found — build dist first (npm run build): ${catalogPath}`,
    ).toBe(true);
    const entries = JSON.parse(readFileSync(catalogPath, 'utf-8')) as Array<{
      type: string;
      named?: boolean;
      subtypes?: Array<{ type: string; named?: boolean }>;
    }>;
    const named = new Set<string>();
    for (const entry of entries) {
      if (entry.named) named.add(entry.type);
      for (const sub of entry.subtypes ?? []) if (sub.named) named.add(sub.type);
    }
    return named;
  }

  for (const language of Object.keys(FEATURE_VOCAB)) {
    it(`${language}: every node-type string is a real named type in the grammar catalog`, () => {
      const named = catalogNamedTypes(language);
      const missing: string[] = [];
      for (const cat of ALL_FEATURE_CATEGORIES) {
        for (const t of FEATURE_VOCAB[language][cat]) {
          if (!named.has(t)) missing.push(`${cat}:'${t}'`);
        }
      }
      expect(missing, `${language} FEATURE_VOCAB strings absent from grammar catalog: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('isValidFeatureVector', () => {
  const good: FeatureVector = {
    nodeCount: 5,
    depthQuartiles: [0, 1, 2],
    categories: {
      'function-like': 0,
      'class-like': 0,
      'import-like': 0,
      'branch-like': 0,
      'call-like': 0,
      'literal-like': 0,
    },
  };

  it('accepts a well-formed vector', () => {
    expect(isValidFeatureVector(good)).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(isValidFeatureVector(null)).toBe(false);
    expect(isValidFeatureVector(42)).toBe(false);
    expect(isValidFeatureVector('x')).toBe(false);
  });

  it('rejects a bad nodeCount', () => {
    expect(isValidFeatureVector({ ...good, nodeCount: '5' })).toBe(false);
    expect(isValidFeatureVector({ ...good, nodeCount: NaN })).toBe(false);
  });

  it('rejects malformed depthQuartiles (wrong length or non-numeric)', () => {
    expect(isValidFeatureVector({ ...good, depthQuartiles: [0, 1] })).toBe(false);
    expect(isValidFeatureVector({ ...good, depthQuartiles: [0, 1, 2, 3] })).toBe(false);
    expect(isValidFeatureVector({ ...good, depthQuartiles: [0, 1, 'x'] })).toBe(false);
  });

  it('rejects categories missing a required key', () => {
    const { ['call-like']: _omit, ...rest } = good.categories;
    void _omit;
    expect(isValidFeatureVector({ ...good, categories: rest })).toBe(false);
  });

  it('rejects a non-numeric category value', () => {
    expect(
      isValidFeatureVector({ ...good, categories: { ...good.categories, 'branch-like': '1' } }),
    ).toBe(false);
  });
});
