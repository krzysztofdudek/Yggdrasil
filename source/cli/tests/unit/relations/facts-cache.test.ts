import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { astCacheDir, factsKey, loadFacts, writeFacts } from '../../../src/relations/facts-cache.js';
import { ensureLoaderRegistered } from '../../../src/ast/loader-hook.js';
import { withParsedFile } from '../../../src/ast/parser.js';
import {
  extractCsharpRefs,
  assembleCsharpCandidates,
} from '../../../src/relations/extractors/csharp.js';
import type { ParsedFile } from '../../../src/relations/extractors/types.js';

describe('facts-cache', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'astc-'));
    dir = astCacheDir(root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const key = factsKey({ contentHash: 'abc', language: 'typescript', grammarHash: 'g1', rev: 1 });

  // The key is 32 lowercase-hex chars = 128 bits of SHA-256. 64 bits (16 chars) was a
  // false-green CLASS: a birthday collision could serve one file's shard for another and the
  // `parsed.key !== key` identity assertion can't catch it (same truncation). 128 bits makes
  // a collision infeasible. (Widening orphans any pre-existing 16-char shards → one-time cold
  // re-parse; the cache is gitignored/rebuildable, so that is benign.)
  it('produces a 128-bit (32 hex char) key', () => {
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    // Distinct inputs still produce distinct keys at the wider width.
    const other = factsKey({ contentHash: 'abc', language: 'typescript', grammarHash: 'g2', rev: 1 });
    expect(other).toMatch(/^[0-9a-f]{32}$/);
    expect(other).not.toBe(key);
  });

  it('round-trips facts', async () => {
    await writeFacts(dir, 'typescript', key, { declarations: [], uses: [] });
    expect(await loadFacts(dir, 'typescript', key)).toEqual({ declarations: [], uses: [] });
  });
  it('returns null on miss', async () => {
    expect(await loadFacts(dir, 'typescript', factsKey({ contentHash: 'zzz', language: 'typescript', grammarHash: 'g1', rev: 1 }))).toBeNull();
  });
  it('returns null on a different schema version directory', async () => {
    // a key built with a different rev/grammar must not collide
    expect(await loadFacts(dir, 'typescript', factsKey({ contentHash: 'abc', language: 'typescript', grammarHash: 'g2', rev: 1 }))).toBeNull();
  });

  // #1 TRAP guard — a `CsharpExtract` carries two JS `Map`s (`scope.aliases` / `globalAliases`).
  // `JSON.stringify(new Map())` is `"{}"` and silently drops every entry, so a naive persist would
  // reload an EMPTY alias map → alias-qualified edges silently vanish → false green. This test
  // proves the cache (de)serializes those Maps as entry arrays: a cached-then-reloaded C# extract
  // must produce IDENTICAL `assembleCsharpCandidates` output to the freshly-extracted one.
  it('round-trips a C# extract with non-empty alias Maps (identical assemble output)', async () => {
    ensureLoaderRegistered();
    // A file-local using alias + a global-using alias: both populate the `scope.*aliases` Maps.
    const code = [
      'using Loc = MyApp.Local.Widget;',
      'global using Glob = MyApp.Global.Gadget;',
      'namespace App;',
      'class C { Loc a; Glob b; }',
    ].join('\n');
    // withParsedFile guarantees the WASM tree is deleted once the extract
    // (plain data) has been pulled out of it.
    const extract = await withParsedFile('src/x/C.cs', code, (tree) => {
      const pf: ParsedFile = { path: 'src/x/C.cs', content: code, tree, language: 'csharp' };
      return extractCsharpRefs(pf);
    });
    // Sanity: the extract really carries non-empty alias Maps (else the test proves nothing).
    expect(extract.scope.aliases.size).toBeGreaterThan(0);
    expect(extract.scope.globalAliases.size).toBeGreaterThan(0);

    const cKey = factsKey({ contentHash: 'csharp1', language: 'csharp', grammarHash: 'g1', rev: 2 });
    await writeFacts(dir, 'csharp', cKey, { declarations: [], uses: [], csharp: extract });
    const loaded = await loadFacts(dir, 'csharp', cKey);
    expect(loaded).not.toBeNull();
    expect(loaded!.csharp).toBeDefined();

    // The reloaded Maps survived the JSON boundary.
    expect(loaded!.csharp!.scope.aliases.size).toBe(extract.scope.aliases.size);
    expect(loaded!.csharp!.scope.globalAliases.size).toBe(extract.scope.globalAliases.size);

    // The decisive proof: identical candidate assembly from the reloaded vs fresh extract, with a
    // project-global alias variant exercising the alias merge path.
    const opts = { projectGlobalUsings: ['MyApp.Other'], projectGlobalUsingAliases: [['Ext', 'MyApp.Ext.Thing']] as Array<[string, string]> };
    expect(assembleCsharpCandidates(loaded!.csharp!, opts)).toEqual(assembleCsharpCandidates(extract, opts));
  });
});
