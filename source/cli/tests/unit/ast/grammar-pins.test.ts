/**
 * The grammars that ship are exactly the pinned ones. The build (scripts/grammars.mjs)
 * refuses to write a grammar whose bytes differ from its pin in the language registry;
 * this test re-checks the result the tests themselves parse with (dist/grammars/, the
 * only place the parser loads grammars from) and that each pin's recorded ABI is the
 * one the loaded Language reports on the current web-tree-sitter runtime — so a pin
 * edited without rebuilding, or a stale dist, fails here rather than in a user's run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES } from '../../../src/utils/language-registry.js';

const GRAMMARS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/grammars');
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('shipped grammars match their pins', () => {
  for (const def of Object.values(LANGUAGES)) {
    it(`${def.id}: wasm and node-types.json bytes equal the pinned sha256`, () => {
      expect(sha256(path.join(GRAMMARS_DIR, def.wasmFile))).toBe(def.grammar.wasmSha256);
      expect(sha256(path.join(GRAMMARS_DIR, def.wasmFile.replace(/\.wasm$/, '.node-types.json')))).toBe(def.grammar.nodeTypesSha256);
    });
    it(`${def.id}: loads on the current runtime with the pinned ABI`, async () => {
      await Parser.init();
      const lang = await Language.load(path.join(GRAMMARS_DIR, def.wasmFile));
      expect(lang.abiVersion).toBe(def.grammar.abi);
    });
  }
});
