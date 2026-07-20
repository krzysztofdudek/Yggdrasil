/**
 * REGRESSION (C-0 companion, mock-free): every language in the registry must
 * actually load and parse. The relation-conformance check parses each mapped file
 * with tree-sitter; if a registered language ships with no resolvable/loadable WASM
 * grammar — e.g. a language added to LANGUAGES without a matching bundled grammar,
 * the exact registry/tsup drift the fix guards against — parsing throws an
 * infrastructure fault. This test loads and parses one probe per registered language
 * so such a drift fails the suite HERE, deterministically, rather than silently
 * zeroing that language's relation analysis at runtime.
 *
 * Uses withParsedFile so the WASM-heap Tree is released in a finally block —
 * withParsedFile calls parseFile internally before running the callback, so a
 * missing/corrupt grammar still throws here (the drift we want to catch) while
 * every probe tree is deleted, leaking nothing across the per-language loop.
 *
 * No mocks: real registry, real parser, real bundled/devDep grammars.
 */
import { describe, it, expect } from 'vitest';
import { LANGUAGES } from '../../../src/utils/language-registry.js';
import { withParsedFile } from '../../../src/ast/parser.js';

describe('grammar registry — every registered language loads and parses', () => {
  for (const def of Object.values(LANGUAGES)) {
    it(`loads and parses ${def.id} (${def.extensions[0]})`, async () => {
      const ext = def.extensions[0];
      // withParsedFile derives the grammar from the extension only; empty content
      // parses to a non-null (empty) tree for every tree-sitter grammar. A
      // missing/corrupt grammar makes the internal parseFile throw here — the drift
      // we want to catch — before the callback runs.
      await withParsedFile(`probe${ext}`, '', (tree) => {
        expect(tree).toBeDefined();
        expect(tree.rootNode).toBeDefined();
      });
    });
  }
});
