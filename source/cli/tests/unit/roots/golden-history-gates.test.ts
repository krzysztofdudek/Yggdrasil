import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { buildHistoryJoin, blobCacheKey, type HistoryDeps } from '../../../src/roots/history.js';
import { EXTRACTOR_VERSION } from '../../../src/roots/extract.js';
import { getGrammarForExtension } from '../../../src/utils/language-registry.js';
import { assetNameOfWasmFile, bindingForAsset } from '../../../src/roots/binding.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import { buildGoldenRepo, type GoldenCommit, type GoldenRepoSpec } from '../../support/roots-golden.js';
import { deterministicCommitDateAt, runGitFixture } from '../../support/git-fixture.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-history-gates.test.ts — acceptance criterion 10's
// own killer test (R4 Task 8, D17): "D17's two gates, asserted at the only
// place gate 1 is applied." Kept as a sibling of golden-history.test.ts
// (never grown into it) purely to respect the prompt-headroom ceiling.
//
// Builds the history/ golden's own scripted spec PLUS five commits at day
// offsets 401-405 this file adds on top of it — never mutating the golden's
// own committed spec or bundle, a fresh in-memory extension built the same
// way every other golden already is, through `buildGoldenRepo`: a setup
// commit creating two brand-new files (one at a kept path, one at an
// excluded path); a five-file commit and a forty-two-file mega-commit, both
// touching the golden's already-supported order.ts/order.spec.ts pair
// alongside build output, node_modules and a .d.ts file; and the two rename
// directions D17 clause 1 disagrees on. Every blob sha this file asserts
// against is read straight off the built repository's own HEAD
// (`git rev-parse HEAD:<path>`), never hand-reconstructed from file
// content, so a fixture edit can never silently desync the expected shas
// from what git itself produced.
// ---------------------------------------------------------------------------

async function makeTempHistoryDeps(): Promise<{ deps: HistoryDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-golden-history-gates-'));
  return {
    deps: { cacheDir: path.join(dir, 'blobs'), stateDir: path.join(dir, 'history'), ledger: [], dirtyPaths: new Set() },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** `git rev-parse <rev>:<relPath>` — the built repository's own record of what blob sha lives at `relPath` at `rev`, so every sha this suite asserts against comes from git itself rather than a hand-reconstructed content hash. */
function blobShaAt(dir: string, rev: string, relPath: string): string {
  const r = runGitFixture(dir, ['rev-parse', `${rev}:${relPath}`]);
  if (r.status !== 0) {
    throw new Error(`git rev-parse ${rev}:${relPath} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
  return r.stdout.trim();
}

function blobShaAtHead(dir: string, relPath: string): string {
  return blobShaAt(dir, 'HEAD', relPath);
}

/** The real per-grammar cache key for `sha` under `ext`'s registered grammar — the same derivation `history.ts`'s own `blobCacheKey` uses, never a hand-typed key string (acceptance 8's own discipline, reused here for gate 2's mirror clause). */
function keyForExtension(ext: string, sha: string): string {
  const grammarInfo = getGrammarForExtension(ext);
  if (!grammarInfo) throw new Error(`no registered grammar for extension '${ext}'`);
  const { hash } = bindingForAsset(assetNameOfWasmFile(grammarInfo.wasmFile));
  return blobCacheKey(sha, EXTRACTOR_VERSION, hash);
}

const DIST_BUNDLE_CONTENT = 'console.log("built output");\n';
const NODE_MODULES_CONTENT = 'module.exports = {};\n';
const DTS_CONTENT = 'export declare const x: number;\n';

function orderSrcRev(rev: number): string {
  return ['export class Order {', '  first() {', `    return ${900 + rev};`, '  }', '  second() {', `    return ${910 + rev};`, '  }', '  third() {', `    return ${920 + rev};`, '  }', '}', ''].join('\n');
}

function orderSpecRev(rev: number): string {
  return [`// spec for order gate-1 probe, revision ${rev}`, `test('order gate-1 probe behaves', () => {`, '  expect(true).toBe(true);', '});', ''].join('\n');
}

/**
 * A ~20-line body whose ONE `edited` line changes when `edited` is true —
 * comfortably above git's default 50% rename-similarity threshold (`-M`),
 * so a `git mv` plus this one-line edit still emits a single scored `R`
 * record (a genuinely NEW post-image sha) rather than a `D`+`A` pair (a pure
 * `git mv` with no edit emits `R100` — pre/post shas IDENTICAL — which would
 * make "the new post-image sha is absent from the roster" assert nothing;
 * see D17's own acceptance-10 text).
 */
function twentyLineBody(fnName: string, edited: boolean): string {
  const lines: string[] = [`export function ${fnName}() {`, `  const tag = '${edited ? 'moved' : 'orig'}';`];
  for (let i = 0; i < 17; i++) lines.push(`  const filler${i} = ${i};`);
  lines.push('  return tag;', '}', '');
  return lines.join('\n');
}

function megaCommitFiles(rev: number): Record<string, string> {
  const files: Record<string, string> = {
    'src/svc/order.ts': orderSrcRev(rev),
    'test/order.spec.ts': orderSpecRev(rev),
  };
  for (let i = 0; i < 40; i++) files[`dist/junk${i}.js`] = `console.log(${i});\n`;
  return files;
}

function buildGate1ProbeSpec(): GoldenRepoSpec {
  const base = buildHistoryGoldenSpec();
  const extra: GoldenCommit[] = [
    {
      author: 'alice',
      dayOffset: 401,
      message: 'setup: seed the rename-probe files (D17 gate 1, both directions)',
      files: {
        'src/mover.ts': twentyLineBody('moveMe', false),
        'dist/legacy.js': twentyLineBody('legacyFn', false),
      },
    },
    {
      author: 'alice',
      dayOffset: 402,
      message: 'chore: gate-1 probe (five-file commit: 3 excluded + the order pair)',
      files: {
        'dist/bundle.js': DIST_BUNDLE_CONTENT,
        'node_modules/pkg/index.js': NODE_MODULES_CONTENT,
        'src/generated/api.d.ts': DTS_CONTENT,
        'src/svc/order.ts': orderSrcRev(10),
        'test/order.spec.ts': orderSpecRev(10),
      },
    },
    {
      author: 'alice',
      dayOffset: 403,
      message: 'chore: gate-1 probe (forty-two-file mega-commit: 40 dist files + the order pair)',
      files: megaCommitFiles(11),
    },
    {
      author: 'alice',
      dayOffset: 404,
      message: 'refactor: rename src/mover.ts into vendor/ (excluded post-image)',
      renames: [{ from: 'src/mover.ts', to: 'vendor/mover.ts' }],
      files: { 'vendor/mover.ts': twentyLineBody('moveMe', true) },
    },
    {
      author: 'alice',
      dayOffset: 405,
      message: 'refactor: rename dist/legacy.js out of dist/ (excluded pre-image)',
      renames: [{ from: 'dist/legacy.js', to: 'src/legacy.js' }],
      files: { 'src/legacy.js': twentyLineBody('legacyFn', true) },
    },
  ];
  return { name: 'history-gate1-probe', commits: [...base.commits, ...extra] };
}

describe("history/ golden — acceptance 10: D17's two gates, asserted at the only place gate 1 is applied", () => {
  it('unmutated golden (no appended commits): support(order.ts, order.spec.ts) = 9, confidence 1.0 — the baseline this criterion moves from', async () => {
    const config = await defaultRootsConfig();
    const dir = buildGoldenRepo(buildHistoryGoldenSpec());
    const { deps, cleanup } = await makeTempHistoryDeps();
    try {
      const join = await buildHistoryJoin(dir, config, deps);
      expect(join).toBeDefined();
      if (!join) return;
      const pair = join.cochange.find((p) => p.a === 'src/svc/order.ts' && p.b === 'test/order.spec.ts');
      expect(pair).toBeDefined();
      expect(pair?.sup).toBe(9);
      expect(pair?.conf).toBeCloseTo(1.0, 10);

      // Gate 2's mirror image on the PRISTINE golden (D17 clause 2): both
      // blobs are rostered (the commits touching them are counted, and
      // their shas enter blobShas), but neither ever enters parsedKeys —
      // NOTES.md has no registered grammar, and order.spec.ts's `.ts`
      // extension does but forParsing's own test-pattern carve-out excludes
      // it before a key is ever derived.
      const notesSha = blobShaAtHead(dir, 'NOTES.md');
      const specSha = blobShaAtHead(dir, 'test/order.spec.ts');
      expect(join.blobShas.has(notesSha)).toBe(true);
      expect(join.blobShas.has(specSha)).toBe(true);
      expect(join.parsedKeys.has(keyForExtension('.ts', specSha))).toBe(false);
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate 1 applied once: excluded trio absent from every roster and lifecycle row, the order pair support rises to 11, and both rename directions disagree exactly as D17 clause 1 predicts', async () => {
    const config = await defaultRootsConfig();
    const dir = buildGoldenRepo(buildGate1ProbeSpec());
    const { deps, cleanup } = await makeTempHistoryDeps();
    try {
      const join = await buildHistoryJoin(dir, config, deps);
      expect(join).toBeDefined();
      if (!join) return;

      // --- co-change: the order pair's support rises from 9 to 11 (the
      // five-file commit and the mega-commit each contribute one qualifying
      // commit once the 3 excluded files are dropped BEFORE the changed-
      // file band is measured — deleting the gate-1 filter, or moving it
      // after the band is measured, both collapse this back to 10 (the
      // forty-file mega-commit reverts to reading as a genuine mega-commit
      // and contributes nothing).
      const pair = join.cochange.find((p) => p.a === 'src/svc/order.ts' && p.b === 'test/order.spec.ts');
      expect(pair).toBeDefined();
      expect(pair?.sup).toBe(11);
      expect(pair?.conf).toBeCloseTo(1.0, 10);

      // --- the excluded trio: absent from both rosters and from every
      // lifecycle row, at either level, even though all three still exist
      // (unmodified) at HEAD.
      const distBundleSha = blobShaAtHead(dir, 'dist/bundle.js');
      const nodeModulesSha = blobShaAtHead(dir, 'node_modules/pkg/index.js');
      const dtsSha = blobShaAtHead(dir, 'src/generated/api.d.ts');
      for (const sha of [distBundleSha, nodeModulesSha, dtsSha]) {
        expect(join.blobShas.has(sha)).toBe(false);
      }
      for (const relPath of ['dist/bundle.js', 'node_modules/pkg/index.js', 'src/generated/api.d.ts']) {
        expect(join.lifecycle.some((r) => r.key === relPath || r.key.startsWith(`${relPath}#`))).toBe(false);
      }

      // --- rename INTO vendor/ (excluded post-image): dropped WHOLE at
      // gate 1 — no alias edge, no lifecycle row under the new path, its
      // post-image sha never enters blobShas, and the OLD path's rows are
      // frozen at their day-401 creation timestamp (day 404's rename never
      // touches them, because gate 1 drops that whole record before the
      // replay or the blob roster ever see it).
      const day401Ts = Math.floor(Date.parse(deterministicCommitDateAt(401)) / 1000);
      const moverPostSha = blobShaAtHead(dir, 'vendor/mover.ts');
      expect(join.blobShas.has(moverPostSha)).toBe(false);
      expect(join.aliases.some(([from]) => from === 'src/mover.ts')).toBe(false);
      expect(join.lifecycle.some((r) => r.key === 'vendor/mover.ts' || r.key.startsWith('vendor/mover.ts#'))).toBe(false);
      const moverRows = join.lifecycle.filter((r) => r.key === 'src/mover.ts' || r.key.startsWith('src/mover.ts#'));
      expect(moverRows.length).toBeGreaterThan(0);
      for (const row of moverRows) expect(row.lastModifiedTs).toBe(day401Ts);

      // --- rename OUT of dist/ (excluded pre-image): survives on its NEW
      // path (gate 1 reads only the post-image path), its post-image sha
      // enters blobShas, and nothing is ever recorded under the old dist/
      // path.
      const legacyPostSha = blobShaAtHead(dir, 'src/legacy.js');
      expect(join.blobShas.has(legacyPostSha)).toBe(true);
      expect(join.lifecycle.some((r) => r.key === 'src/legacy.js' || r.key.startsWith('src/legacy.js#'))).toBe(true);
      expect(join.lifecycle.some((r) => r.key === 'dist/legacy.js' || r.key.startsWith('dist/legacy.js#'))).toBe(false);

      // The rename's PRE-image keeps its OLD path's gate-2 verdict: each
      // sha takes the grammar and gate decision of its OWN path, and the
      // pre-image lived at dist/legacy.js — so its blob is rostered in
      // blobShas but never keyed, probed, fetched or cached. Reading the
      // pre-image under the NEW path instead would key an excluded path's
      // blob into parsedKeys (and, downstream, record the post-image's
      // scopes as continuations of a blob that was never admitted, instead
      // of introductions).
      const legacyPreSha = blobShaAt(dir, 'HEAD~1', 'dist/legacy.js');
      expect(join.blobShas.has(legacyPreSha)).toBe(true);
      expect(join.parsedKeys.has(keyForExtension('.js', legacyPreSha))).toBe(false);

      // D17 clause 1's counting rule: a commit is walked and counted even
      // when every one of its records is filtered away — the day-404
      // rename-into-vendor/ commit is exactly that (its single record's
      // post-image path fails gate 1), yet it still counts. 25 golden
      // commits + the 5 this suite appends = 30; counting only commits
      // with a surviving record would read 29.
      expect(join.historyStats.commits).toBe(30);
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
