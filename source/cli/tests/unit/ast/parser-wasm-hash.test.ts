import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { grammarWasmHash, grammarDigest, grammarDigestForLanguage, treeSitterRuntimeHash } from '../../../src/ast/parser.js';

describe('grammarWasmHash', () => {
  it('is a stable 64-hex sha256 for a known grammar', () => {
    const h = grammarWasmHash('.ts');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(grammarWasmHash('.ts')).toBe(h); // memoized + stable
  });
  it('differs across grammars', () => {
    expect(grammarWasmHash('.ts')).not.toBe(grammarWasmHash('.py'));
  });
});

describe('grammarDigest — the grammar AND the parser runtime', () => {
  it('treeSitterRuntimeHash is the sha256 of the installed web-tree-sitter wasm', () => {
    const wasm = createRequire(import.meta.url).resolve('web-tree-sitter/web-tree-sitter.wasm');
    expect(treeSitterRuntimeHash()).toBe(createHash('sha256').update(readFileSync(wasm)).digest('hex'));
  });
  it('folds the runtime hash and the grammar wasm hash, so either one changing changes it', () => {
    const expected = createHash('sha256')
      .update(`web-tree-sitter:${treeSitterRuntimeHash()}\ngrammar:${grammarWasmHash('.rs')}`)
      .digest('hex');
    expect(grammarDigest('.rs')).toBe(expected);
    expect(grammarDigest('.rs')).not.toBe(grammarWasmHash('.rs'));
    expect(grammarDigest('.rs')).toBe(grammarDigest('.rs'));
  });
  it('by language id: the language\'s first extension; undefined for a language that is not registered', () => {
    expect(grammarDigestForLanguage('rust')).toBe(grammarDigest('.rs'));
    expect(grammarDigestForLanguage('cobol')).toBeUndefined();
    expect(grammarDigestForLanguage('constructor')).toBeUndefined();
  });
});
