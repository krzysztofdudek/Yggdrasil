import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { astCacheDir, factsKey, loadFacts, writeFacts } from '../../../src/relations/facts-cache.js';
import type { FeatureVector } from '../../../src/relations/feature-vector.js';

/**
 * Branch-coverage tests for the facts-cache shard loader's corruption guards. A corrupt or
 * schema-mismatched shard must load as `null` (a cache MISS → cold re-parse), never as an
 * empty `{ declarations: [], uses: [] }` — papering over a broken shard would let the
 * relation gate read "no dependencies" and go falsely green. Each case writes a valid shard,
 * then overwrites its bytes with a specific malformed body and asserts loadFacts returns null.
 *
 * All bodies carry `v: 2` (the current schema) so each reaches the specific guard under test
 * rather than short-circuiting at the version check. Bodies exercising a guard AFTER the
 * features check additionally carry a valid `features` vector so they get that far.
 */

/** A structurally-valid feature vector so a body can pass the features guard when the test
 *  targets a LATER guard (identity, C# deserialize). */
const FV: FeatureVector = {
  nodeCount: 1,
  depthQuartiles: [0, 0, 0],
  categories: {
    'function-like': 0,
    'class-like': 0,
    'import-like': 0,
    'branch-like': 0,
    'call-like': 0,
    'literal-like': 0,
  },
};

describe('facts-cache — corrupt shard guards', () => {
  let root: string;
  let dir: string;
  const key = factsKey({ contentHash: 'abc', language: 'csharp', grammarHash: 'g1', rev: 1 });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'astc-bc-'));
    dir = astCacheDir(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The path of the single shard file writeFacts created under `dir` (recursive search). */
  function findShard(base: string): string {
    for (const entry of readdirSync(base)) {
      const full = path.join(base, entry);
      if (statSync(full).isDirectory()) {
        const nested = findShard(full);
        if (nested) return nested;
      } else if (entry.endsWith('.json')) {
        return full;
      }
    }
    return '';
  }

  /** Write a valid shard, then overwrite its bytes with `body`; return the shard path. */
  async function corruptWith(body: string): Promise<string> {
    await writeFacts(dir, 'csharp', key, { declarations: [], uses: [], features: FV });
    const shard = findShard(dir);
    expect(shard).not.toBe('');
    writeFileSync(shard, body, 'utf-8');
    return shard;
  }

  it('returns null when the shard is not valid JSON', async () => {
    await corruptWith('this is { not json');
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null on a schema-version mismatch', async () => {
    await corruptWith(JSON.stringify({ v: 999, key, declarations: [], uses: [] }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the stored key is not a string', async () => {
    await corruptWith(JSON.stringify({ v: 2, key: 42, declarations: [], uses: [], features: FV }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when declarations is not an array', async () => {
    await corruptWith(JSON.stringify({ v: 2, key, declarations: 'nope', uses: [], features: FV }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when uses is not an array', async () => {
    await corruptWith(JSON.stringify({ v: 2, key, declarations: [], uses: 'nope', features: FV }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the persisted features vector is missing or malformed', async () => {
    // No features at all → miss (fail-closed-to-parse, never a silent 0-vector).
    await corruptWith(JSON.stringify({ v: 2, key, declarations: [], uses: [] }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
    // Present but structurally broken (depthQuartiles wrong length) → also a miss.
    await corruptWith(
      JSON.stringify({
        v: 2,
        key,
        declarations: [],
        uses: [],
        features: { ...FV, depthQuartiles: [0, 0] },
      }),
    );
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the stored key does not match the requested key', async () => {
    await corruptWith(JSON.stringify({ v: 2, key: 'a-different-key', declarations: [], uses: [], features: FV }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the C# extract mirror is malformed (missing fileNs)', async () => {
    await corruptWith(JSON.stringify({ v: 2, key, declarations: [], uses: [], features: FV, csharp: { notFileNs: 1 } }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the C# extract mirror has no scope object', async () => {
    await corruptWith(JSON.stringify({ v: 2, key, declarations: [], uses: [], features: FV, csharp: { fileNs: 'App' } }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });

  it('returns null when the C# extract scope arrays are malformed', async () => {
    const csharp = { fileNs: 'App', scope: { prefixes: 'bad', globalPrefixes: [], aliases: [], globalAliases: [], staticTargets: [] }, refs: [] };
    await corruptWith(JSON.stringify({ v: 2, key, declarations: [], uses: [], features: FV, csharp }));
    expect(await loadFacts(dir, 'csharp', key)).toBeNull();
  });
});
