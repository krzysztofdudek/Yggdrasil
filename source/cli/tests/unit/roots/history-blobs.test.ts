// =============================================================================
// tests/unit/roots/history-blobs.test.ts — Task 4's blob-record extraction
// seam: `extractBlobRecord` (per-file pure extraction against historical blob
// content) and `makeBlobRecordReader` (the read-through cache over
// `io/roots-blob-cache.ts`).
//
// Every blob this file exercises is committed into ONE real, deterministic
// git repository (`tests/support/git-fixture.ts`'s primitives — no fabricated
// sha, no hand-typed content standing in for one) and its content is fetched
// through the real `readBlobs` plumbing (`utils/git-history.ts`, Task 2) —
// the same route T8's own probe-then-fetch protocol will use. Every cache is
// a real tmp directory; nothing here is mocked.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDeterministicGitFixture, runDeterministicGitFixture, runGitFixture } from '../../support/git-fixture.js';
import { readBlobs } from '../../../src/utils/git-history.js';
import { extractBlobRecord, makeBlobRecordReader, blobCacheKey } from '../../../src/roots/history.js';
import type { BlobRecord } from '../../../src/roots/history.js';
import { EXTRACTOR_VERSION } from '../../../src/roots/extract.js';
import { assetNameOfWasmFile, bindingForAsset } from '../../../src/roots/binding.js';
import { getGrammarForExtension } from '../../../src/utils/language-registry.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// -----------------------------------------------------------------------------
// One real fixture repository, one commit, carrying every blob shape the
// acceptance criteria below need.
// -----------------------------------------------------------------------------

const ORDER_TS = ['export function createOrder(id: string): number {', '  return id.length;', '}', ''].join('\n');
const FOO_TS = 'export const f = 1;\n';
/** Valid TypeScript AND valid Python — a bare assignment statement in both grammars (mirrors the `history/` golden's own `src/stub/same.ts`/`same.py` pair, D4's arrival-order case). */
const SAME_STUB = 'x = 1\n';
/** `é` is 2 UTF-8 bytes but 1 decoded character — raw byte length (40) and decoded character length (20) genuinely differ (F-1). */
const MULTIBYTE_TS = `const s = "${'é'.repeat(20)}";\n`;
/** ~200,000-deep nested JSON — blows the parser/extractor's recursive stack with no mock and no WASM manipulation, reaching the `unparseable` degrade branch (F-3). */
const DEEP_JSON = `${'['.repeat(200_000)}${']'.repeat(200_000)}\n`;

let repoDir: string;
/** Repo-relative path -> real blob sha, from `git ls-tree -r HEAD`. */
let shaOf: Map<string, string>;
/** Blob sha -> real content, fetched through `readBlobs`. */
let contentOf: Map<string, Buffer>;

beforeAll(async () => {
  repoDir = mkdtempSync(path.join(tmpdir(), 'yg-history-blobs-'));
  initDeterministicGitFixture(repoDir);

  const files: Record<string, string> = {
    'src/svc/order.ts': ORDER_TS,
    'src/foo.ts': FOO_TS,
    'src/stub/same.ts': SAME_STUB,
    'src/stub/same.py': SAME_STUB,
    'src/empty.ts': '',
    'docs/EMPTY.md': '',
    'NOTES.md': 'just some notes\n',
    'yarn.lock': '# yarn lockfile v1\n',
    'assets/pic.png': 'not a real png — only the extension matters to the registry lookup\n',
    'src/oversize.ts': 'a'.repeat(2_000_000),
    'src/toolong.ts': Array.from({ length: 40001 }, () => 'x').join('\n'),
    'src/justfits.ts': Array.from({ length: 39999 }, () => 'x').join('\n'),
    'dist/index.js': 'console.log(1);\n',
    'vendor/lib.ts': 'export const v = 1;\n',
    'src/types/api.d.ts': 'export declare const a: number;\n',
    'src/foo.test.ts': 'export const t = 1;\n',
    'src/multi.ts': MULTIBYTE_TS,
    'src/private/secret.ts': 'export const p = 1;\n',
    'dist/notes.md': 'excluded AND no registered grammar\n',
    'src/deep.json': DEEP_JSON,
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repoDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  const add = runDeterministicGitFixture(repoDir, ['add', '-A'], 0);
  if (add.status !== 0) throw new Error(`git add failed in ${repoDir}: ${add.stderr}${add.stdout}`);
  const commit = runDeterministicGitFixture(repoDir, ['commit', '-q', '-m', 'seed'], 0);
  if (commit.status !== 0) throw new Error(`git commit failed in ${repoDir}: ${commit.stderr}${commit.stdout}`);

  const lsTree = runGitFixture(repoDir, ['ls-tree', '-r', 'HEAD']);
  if (lsTree.status !== 0) throw new Error(`git ls-tree failed in ${repoDir}: ${lsTree.stderr}${lsTree.stdout}`);
  shaOf = new Map();
  for (const line of lsTree.stdout.split('\n')) {
    if (line === '') continue;
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) continue;
    shaOf.set(m[2], m[1]);
  }

  contentOf = new Map();
  await readBlobs(repoDir, [...new Set(shaOf.values())], (sha, content) => {
    contentOf.set(sha, content);
  });
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

function shaFor(relPath: string): string {
  const sha = shaOf.get(relPath);
  if (!sha) throw new Error(`fixture repo has no blob for ${relPath}`);
  return sha;
}
function contentFor(relPath: string): Buffer {
  const content = contentOf.get(shaFor(relPath));
  if (!content) throw new Error(`fixture repo has no fetched content for ${relPath}`);
  return content;
}

/** The key `makeBlobRecordReader` derives for `relPath`'s registered grammar — computed independently (never imported from `history.ts`'s own internals) so an assertion against it is a real end-to-end check, not a tautology. */
function expectedKeyFor(relPath: string, sha: string): string {
  const grammarInfo = getGrammarForExtension(path.extname(relPath));
  if (!grammarInfo) throw new Error(`no registered grammar for ${relPath}`);
  const { hash } = bindingForAsset(assetNameOfWasmFile(grammarInfo.wasmFile));
  return blobCacheKey(sha, EXTRACTOR_VERSION, hash);
}

function shardPathFor(cacheDir: string, key: string): string {
  return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
}

async function tmpCacheDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'yg-blob-cache-'));
}

/** Every JSON shard file under `cacheDir`, recursively — empty when the directory does not exist at all. */
function everyShardFile(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  const out: string[] = [];
  for (const prefix of readdirSync(cacheDir)) {
    const prefixDir = path.join(cacheDir, prefix);
    for (const name of readdirSync(prefixDir)) out.push(path.join(prefixDir, name));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Acceptance 1 — same blob, two calls, one parse, deep-equal records.
// -----------------------------------------------------------------------------

describe('acceptance 1 — same blob, two calls, one parse', () => {
  it('the second call is a cache hit: onParsed never fires again and the two records are deep-equal', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => {
        parses++;
      });
      const sha = shaFor('src/svc/order.ts');
      const content = contentFor('src/svc/order.ts');

      const first = await reader(sha, 'src/svc/order.ts', content);
      expect(parses).toBe(1);
      expect(first.skipped).toBe(false);

      const second = await reader(sha, 'src/svc/order.ts', content);
      expect(parses).toBe(1); // never fires again — the second call is a cache HIT
      expect(second).toEqual(first);
      // Not just deep-equal: a cache HIT's record is BYTE-IDENTICAL (canonical,
      // sorted-key serialization — `sortKeysDeep` in history.ts) to the fresh
      // MISS's record. R4-I3 depends on nothing downstream disagreeing between
      // a cold and a warm run the moment a consumer serializes a scope
      // directly instead of treating it as a bag of named fields.
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('extractBlobRecord itself (no cache) produces the same record shape a fresh miss would', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/svc/order.ts', contentFor('src/svc/order.ts'), config);
    expect(record.skipped).toBe(false);
    if (!record.skipped) {
      expect(record.scopes.length).toBeGreaterThanOrEqual(2); // the named function + the mandatory file scope
      expect(record.scopes.some((s) => s.kind === 'file')).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Acceptance 2/3 — key sensitivity to extractorVersion and bindingHash,
// independently. The constants are not runtime-injectable, so the mechanism
// is pinned directly at `blobCacheKey` (which the reader is built on) AND
// end-to-end via the shard actually landing at the key the real constants
// produce — together these prove "changing X changes the key" for both X.
// -----------------------------------------------------------------------------

describe('acceptance 2 — EXTRACTOR_VERSION is folded into the key, independently of the blob and the grammar', () => {
  it('blobCacheKey differs when only extractorVersion differs', () => {
    const sha = shaFor('src/svc/order.ts');
    const bindingHashValue = bindingForAsset('typescript').hash;
    expect(blobCacheKey(sha, 'v1', bindingHashValue)).not.toBe(blobCacheKey(sha, 'v2', bindingHashValue));
  });

  it('a real reader run writes its shard under blobCacheKey(sha, EXTRACTOR_VERSION, bindingHash) — a shard computed under a DIFFERENT version is absent (a would-be miss), and the real shard is left inert, never touched by that computation', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      const sha = shaFor('src/svc/order.ts');
      await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));

      const realKey = expectedKeyFor('src/svc/order.ts', sha);
      expect(existsSync(shardPathFor(cacheDir, realKey))).toBe(true);

      const bindingHashValue = bindingForAsset('typescript').hash;
      const otherVersionKey = blobCacheKey(sha, `${EXTRACTOR_VERSION}-other`, bindingHashValue);
      expect(otherVersionKey).not.toBe(realKey);
      expect(existsSync(shardPathFor(cacheDir, otherVersionKey))).toBe(false); // a reader "under" that version would see a miss
      expect(existsSync(shardPathFor(cacheDir, realKey))).toBe(true); // the real shard is untouched — left inert, not deleted
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('acceptance 3 — a grammar bindingHash change moves the key too, independently of EXTRACTOR_VERSION', () => {
  it('blobCacheKey differs when only bindingHash differs', () => {
    const sha = shaFor('src/svc/order.ts');
    expect(blobCacheKey(sha, EXTRACTOR_VERSION, 'hash-a')).not.toBe(blobCacheKey(sha, EXTRACTOR_VERSION, 'hash-b'));
  });
  // The end-to-end demonstration that a REAL bindingHash difference (a
  // different grammar, in practice) produces two coexisting shards for the
  // SAME blob sha is acceptance 4's own test below — the two criteria share
  // one mechanism.
});

// -----------------------------------------------------------------------------
// Acceptance 4 — grammar selection is PATH-derived, never content-sniffed.
// -----------------------------------------------------------------------------

describe('acceptance 4 — the same blob sha extracts under different grammars depending on the historical PATH', () => {
  it('src/stub/same.ts and src/stub/same.py share one blob sha but resolve typescript vs python, and both records coexist in the cache', async () => {
    const tsSha = shaFor('src/stub/same.ts');
    const pySha = shaFor('src/stub/same.py');
    expect(tsSha).toBe(pySha); // one blob, two paths (identical content)
    const sha = tsSha;
    const content = contentFor('src/stub/same.ts');

    const config = await defaultRootsConfig();
    const tsRecord = await extractBlobRecord('src/stub/same.ts', content, config);
    const pyRecord = await extractBlobRecord('src/stub/same.py', content, config);
    expect(tsRecord.skipped).toBe(false);
    expect(pyRecord.skipped).toBe(false);
    if (tsRecord.skipped || pyRecord.skipped) return; // narrow for TS

    // Different grammars, proven by the grammar-derived constant differing —
    // never by inspecting the (identical) source text itself.
    const tsVocab = (tsRecord.scopes[0] as unknown as { grammarNodeTypeVocabulary: string[] }).grammarNodeTypeVocabulary;
    const pyVocab = (pyRecord.scopes[0] as unknown as { grammarNodeTypeVocabulary: string[] }).grammarNodeTypeVocabulary;
    expect(tsVocab).not.toEqual(pyVocab);

    // Both keys coexist in a real cache.
    const cacheDir = await tmpCacheDir();
    try {
      const reader = makeBlobRecordReader(cacheDir, config);
      await reader(sha, 'src/stub/same.ts', content);
      await reader(sha, 'src/stub/same.py', content);
      const tsKey = expectedKeyFor('src/stub/same.ts', sha);
      const pyKey = expectedKeyFor('src/stub/same.py', sha);
      expect(tsKey).not.toBe(pyKey);
      expect(existsSync(shardPathFor(cacheDir, tsKey))).toBe(true);
      expect(existsSync(shardPathFor(cacheDir, pyKey))).toBe(true);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Acceptance 5 — the two oversize gates, both persisted, both "never parsed
// on any later run"; the 39,999-line control extracts normally.
// -----------------------------------------------------------------------------

describe('acceptance 5 — oversize (bytes) and oversize (line count), both recorded, never re-parsed', () => {
  it('a 2MB blob (over blobMaxBytes) records {skipped:true, reason:"oversize"} and is never parsed again', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => parses++);
      const sha = shaFor('src/oversize.ts');
      const content = contentFor('src/oversize.ts');
      expect(content.length).toBe(2_000_000);

      const first = await reader(sha, 'src/oversize.ts', content);
      expect(first).toEqual({ bytes: 2_000_000, skipped: true, reason: 'oversize' });
      expect(parses).toBe(1);

      const second = await reader(sha, 'src/oversize.ts', content);
      expect(second).toEqual(first);
      expect(parses).toBe(1); // never re-parsed
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('a blob of 40,001 one-character lines — well under blobMaxBytes — records the same oversize skip', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/toolong.ts', contentFor('src/toolong.ts'), config);
    expect(record.skipped).toBe(true);
    if (record.skipped) expect(record.reason).toBe('oversize');
  });

  it('a blob of 39,999 lines of the same shape extracts NORMALLY — the criterion is about the gate, not the fixture', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/justfits.ts', contentFor('src/justfits.ts'), config);
    expect(record.skipped).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 6 — D14's shard layout.
// -----------------------------------------------------------------------------

describe('acceptance 6 — shard layout: <cacheDir>/<key[0:2]>/<key>.json, one file per key', () => {
  it('lands the record at the D14 path, never an aggregate <prefix>.json', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      const sha = shaFor('src/svc/order.ts');
      await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));

      const key = expectedKeyFor('src/svc/order.ts', sha);
      const prefix = key.slice(0, 2);
      expect(existsSync(shardPathFor(cacheDir, key))).toBe(true);
      expect(existsSync(path.join(cacheDir, `${prefix}.json`))).toBe(false); // never the §13.2 aggregate form
      // One directory per 2-hex prefix — the prefix dir itself is a real directory.
      expect(readdirSync(path.join(cacheDir, prefix))).toContain(`${key}.json`);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Acceptance 7 — D17 gate 2, no-grammar half. Never touches the cache.
// -----------------------------------------------------------------------------

describe('acceptance 7 — a path with no registered grammar answers in memory, never touching the cache', () => {
  it.each([
    ['NOTES.md', 'docs/EMPTY.md'],
    ['yarn.lock', 'yarn.lock'],
    ['assets/pic.png', 'assets/pic.png'],
  ])('%s reads as {bytes:0, skipped:true, reason:"no-grammar"}', async (_label, relPath) => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord(relPath, contentFor(relPath), config);
    expect(record).toEqual({ bytes: 0, skipped: true, reason: 'no-grammar' });
  });

  it('leaves the cache directory byte-for-byte unchanged — no shard directory created, no file written', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      const sha = shaFor('NOTES.md');
      const record = await reader(sha, 'NOTES.md', contentFor('NOTES.md'));
      expect(record).toEqual({ bytes: 0, skipped: true, reason: 'no-grammar' });
      expect(everyShardFile(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Acceptance 8 — D17 gate 2, excluded half. Same untouched-cache contract.
// -----------------------------------------------------------------------------

describe('acceptance 8 — a registered-grammar path excluded by forParsing answers "excluded", never "no-grammar"', () => {
  it.each(['dist/index.js', 'vendor/lib.ts', 'src/types/api.d.ts', 'src/foo.test.ts'])(
    '%s reads as {bytes:0, skipped:true, reason:"excluded"} even though its extension IS registered',
    async (relPath) => {
      // Control: the extension alone would admit every one of these.
      expect(getGrammarForExtension(path.extname(relPath))).not.toBeNull();
      const config = await defaultRootsConfig();
      const record = await extractBlobRecord(relPath, contentFor(relPath), config);
      expect(record).toEqual({ bytes: 0, skipped: true, reason: 'excluded' });
    },
  );

  it('src/foo.ts (same extension, not excluded) extracts normally — the criterion is about the FILTER, not the fixture', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/foo.ts', contentFor('src/foo.ts'), config);
    expect(record.skipped).toBe(false);
  });

  it('leaves the cache directory byte-for-byte unchanged for an excluded path', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      const sha = shaFor('dist/index.js');
      await reader(sha, 'dist/index.js', contentFor('dist/index.js'));
      expect(everyShardFile(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Acceptance 9 — an empty blob is PARSED, not skipped; the same sha at a
// no-grammar path is the opposite verdict.
// -----------------------------------------------------------------------------

describe('acceptance 9 — an empty blob is parsed (one mandatory file scope), not skipped', () => {
  it('src/empty.ts extracts to {bytes:0, skipped:false, scopes:[<one file scope>]}', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/empty.ts', contentFor('src/empty.ts'), config);
    expect(record.skipped).toBe(false);
    if (!record.skipped) {
      expect(record.scopes.length).toBe(1);
      expect(record.scopes[0].kind).toBe('file');
    }
  });

  it('docs/EMPTY.md — the SAME blob sha as src/empty.ts — yields the no-grammar record instead: one sha, two opposite verdicts', async () => {
    expect(shaFor('src/empty.ts')).toBe(shaFor('docs/EMPTY.md')); // every empty file shares one blob sha
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('docs/EMPTY.md', contentFor('docs/EMPTY.md'), config);
    expect(record).toEqual({ bytes: 0, skipped: true, reason: 'no-grammar' });
  });
});

// -----------------------------------------------------------------------------
// F-1 — `bytes` (and the blobMaxBytes gate) is the RAW byte length before
// UTF-8 decoding, never the decoded character length. A pure-ASCII fixture
// cannot tell these apart, which is why the plan's own explicitly-stated rule
// (Interfaces block, Task 4) had no killer in the landed suite.
// -----------------------------------------------------------------------------

describe('F-1 — `bytes` is the RAW byte length, never the decoded character length', () => {
  it('an admitted record\'s `bytes` equals the raw byte length, not the decoded character length', async () => {
    const config = await defaultRootsConfig();
    const buf = contentFor('src/multi.ts');
    const decodedLen = buf.toString('utf-8').length;
    expect(buf.length).toBeGreaterThan(decodedLen); // the fixture really is multi-byte
    const record = await extractBlobRecord('src/multi.ts', buf, config);
    expect(record.skipped).toBe(false);
    expect(record.bytes).toBe(buf.length);
    expect(record.bytes).not.toBe(decodedLen);
  });

  it('the blobMaxBytes gate compares RAW bytes: over the cap in raw bytes but under it in decoded characters is still oversize', async () => {
    const cap = 30;
    const config = await defaultRootsConfig(`history:\n  blobMaxBytes: ${cap}\n`);
    expect(config.history.blobMaxBytes).toBe(cap);
    const buf = Buffer.from('中'.repeat(15), 'utf-8'); // 45 raw bytes, 15 decoded characters
    expect(buf.length).toBe(45);
    expect(buf.toString('utf-8').length).toBe(15);
    const record = await extractBlobRecord('src/notfetched.ts', buf, config);
    expect(record).toEqual({ bytes: 45, skipped: true, reason: 'oversize' });
  });
});

// -----------------------------------------------------------------------------
// F-2 — acceptance 8's final sentence: a path excluded only by the PROJECT's
// own configured `exclude` (not by BUILT_IN_EXCLUSIONS) is 'excluded' too,
// since `makeRootsFileFilters` merges the two lists (v6-spec.md:271).
// -----------------------------------------------------------------------------

describe('F-2 — a path excluded only by the configured `exclude` (not the built-in list) reads as "excluded"', () => {
  it('src/private/secret.ts is admitted under the default config but excluded once the project configures exclude: ["**/private/**"]', async () => {
    const dflt = await defaultRootsConfig();
    expect((await extractBlobRecord('src/private/secret.ts', contentFor('src/private/secret.ts'), dflt)).skipped).toBe(false);

    const config = await defaultRootsConfig('exclude: ["**/private/**"]\n');
    expect(config.exclude).toContain('**/private/**');
    const record = await extractBlobRecord('src/private/secret.ts', contentFor('src/private/secret.ts'), config);
    expect(record).toEqual({ bytes: 0, skipped: true, reason: 'excluded' });
  });
});

// -----------------------------------------------------------------------------
// F-3 — the `unparseable` degrade branch. A ~200,000-deep nested JSON blob
// blows the parser/extractor's recursive stack — no mock, no WASM
// manipulation — and reaches the recorded 'unparseable' skip (R4-I10).
// -----------------------------------------------------------------------------

describe('F-3 — a blob whose parse throws degrades to a RECORDED "unparseable" skip, and is never re-attempted', () => {
  it('src/deep.json (a ~200,000-deep nested blob) records {skipped:true, reason:"unparseable"} once, and the second call is a hit', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => parses++);
      const sha = shaFor('src/deep.json');
      const content = contentFor('src/deep.json');

      const first = await reader(sha, 'src/deep.json', content);
      expect(first).toEqual({ bytes: content.length, skipped: true, reason: 'unparseable' });
      expect(parses).toBe(1);

      const second = await reader(sha, 'src/deep.json', content);
      expect(second).toEqual(first);
      expect(parses).toBe(1); // recorded, not re-attempted
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('extractBlobRecord itself (no cache) records the same "unparseable" skip', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('src/deep.json', contentFor('src/deep.json'), config);
    expect(record.skipped).toBe(true);
    if (record.skipped) expect(record.reason).toBe('unparseable');
  }, 30_000);
});

// -----------------------------------------------------------------------------
// F-7 — D17 gate 2's stated half-order: `forParsing` first, THEN the
// registered-grammar lookup, so a path that is BOTH excluded AND grammarless
// reads as 'excluded', never 'no-grammar'. A fixture excluded by only ONE
// half cannot distinguish the order (acceptance 7/8's own fixtures each fail
// only one half); this one fails both, which is what makes the order visible.
// -----------------------------------------------------------------------------

describe('F-7 — gate 2 applies forParsing BEFORE the grammar lookup: a path failing both reads as "excluded", not "no-grammar"', () => {
  it('dist/notes.md (excluded by BUILT_IN_EXCLUSIONS AND unregistered .md) reads as "excluded"', async () => {
    const config = await defaultRootsConfig();
    const record = await extractBlobRecord('dist/notes.md', contentFor('dist/notes.md'), config);
    expect(record).toEqual({ bytes: 0, skipped: true, reason: 'excluded' });
  });
});

// -----------------------------------------------------------------------------
// Own tests, beyond the plan's named acceptance criteria — each pinning a
// rule D11/D14 states but no numbered acceptance criterion directly checks,
// and each proven load-bearing in the report's mutation round-trips.
// -----------------------------------------------------------------------------

describe('own: distinct blobs never collide on one cache key', () => {
  it('two different blobs under the SAME grammar get two different keys', () => {
    const bindingHashValue = bindingForAsset('typescript').hash;
    const keyA = blobCacheKey(shaFor('src/svc/order.ts'), EXTRACTOR_VERSION, bindingHashValue);
    const keyB = blobCacheKey(shaFor('src/foo.ts'), EXTRACTOR_VERSION, bindingHashValue);
    expect(keyA).not.toBe(keyB);
  });
});

describe('own: D11 cache economy — a persisted scope record never carries the two grammar constants', () => {
  it('the on-disk shard JSON contains no "grammarNodeTypeVocabulary" or "grammarHasDecoratorTypes" key', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      const sha = shaFor('src/svc/order.ts');
      await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));
      const key = expectedKeyFor('src/svc/order.ts', sha);
      const raw = readFileSync(shardPathFor(cacheDir, key), 'utf-8');
      expect(raw).not.toContain('grammarNodeTypeVocabulary');
      expect(raw).not.toContain('grammarHasDecoratorTypes');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('own: a corrupt shard reads as a miss and is re-extracted, without corrupting the response', () => {
  it('a shard whose JSON does not shape-match a BlobRecord is treated as absent', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const sha = shaFor('src/svc/order.ts');
      const key = expectedKeyFor('src/svc/order.ts', sha);
      const shardPath = shardPathFor(cacheDir, key);
      mkdirSync(path.dirname(shardPath), { recursive: true });
      writeFileSync(shardPath, JSON.stringify({ totally: 'unrelated', shape: true }), 'utf-8');

      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => parses++);
      const record: BlobRecord = await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));
      expect(record.skipped).toBe(false);
      expect(parses).toBe(1); // re-extracted, not swallowed
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('own: a shard shaped like a BlobRecord but carrying an impossible skip reason is corruption, read as a miss', () => {
  it('a skip record with a reason other than "oversize"/"unparseable" — never a value this module writes — is re-extracted', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const sha = shaFor('src/svc/order.ts');
      const key = expectedKeyFor('src/svc/order.ts', sha);
      const shardPath = shardPathFor(cacheDir, key);
      mkdirSync(path.dirname(shardPath), { recursive: true });
      writeFileSync(shardPath, JSON.stringify({ bytes: 1, skipped: true, reason: 'bogus' }), 'utf-8');

      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => parses++);
      const record = await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));
      expect(record.skipped).toBe(false); // this blob genuinely extracts fine — the corrupt shard is discarded, not trusted
      expect(parses).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('own: a shard shaped like a scope record but whose "scopes" is not an array is corruption, read as a miss', () => {
  it('re-extracts rather than trusting a malformed scopes field', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const sha = shaFor('src/svc/order.ts');
      const key = expectedKeyFor('src/svc/order.ts', sha);
      const shardPath = shardPathFor(cacheDir, key);
      mkdirSync(path.dirname(shardPath), { recursive: true });
      writeFileSync(shardPath, JSON.stringify({ bytes: 1, skipped: false, scopes: 'not-an-array' }), 'utf-8');

      let parses = 0;
      const reader = makeBlobRecordReader(cacheDir, config, () => parses++);
      const record = await reader(sha, 'src/svc/order.ts', contentFor('src/svc/order.ts'));
      expect(record.skipped).toBe(false);
      expect(parses).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('own: makeBlobRecordReader on a genuine miss with no content supplied is a caller-contract error, not a silent degrade', () => {
  it('throws rather than fabricating a record it would then wrongly persist', async () => {
    const cacheDir = await tmpCacheDir();
    try {
      const config = await defaultRootsConfig();
      const reader = makeBlobRecordReader(cacheDir, config);
      await expect(reader(shaFor('src/svc/order.ts'), 'src/svc/order.ts', undefined)).rejects.toThrow();
      expect(everyShardFile(cacheDir)).toEqual([]); // nothing fabricated, nothing written
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
