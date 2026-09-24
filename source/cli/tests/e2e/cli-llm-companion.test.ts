// =============================================================================
// PER-UNIT COMPANION FILES — happy-path E2E (plan §11.2 cli-llm-companion).
//
// Real spawned binary + in-process Ollama-protocol mock reviewer (runAsync, never
// spawnSync while the mock serves). The fixture `e2e-companion` maps a `docs`
// catalogue of scenario .md files (each with `---` frontmatter naming its paired
// Playwright spec) and a `tooling` node owning the .spec.ts files; the LLM aspect
// `scenario-matches-test` ships a companion.mjs that resolves each scenario's ONE
// paired spec via ctx.fs.read — so a unit's `touched` is exactly `read:<its-spec>`.
//
// Covered (cases 1–11 + critic additions):
//   1  per-unit prompt isolation (each prompt carries its OWN scenario + its OWN
//      paired spec in a <companions> block, and NOT other pairs)
//   2  N file: lock entries each carry `touched` with `read:<spec>`
//   3  single-spec edit re-bills ONLY its pair (chatCount delta = 1; siblings
//      byte-identical)
//   4  single-scenario (subject) edit re-bills only its pair
//   5  cross-pair isolation (an edit names only the affected unit)
//   6  content.md edit re-bills ALL pairs (ruleHash)
//   7  companion.mjs edit re-bills ALL pairs (companionHash)
//   8  clean `yg check` (no --approve) makes ZERO reviewer calls
//   9  []-resolving companion → NO <companions> block (but companionHash folds)
//   10 multiple companions → all present in the prompt
//   11 per:node companion (fan-in: one unit, union of paired specs; ordering
//      determinism; multi-touched invalidation)
//   +  GC of a touched-bearing LLM entry on aspect detach
//   +  relation-removal → infra-fail (out-of-reach companion read) vs GC-prune
//   +  lock-merge carry-forward of a touched+companionHash entry
//   +  companion==subject dedupe (returned subject path dropped, no <companions>,
//      no extra touched, and verdicts re-validate on a clean check at zero cost)
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, mutated in place, rmSync'd
// in finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readLockStore } from './support/read-lock.js';
import { LOCK_NONDET_FILE_NAME } from './support/read-lock.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-companion');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectDir = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a);
// The 5.1.0 lock is a three-file triad; the unified view is produced by the src
// store's readLock over the project's .yggdrasil dir. The companion aspects under
// test are all LLM aspects, so their verdicts are persisted in the committed
// nondeterministic file (the one readLock parses for LLM verdicts).
const yggDir = (d: string) => path.join(d, '.yggdrasil');
const nondetLockPath = (d: string) => path.join(yggDir(d), LOCK_NONDET_FILE_NAME);
const readLock = (d: string): Record<string, unknown> =>
  readLockStore(yggDir(d)) as unknown as Record<string, unknown>;
const scenarioMd = (d: string, name: string) => path.join(d, 'references', 'e2e-test-scenarios', name);
const specTs = (d: string, name: string) => path.join(d, 'apps', 'e2e', 'tests', name);

const SCENARIOS = ['checkout', 'login', 'search'] as const;
const UNIT = (name: string) => `file:references/e2e-test-scenarios/${name}.md`;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-companion-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
/** Swap the docs node's single attached aspect to a variant in the fixture. */
function useAspect(dir: string, aspectId: string): void {
  const p = nodeYaml(dir, 'scenarios');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/- scenario-matches-test\b/, `- ${aspectId}`), 'utf-8');
}
type Verdicts = Record<string, Record<string, { hash: string; touched?: Array<[string, string]>; verdict: string }>>;
const verdicts = (d: string, aspectId: string): Verdicts[string] =>
  (readLock(d).verdicts as Verdicts)[aspectId] ?? {};
const touchedKeys = (entry: { touched?: Array<[string, string]> }): string[] => (entry.touched ?? []).map(([k]) => k);

describe.skipIf(!distExists)('CLI E2E — per-unit companion files (happy path)', () => {
  // ===========================================================================
  // (1) PER-UNIT PROMPT ISOLATION + (2) touched read:<spec> per file entry.
  //   Fill → one prompt per scenario (3 chat calls). Each prompt carries exactly
  //   its OWN scenario subject AND its OWN paired spec in a <companions> block,
  //   and NOT another pair's scenario/spec. Each file: lock entry carries
  //   `touched` = [read:<its own spec>] only.
  // ===========================================================================
  it('(1+2) each prompt carries only its own scenario+spec; each entry has touched read:<its spec>', async () => {
    const dir = copyFixture('isolation');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(3); // consensus 1 × 3 per:file units.

      // Map each captured prompt to the scenario it reviews (by subject body).
      const byScenario = new Map<string, string>();
      for (const r of mock.chatRequests) {
        for (const s of SCENARIOS) {
          // The scenario .md title line is unique per scenario; the subject body
          // appears in <source-files>.
          if (r.prompt.includes(`# ${cap(s)}`) && r.prompt.includes('<source-files>')) {
            // Disambiguate by the frontmatter test name which is unique.
            if (r.prompt.includes(`test: ${s}.spec.ts`)) byScenario.set(s, r.prompt);
          }
        }
      }
      expect([...byScenario.keys()].sort()).toEqual([...SCENARIOS].sort());

      for (const s of SCENARIOS) {
        const prompt = byScenario.get(s)!;
        // Has a <companions> block carrying THIS scenario's paired spec.
        expect(prompt).toContain('<companions>');
        expect(prompt).toContain(`<companion path="apps/e2e/tests/${s}.spec.ts"`);
        // Does NOT carry another pair's spec as a companion.
        for (const other of SCENARIOS) {
          if (other === s) continue;
          expect(prompt).not.toContain(`<companion path="apps/e2e/tests/${other}.spec.ts"`);
          // And does NOT carry another scenario's subject body in <source-files>.
          expect(prompt).not.toContain(`test: ${other}.spec.ts`);
        }
      }

      // Each file: entry carries touched = exactly [read:<its own spec>].
      const v = verdicts(dir, 'scenario-matches-test');
      expect(Object.keys(v).sort()).toEqual(SCENARIOS.map((s) => UNIT(s)).sort());
      for (const s of SCENARIOS) {
        expect(touchedKeys(v[UNIT(s)])).toEqual([`read:apps/e2e/tests/${s}.spec.ts`]);
        expect(v[UNIT(s)].verdict).toBe('approved');
      }
      // (8) A clean check makes ZERO reviewer calls and stays green.
      const before = mock.chatCount();
      expect(run(['check'], dir).status).toBe(0);
      expect(mock.chatCount() - before).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (3+5) SINGLE-SPEC EDIT re-bills ONLY its pair (chat delta 1); siblings carry
  //   forward byte-identical and are never named unverified.
  // ===========================================================================
  it('(3+5) editing one companion spec re-bills only its pair; siblings byte-identical', async () => {
    const dir = copyFixture('spec-edit');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      const before = verdicts(dir, 'scenario-matches-test');
      const loginBefore = JSON.stringify(before[UNIT('login')]);
      const searchBefore = JSON.stringify(before[UNIT('search')]);

      // Edit ONLY checkout.spec.ts (a companion of the checkout pair).
      appendFileSync(specTs(dir, 'checkout.spec.ts'), '\n// edited companion\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // Grouped view: the unverified group fires for this aspect with EXACTLY one
      // pair (only checkout's pair invalidated; the sibling specs are untouched and
      // never enter the group). The per-unit `what` (`No valid verdict … on file:…`)
      // is no longer rendered; the chatCount delta + byte-identical siblings below
      // pin down WHICH pair re-billed.
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("1 pair  ");
      expect(after.all).toContain("aspect 'scenario-matches-test'");
      expect(after.all).toContain('- scenarios');
      expect(after.all).toContain('Fix: yg check --approve');

      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1); // only checkout re-reviewed.

      const refilled = verdicts(dir, 'scenario-matches-test');
      expect(JSON.stringify(refilled[UNIT('login')])).toBe(loginBefore);
      expect(JSON.stringify(refilled[UNIT('search')])).toBe(searchBefore);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (4) SINGLE-SCENARIO (subject) edit re-bills only its pair.
  // ===========================================================================
  it('(4) editing one scenario subject re-bills only that pair', async () => {
    const dir = copyFixture('scenario-edit');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      const before = verdicts(dir, 'scenario-matches-test');
      const loginBefore = JSON.stringify(before[UNIT('login')]);

      // Edit the login scenario BODY (keep its frontmatter intact so the same
      // spec still resolves) → only the login pair's subject hash changes.
      appendFileSync(scenarioMd(dir, 'login.md'), '\nExtra clarification step.\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // Only the login pair's subject hash changed → exactly one pair unverified.
      // The grouped view no longer prints the per-unit subject path; the chatCount
      // delta (1) below confirms only the login pair re-billed.
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("1 pair  ");
      expect(after.all).toContain("aspect 'scenario-matches-test'");
      expect(after.all).toContain('- scenarios');

      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1);

      // The re-reviewed entry differs from before (subject changed).
      expect(JSON.stringify(verdicts(dir, 'scenario-matches-test')[UNIT('login')])).not.toBe(loginBefore);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (6) content.md edit re-bills ALL pairs (ruleHash invalidation).
  // ===========================================================================
  it('(6) editing the aspect content.md re-bills every pair', async () => {
    const dir = copyFixture('content-edit');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      appendFileSync(path.join(aspectDir(dir, 'scenario-matches-test'), 'content.md'), '\nAlso check the scenario names a real spec.\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // content.md edit invalidates ALL three file pairs → unverified group shows
      // 3 pairs (the per-unit subject paths are no longer rendered; the 3-pair
      // count is the surviving signal that every pair re-billed).
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("3 pairs");
      expect(after.all).toContain("aspect 'scenario-matches-test'");

      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(3); // all three re-reviewed.
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (7) companion.mjs edit re-bills ALL pairs (companionHash invalidation), even
  //   though the resolved companion FILES are unchanged.
  // ===========================================================================
  it('(7) editing companion.mjs re-bills every pair (companionHash)', async () => {
    const dir = copyFixture('hook-edit');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      // A comment-only edit to the hook still changes companionHash → all pairs
      // invalidate (the hook bytes are a verdict input independent of what it
      // resolved). This is NOT a laundering edit to a content rule — it is the
      // documented companionHash behavior under test.
      appendFileSync(path.join(aspectDir(dir, 'scenario-matches-test'), 'companion.mjs'), '\n// hook revision marker\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // companion.mjs edit folds into companionHash → ALL three pairs invalidate
      // (unverified group shows 3 pairs).
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("3 pairs");
      expect(after.all).toContain("aspect 'scenario-matches-test'");

      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(3);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (9) []-RESOLVING companion → NO <companions> block, but companionHash folds.
  //   The empty-companion aspect ships a hook that returns []. The prompt has no
  //   <companions> block; the entry carries no `touched`; editing companion.mjs
  //   STILL re-bills (companionHash).
  // ===========================================================================
  it('(9) []-resolving companion: no <companions> block, no touched, but companion.mjs edit re-bills', async () => {
    const dir = copyFixture('empty');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      useAspect(dir, 'empty-companion');
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount()).toBe(3);

      // No companion was injected: assert the absence of an actual <companion …>
      // ENTRY (the block markup). The bare token "<companions>" can appear inside
      // the aspect's own content.md prose, so we key off the entry tag instead.
      for (const r of mock.chatRequests) expect(r.prompt).not.toContain('<companion path=');
      const v = verdicts(dir, 'empty-companion');
      for (const s of SCENARIOS) {
        expect(v[UNIT(s)]).toBeDefined();
        expect(v[UNIT(s)].touched ?? []).toEqual([]); // no out-of-subject reads.
      }

      // companion.mjs edit STILL invalidates every pair via companionHash.
      appendFileSync(path.join(aspectDir(dir, 'empty-companion'), 'companion.mjs'), '\n// revision\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // companion.mjs edit folds into companionHash → ALL three pairs invalidate
      // (unverified group shows 3 pairs for the empty-companion aspect).
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("3 pairs");
      expect(after.all).toContain("aspect 'empty-companion'");
      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(3);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (10) MULTIPLE companions → all present in each prompt (multi-return hook).
  //   editing ANY one resolved spec re-bills the pair that read it.
  // ===========================================================================
  it('(10) multi-return companion: every spec appears in each prompt', async () => {
    const dir = copyFixture('multi');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      useAspect(dir, 'multi-companion');
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount()).toBe(3);

      // Every prompt MUST carry a <companions> block — the multi-companion hook
      // returns 3 companions for every unit, so any missing block is a defect.
      for (const r of mock.chatRequests) expect(r.prompt).toContain('<companions>');

      // Every prompt carries ALL three specs as companions, path-sorted.
      for (const r of mock.chatRequests) {
        if (!r.prompt.includes('<companions>')) continue;
        const idxCheckout = r.prompt.indexOf('<companion path="apps/e2e/tests/checkout.spec.ts"');
        const idxLogin = r.prompt.indexOf('<companion path="apps/e2e/tests/login.spec.ts"');
        const idxSearch = r.prompt.indexOf('<companion path="apps/e2e/tests/search.spec.ts"');
        expect(idxCheckout).toBeGreaterThanOrEqual(0);
        expect(idxLogin).toBeGreaterThanOrEqual(0);
        expect(idxSearch).toBeGreaterThanOrEqual(0);
        // Deterministic path-sorted order: checkout < login < search.
        expect(idxCheckout).toBeLessThan(idxLogin);
        expect(idxLogin).toBeLessThan(idxSearch);
      }

      // Each unit's touched holds read: for all three specs (multi fan-out).
      const v = verdicts(dir, 'multi-companion');
      for (const s of SCENARIOS) {
        const keys = touchedKeys(v[UNIT(s)]);
        for (const spec of SCENARIOS) expect(keys).toContain(`read:apps/e2e/tests/${spec}.spec.ts`);
      }
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (11) PER:NODE companion fan-in: one node: unit, union of all paired specs in
  //   ONE prompt; deterministic ordering; editing any one spec invalidates the
  //   single node unit.
  // ===========================================================================
  it('(11) per:node companion: single unit, all paired specs in one prompt; ordering deterministic', async () => {
    const dir = copyFixture('pernode');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      useAspect(dir, 'per-node-companion');
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount()).toBe(1); // ONE node: unit.

      const v = verdicts(dir, 'per-node-companion');
      expect(Object.keys(v)).toEqual(['node:scenarios']);
      const keys = touchedKeys(v['node:scenarios']);
      for (const s of SCENARIOS) expect(keys).toContain(`read:apps/e2e/tests/${s}.spec.ts`);

      const prompt = mock.chatRequests[0].prompt;
      const idxCheckout = prompt.indexOf('<companion path="apps/e2e/tests/checkout.spec.ts"');
      const idxLogin = prompt.indexOf('<companion path="apps/e2e/tests/login.spec.ts"');
      const idxSearch = prompt.indexOf('<companion path="apps/e2e/tests/search.spec.ts"');
      expect(idxCheckout).toBeGreaterThanOrEqual(0);
      expect(idxCheckout).toBeLessThan(idxLogin);
      expect(idxLogin).toBeLessThan(idxSearch);

      // Editing ANY one paired spec invalidates the single node unit.
      appendFileSync(specTs(dir, 'search.spec.ts'), '\n// edited\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // The single per:node unit invalidates → unverified group shows 1 pair for
      // the per-node-companion aspect on the scenarios node (the per-unit
      // `on node:scenarios.` detail is no longer rendered in the grouped view).
      expect(after.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(after.all).toContain("1 pair  ");
      expect(after.all).toContain("aspect 'per-node-companion'");
      expect(after.all).toContain('- scenarios');
      const callsBefore = mock.chatCount();
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (+) companion==subject DEDUPE: the self-companion hook returns the subject's
  //   OWN path. It is dropped (not injected, not recorded), so no <companions>
  //   block, no extra touched, and the verdict reads back valid on a clean check.
  // ===========================================================================
  it('(+) companion==subject is deduped: no <companions> block, no touched read of the subject', async () => {
    const dir = copyFixture('self');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      useAspect(dir, 'self-companion');
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      // The returned subject path is deduped → no companion ENTRY is injected.
      // (Key off the entry tag, not the bare token, which the content.md mentions.)
      for (const r of mock.chatRequests) expect(r.prompt).not.toContain('<companion path=');
      const v = verdicts(dir, 'self-companion');
      for (const s of SCENARIOS) {
        // The returned subject path is deduped → no read:<subject> observation.
        expect(touchedKeys(v[UNIT(s)])).not.toContain(`read:references/e2e-test-scenarios/${s}.md`);
        expect(v[UNIT(s)].touched ?? []).toEqual([]);
      }
      // Verdicts read back valid with ZERO reviewer calls: no <companion path=
      // in any prompt, no extra touched keys, so the stored hashes match.
      const before = mock.chatCount();
      expect(run(['check'], dir).status).toBe(0);
      expect(mock.chatCount() - before).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (+) GC of a touched-bearing LLM entry on aspect DETACH. Fill, then detach the
  //   companion aspect from the node (remove the attach) → garbage-collection
  //   prunes the now-unexpected entries from the lock.
  // ===========================================================================
  it('(+) detaching the companion aspect garbage-collects its touched-bearing entries', async () => {
    const dir = copyFixture('gc-detach');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      // Sanity: the entries (with touched) exist.
      expect(Object.keys(verdicts(dir, 'scenario-matches-test')).length).toBe(3);
      expect(touchedKeys(verdicts(dir, 'scenario-matches-test')[UNIT('checkout')]).length).toBeGreaterThan(0);

      // Detach the aspect from the node (remove the `aspects:` attach). With no
      // attach and no other channel, the aspect is no longer effective anywhere.
      const p = nodeYaml(dir, 'scenarios');
      writeFileSync(p, readFileSync(p, 'utf-8').replace(/\naspects:\n {2}- scenario-matches-test\n?/, '\n'), 'utf-8');

      // A fill re-canonicalizes the lock; the unexpected entries are GC'd.
      const callsBefore = mock.chatCount();
      const after = await runAsync(['check', '--approve'], dir);
      expect(after.status).toBe(0);
      // No reviewer calls (nothing expected to fill), and the aspect's verdicts
      // are gone from the lock.
      expect(mock.chatCount() - callsBefore).toBe(0);
      const v = (readLock(dir).verdicts as Verdicts)['scenario-matches-test'];
      expect(v).toBeUndefined();
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (+) RELATION REMOVAL → infra-fail (the companion read is now out-of-reach).
  //   With the `uses` relation removed, ctx.fs.read of the spec throws an
  //   undeclared-read error → companion assembly fails closed: the pair is left
  //   unverified (nothing written), check stays red. This is distinct from a GC
  //   prune (the pair is STILL expected — only assembly fails).
  // ===========================================================================
  it('(+) removing the uses relation makes the companion read out-of-reach → infra-fail (pair unverified)', async () => {
    const dir = copyFixture('rel-remove');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      // Remove the `uses` relation to the spec node (the read is now unauthorized).
      const p = nodeYaml(dir, 'scenarios');
      writeFileSync(p, readFileSync(p, 'utf-8').replace(/relations:\n {2}- target: specs\n {4}type: uses\n/, ''), 'utf-8');

      // The companion-file content is also changed so the existing verdicts go
      // unverified and a re-fill is attempted (which then fails to assemble).
      appendFileSync(specTs(dir, 'checkout.spec.ts'), '\n// edited\n');

      const refill = await runAsync(['check', '--approve'], dir);
      // Fill cannot assemble the companion (out-of-reach) → infra-fail:
      // nothing written for that pair, exit 1.
      expect(refill.status).toBe(1);
      // Since v5.2.0 the §4 gate is unconditional (omitted max_prompt_chars → 50000),
      // so plain `yg check` resolves the companion LIVE to size the gate for EVERY unit
      // (not only the one whose verdict was invalidated). An out-of-reach companion read
      // surfaces as a blocking aspect-companion-runtime-error naming the undeclared path
      // and the relation fix — replacing the generic per-unit "No valid verdict".
      // A plain check executes no repository code: it reports the invalidated pair
      // unverified with its companion not run. The undeclared read and its relation
      // fix are named by the run that executes the hook, --approve.
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('companion.mjs was not run');
      expect(after.all).toContain('- scenarios');
      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('aspect-companion-runtime-error');
      expect(approve.all).toContain('undeclared read is an infrastructure fault, not a code violation');
      expect(approve.all).toContain('Declare a relation in yg-node.yaml to the node owning that path');
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (+) LOCK-MERGE carry-forward of a touched+companionHash entry. Take one side
  //   wholesale (missing one pair) → only the missing companion pair is
  //   re-reviewed; the kept touched-bearing entry carries forward byte-identical.
  // ===========================================================================
  it('(+) lock-merge take-a-side: missing companion pair re-reviewed; kept touched entry byte-identical', async () => {
    const dir = copyFixture('merge');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      const lockBefore = readLock(dir);
      const keptEntry = JSON.stringify((lockBefore.verdicts as Verdicts)['scenario-matches-test'][UNIT('login')]);

      // Simulate "git checkout --ours": a side that is MISSING the checkout pair.
      // The companion aspect is an LLM aspect, so its verdicts live in the committed
      // nondeterministic file — seed the take-a-side state THERE (the `nodes` section
      // is owned by the logs file, so the nondet file's `nodes` is left empty).
      const sideA = JSON.parse(JSON.stringify(lockBefore));
      delete (sideA.verdicts as Verdicts)['scenario-matches-test'][UNIT('checkout')];
      writeFileSync(
        nondetLockPath(dir),
        JSON.stringify({ version: sideA.version, verdicts: sideA.verdicts, nodes: {} }, null, 2) + '\n',
        'utf-8',
      );

      // The missing pair surfaces as unverified — exactly one pair (only the
      // checkout pair was dropped from the take-a-side state). The chatCount delta
      // (1) below confirms only the missing pair re-reviewed.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(check.all).toContain("1 pair  ");
      expect(check.all).toContain("aspect 'scenario-matches-test'");
      expect(check.all).toContain('- scenarios');

      const callsBefore = mock.chatCount();
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1); // ONLY the missing pair.

      // The kept touched-bearing entry carried forward byte-identical.
      expect(JSON.stringify((readLock(dir).verdicts as Verdicts)['scenario-matches-test'][UNIT('login')])).toBe(keptEntry);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);
});

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
