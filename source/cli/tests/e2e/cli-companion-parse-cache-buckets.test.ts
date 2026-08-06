// =============================================================================
// SHARED PARSE-CACHE BUCKETS — companion.mjs E2E, through the real dispatch path.
//
// The fill stage's per-(aspect, node) parse-cache bucketing (core/fill-parse-cache.ts,
// wired through core/fill-llm-phase.ts) shares ONE ParseCache across every subject of
// the same `per: file` rule on the same component, instead of building and destroying
// one per subject. That bucket holds native WebAssembly Tree objects, freed explicitly
// the moment the LAST pair sharing it settles (destroyParseCache). Freeing it early —
// while a sibling subject is still mid-flight — does not produce a wrong verdict; it
// frees memory out from under a live read, which is a process fault, not a bad answer.
//
// tests/integration/companion-shared-parse-cache.test.ts already proves the cache
// mechanics directly (parse counts collapsing, freshness across edits) by calling
// resolveCompanionsForPair itself — bypassing the bucketing layer entirely. NONE of
// that proves which pairs actually end up SHARING a bucket during a real `check
// --approve` dispatch, that a bucket is released only after its LAST member settles,
// or any of this under real concurrency (`parallel` > 1, where bucket members run on
// different pool workers at once). This suite closes that gap: every test here spawns
// the built binary and drives `check --approve` for real — the bucketing layer is
// never bypassed.
//
// The fixture `e2e-parse-cache-buckets` ships two independent (aspect, node) pairs:
//   - `reads-target`   on `alpha` (5 subjects), `uses`-related to `beta` (4 files)
//   - `reads-target-2` on `gamma` (4 subjects), `uses`-related to `delta` (3 files)
// gamma carries no `aspects:` attach by default — attachAspect() below adds it for the
// two-bucket test. Both companions are the SAME logic: walk every `uses` relation
// target, PARSE each of its files with ctx.parseAst (never a no-op — the returned
// label is pulled out of the parsed tree's own root text, not just file.content), and
// return one companion descriptor per target file. Every subject on the same node
// reaches the same target files, so the shared bucket is genuinely exercised: a
// premature release surfaces as `ctx.parseAst` throwing on a file whose cached tree was
// already deleted — a `structure-aspect-parseast-not-prewarmed` companion-runtime-error
// (pair left unverified), not silently wrong output.
//
// Reviewer: an in-process Ollama-protocol mock (support/mock-reviewer.ts), the same
// mechanism the rest of the LLM-companion e2e suite uses to avoid a real network call
// or API key — always satisfied, so every run here is a green/red question about the
// parse-cache plumbing, never about review judgment.
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, mutated in place, rmSync'd in
// finally. No fixed ports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readLockStore } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-parse-cache-buckets');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', n, 'yg-node.yaml');
const yggDir = (d: string) => path.join(d, '.yggdrasil');
const readLock = (d: string): Record<string, unknown> => readLockStore(yggDir(d)) as unknown as Record<string, unknown>;

const ALPHA_SUBJECTS = ['f1', 'f2', 'f3', 'f4', 'f5'] as const;
const GAMMA_SUBJECTS = ['n1', 'n2', 'n3', 'n4'] as const;
const UNIT_ALPHA = (name: string) => `file:src/alpha/${name}.ts`;
const UNIT_GAMMA = (name: string) => `file:src/gamma/${name}.ts`;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
/** Prepend a top-level `parallel: <n>` key so the LLM tier's worker pool runs up to n
 *  pairs concurrently — bucket members of the SAME (aspect, node) key really overlap. */
function setParallel(dir: string, n: number): void {
  const p = cfgPath(dir);
  writeFileSync(p, `parallel: ${n}\n${readFileSync(p, 'utf-8')}`, 'utf-8');
}
/** Attach the given aspect to gamma, which ships with no `aspects:` attach — this is
 *  what turns reads-target-2 from a dead, orphaned rule into a second live bucket. */
function attachAspect(dir: string, aspectId: string): void {
  const p = nodeYaml(dir, 'gamma');
  writeFileSync(p, `${readFileSync(p, 'utf-8')}aspects:\n  - ${aspectId}\n`, 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-parse-cache-buckets-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
type Verdicts = Record<string, Record<string, { hash: string; touched?: Array<[string, string]>; verdict: string; reason?: string }>>;
const verdicts = (d: string, aspectId: string): Verdicts[string] => (readLock(d).verdicts as Verdicts)[aspectId] ?? {};
const touchedKeys = (entry: { touched?: Array<[string, string]> }): string[] => (entry.touched ?? []).map(([k]) => k);

describe.skipIf(!distExists)('CLI E2E — shared parse-cache buckets across a companion rule\'s subjects', () => {
  // ===========================================================================
  // Several subjects, one component, one rule with a companion hook. alpha's 5
  // files all carry the reads-target aspect; its companion parses all 4 of beta's
  // files (ctx.parseAst) on every one of the 5 subjects — the textbook case the
  // bucket exists for. A first `check --approve` must record all 5 verdicts and
  // exit clean; a second, plain `check` must be a total no-op (zero reviewer
  // calls) that RE-VERIFIES every one of those pairs — which requires resolving
  // the companion live again (verify-lock's own §4 gate does this on every plain
  // check), so a corrupted or prematurely-freed tree from the first run would
  // have already surfaced as a non-zero exit before this second call ever runs.
  // ===========================================================================
  it('every subject of a per:file companion rule gets a verdict, and a second run re-verifies all of them for free', async () => {
    const dir = copyFixture('basic');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(5); // consensus 1 × 5 per:file subjects on alpha; gamma is unattached.

      const v = verdicts(dir, 'reads-target');
      expect(Object.keys(v).sort()).toEqual(ALPHA_SUBJECTS.map(UNIT_ALPHA).sort());
      for (const s of ALPHA_SUBJECTS) {
        expect(v[UNIT_ALPHA(s)].verdict).toBe('approved');
        // Every subject's companion read all four of beta's files — the shared
        // bucket's whole point: every one of the 5 subjects reaches the SAME
        // target files, so if a release freed them early, resolving the LATER
        // subjects would have thrown instead of recording a clean approval.
        const keys = touchedKeys(v[UNIT_ALPHA(s)]);
        for (const g of ['g1', 'g2', 'g3', 'g4']) expect(keys).toContain(`read:src/beta/${g}.ts`);
      }

      // Every prompt actually carries the parsed-tree-derived companion label —
      // proof the companion consumed the TREE (ctx.parseAst + tree.rootNode.text),
      // not merely file.content, and that the shared cache handed back a tree
      // whose text matches the real file for every one of the 5 subjects.
      for (const r of mock.chatRequests) {
        for (const g of ['g1', 'g2', 'g3', 'g4']) {
          expect(r.prompt).toContain(`<companion path="src/beta/${g}.ts" label="${g}">`);
        }
      }

      // A second, plain check is a no-op: zero reviewer calls, exit 0. Getting
      // here at all re-verified every companion-bearing pair (the §4 gate
      // resolves companions live on every plain check) — proof nothing the
      // first run wrote or cached was corrupted.
      const before = mock.chatCount();
      const second = run(['check'], dir);
      expect(second.status).toBe(0);
      expect(mock.chatCount() - before).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // The same rule and fixture, but with `parallel` raised so the pool actually
  // runs several of alpha's 5 subjects concurrently — bucket members genuinely
  // overlap in flight, not just adjacent in a sequential loop. The recorded
  // verdicts must be byte-identical to a SEQUENTIAL run of the same fixture: the
  // lock content must never depend on how many workers happened to run it.
  // ===========================================================================
  it('raising parallel so bucket members run concurrently yields verdicts identical to a sequential run', async () => {
    const seqDir = copyFixture('seq');
    const parDir = copyFixture('par');
    const seqMock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    const parMock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(seqDir, seqMock.endpoint); // default parallel (1) — strictly sequential.
      pointReviewer(parDir, parMock.endpoint);
      setParallel(parDir, 5); // >= subject count: every one of alpha's 5 subjects can be in flight at once.

      const [seqFill, parFill] = await Promise.all([
        runAsync(['check', '--approve'], seqDir),
        runAsync(['check', '--approve'], parDir),
      ]);
      expect(seqFill.status).toBe(0);
      expect(parFill.status).toBe(0);
      expect(seqMock.chatCount()).toBe(5);
      expect(parMock.chatCount()).toBe(5);

      const seqV = verdicts(seqDir, 'reads-target');
      const parV = verdicts(parDir, 'reads-target');
      expect(Object.keys(parV).sort()).toEqual(Object.keys(seqV).sort());
      for (const s of ALPHA_SUBJECTS) {
        // Byte-identical per-unit entry (hash, touched, verdict) regardless of
        // whether its bucket was consumed by one worker at a time or five at once.
        expect(JSON.stringify(parV[UNIT_ALPHA(s)])).toBe(JSON.stringify(seqV[UNIT_ALPHA(s)]));
      }

      // The parallel run also re-verifies clean on a second, plain check.
      const before = parMock.chatCount();
      expect(run(['check'], parDir).status).toBe(0);
      expect(parMock.chatCount() - before).toBe(0);
    } finally {
      await seqMock.close();
      await parMock.close();
      rmSync(seqDir, { recursive: true, force: true });
      rmSync(parDir, { recursive: true, force: true });
    }
  }, 60000);

  // ===========================================================================
  // Two rules, two components, interleaved. gamma gets reads-target-2 attached
  // (its own bucket, wholly unrelated node/target pair to alpha/beta's), so a
  // single `check --approve` run has TWO distinct (aspect, node) buckets alive
  // at the same time — both are built before either is dispatched (fill-llm-phase
  // builds every bucket for a tier's whole group up front), and under `parallel`
  // > 1 their members genuinely interleave on the worker pool. A release keyed to
  // the wrong bucket (e.g. a key collision, or decrementing/destroying the other
  // aspect's bucket) would corrupt or lose one side while leaving the other's
  // reviewer calls looking normal — asserting BOTH aspects' full verdict sets,
  // with the RIGHT companion files named in the RIGHT prompts, is what would catch
  // that a plain "some verdicts got written" check would miss.
  // ===========================================================================
  it('two independently attached companion rules on two unrelated components both verify in full, without cross-talk', async () => {
    const dir = copyFixture('interleaved');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      attachAspect(dir, 'reads-target-2');
      setParallel(dir, 4); // > 1, so alpha's and gamma's pairs genuinely interleave on the pool.

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(9); // alpha's 5 + gamma's 4.

      const alphaV = verdicts(dir, 'reads-target');
      expect(Object.keys(alphaV).sort()).toEqual(ALPHA_SUBJECTS.map(UNIT_ALPHA).sort());
      for (const s of ALPHA_SUBJECTS) {
        expect(alphaV[UNIT_ALPHA(s)].verdict).toBe('approved');
        const keys = touchedKeys(alphaV[UNIT_ALPHA(s)]);
        // alpha's bucket only ever reached beta's files — never delta's (gamma's
        // target). A bucket mix-up would leak the WRONG target's reads in here.
        for (const g of ['g1', 'g2', 'g3', 'g4']) expect(keys).toContain(`read:src/beta/${g}.ts`);
        for (const p of ['p1', 'p2', 'p3']) expect(keys).not.toContain(`read:src/delta/${p}.ts`);
      }

      const gammaV = verdicts(dir, 'reads-target-2');
      expect(Object.keys(gammaV).sort()).toEqual(GAMMA_SUBJECTS.map(UNIT_GAMMA).sort());
      for (const s of GAMMA_SUBJECTS) {
        expect(gammaV[UNIT_GAMMA(s)].verdict).toBe('approved');
        const keys = touchedKeys(gammaV[UNIT_GAMMA(s)]);
        // gamma's bucket only ever reached delta's files — never beta's (alpha's
        // target) — the same cross-talk check from the other side.
        for (const p of ['p1', 'p2', 'p3']) expect(keys).toContain(`read:src/delta/${p}.ts`);
        for (const g of ['g1', 'g2', 'g3', 'g4']) expect(keys).not.toContain(`read:src/beta/${g}.ts`);
      }

      // Prompts carry the RIGHT parsed-tree label for the RIGHT node's subjects —
      // an alpha prompt never carries a delta companion and vice versa.
      for (const r of mock.chatRequests) {
        const isAlpha = ALPHA_SUBJECTS.some((s) => r.prompt.includes(`<file path="src/alpha/${s}.ts">`));
        const isGamma = GAMMA_SUBJECTS.some((s) => r.prompt.includes(`<file path="src/gamma/${s}.ts">`));
        expect(isAlpha !== isGamma).toBe(true); // exactly one side matches.
        if (isAlpha) {
          for (const g of ['g1', 'g2', 'g3', 'g4']) expect(r.prompt).toContain(`<companion path="src/beta/${g}.ts" label="${g}">`);
          for (const p of ['p1', 'p2', 'p3']) expect(r.prompt).not.toContain(`<companion path="src/delta/${p}.ts"`);
        } else {
          for (const p of ['p1', 'p2', 'p3']) expect(r.prompt).toContain(`<companion path="src/delta/${p}.ts" label="${p}">`);
          for (const g of ['g1', 'g2', 'g3', 'g4']) expect(r.prompt).not.toContain(`<companion path="src/beta/${g}.ts"`);
        }
      }

      // Both aspects re-verify for free on a second, plain check.
      const before = mock.chatCount();
      const second = run(['check'], dir);
      expect(second.status).toBe(0);
      expect(mock.chatCount() - before).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
