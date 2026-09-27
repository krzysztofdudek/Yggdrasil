/**
 * The grammars that ship are exactly the pinned ones, on the pinned runtime. The pins live in
 * the grammar manifest of @chrisdudek/runes; the build (scripts/grammars.mjs) refuses to write a
 * grammar whose bytes differ from its pin. This test re-checks the result the tests themselves
 * parse with (dist/grammars/, the only place the parser loads grammars from), that each pin's
 * recorded ABI is the one the loaded Language reports, and that the web-tree-sitter runtime and
 * the npm grammar packages installed here are the versions (and the runtime the engine bytes) the
 * manifest pins. Runes' own CI runs the 460-case relation catalogue on that pinned runtime, so a
 * drift here would mean the catalogue passing there says nothing about the trees Yggdrasil gets.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { loadGrammarManifest, verifyGrammarFiles } from '@chrisdudek/runes/grammars';
import { checkRuntimePins, formatRuntimePinReport } from '@chrisdudek/runes/testkit';
import { LANGUAGES } from '../../../src/utils/language-registry.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GRAMMARS_DIR = path.join(CLI_ROOT, 'dist/grammars');
const TABLE = Object.keys(LANGUAGES);

describe('shipped grammars match their pins', () => {
  it('every language of the table has a pin in the Runes grammar manifest', () => {
    const pinned = new Map(loadGrammarManifest().grammars.map((g) => [g.language, g.wasmFile]));
    for (const def of Object.values(LANGUAGES)) expect(pinned.get(def.id), def.id).toBe(def.wasmFile);
  });

  it('dist/grammars holds exactly the pinned bytes (wasm and node-types.json) of every language', () => {
    expect(verifyGrammarFiles(GRAMMARS_DIR, { only: TABLE })).toEqual([]);
  });

  for (const pin of loadGrammarManifest().grammars.filter((g) => TABLE.includes(g.language))) {
    it(`${pin.language}: loads on the current runtime with the pinned ABI`, async () => {
      await Parser.init();
      const lang = await Language.load(path.join(GRAMMARS_DIR, pin.wasmFile));
      expect(lang.abiVersion).toBe(pin.abi);
    });
  }

  it('the installed web-tree-sitter (version and engine bytes) and npm grammar packages are the pinned ones', () => {
    const problems = checkRuntimePins({ resolveFrom: CLI_ROOT, languages: TABLE, cli: true });
    expect(problems, formatRuntimePinReport(problems)).toEqual([]);
  });
});
