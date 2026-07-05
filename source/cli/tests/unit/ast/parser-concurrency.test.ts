import { describe, it, expect, vi, afterEach } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { getParser, withParsedFile } from '../../../src/ast/parser.js';

// Regression guard for the parallel-approve grammar-load race.
//
// Under `yg check --approve` with parallel > 1, many deterministic checks call
// getParser() at the same time. Before the fix, the runtime-init flag and the
// per-grammar cache were set only AFTER their `await`, so concurrent callers
// each re-ran Parser.init() / Language.load() and one could observe a
// half-initialized Language — web-tree-sitter then threw
// `Incompatible language version 0. Compatibility range 13 through 15`.
//
// The fix memoizes the in-flight PROMISES (set synchronously before the await),
// so the runtime initializes once and each grammar loads exactly once no matter
// how many callers race. vitest isolates test files (default isolate: true), so
// this file's module registry — and therefore the grammar cache — starts empty.
describe('ast/parser — concurrent load is memoized (parallel-approve race)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('N concurrent getParser() for a cold grammar load it exactly once', async () => {
    const initSpy = vi.spyOn(Parser, 'init');
    const loadSpy = vi.spyOn(Language, 'load');

    // Fan out a burst of concurrent callers for the same (cold) grammar.
    const parsers = await Promise.all(
      Array.from({ length: 24 }, () => getParser('.ts')),
    );

    // Every caller got a working parser — none observed a half-loaded grammar.
    expect(parsers).toHaveLength(24);
    for (const p of parsers) expect(p).toBeDefined();

    // The heart of the fix: the grammar was loaded exactly once despite 24
    // concurrent callers (pre-fix this was one load per caller), and the WASM
    // runtime initialized exactly once.
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('a big concurrent burst across several grammars all parse cleanly (no version-0 error)', async () => {
    const samples: Array<[string, string]> = [
      ['a.ts', 'const x = 1;'],
      ['b.py', 'x = 1\n'],
      ['c.go', 'package main\nfunc main() {}\n'],
      ['d.rs', 'fn main() {}\n'],
      ['e.java', 'class A {}\n'],
    ];
    // Mix grammars the way the batch prewarm does — every call must succeed.
    // withParsedFile drives the identical parseFile entry point (and deletes each
    // WASM tree as soon as its child count is read), so the race is exercised
    // exactly as before without leaking 40 trees.
    const childCounts = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const [file, src] = samples[i % samples.length];
        return withParsedFile(`${i}-${file}`, src, (tree) => tree.rootNode.childCount);
      }),
    );
    expect(childCounts).toHaveLength(40);
    for (const c of childCounts) expect(c).toBeGreaterThan(0);
  });

  it('a failed grammar load is evicted so a later call can retry', async () => {
    // First call: force Language.load to reject → getParser rejects and the
    // failed promise is evicted from the cache.
    const loadSpy = vi.spyOn(Language, 'load').mockRejectedValueOnce(new Error('transient wasm read error'));
    await expect(getParser('.rb')).rejects.toThrow(/transient wasm read error/);
    loadSpy.mockRestore();

    // Second call (real load): must succeed — proving the rejected promise was
    // not left poisoning the cache.
    const parser = await getParser('.rb');
    expect(parser).toBeDefined();
    const childCount = await withParsedFile('x.rb', 'x = 1\n', (tree) => tree.rootNode.childCount);
    expect(childCount).toBeGreaterThan(0);
  });
});
