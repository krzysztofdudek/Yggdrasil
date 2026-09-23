// =============================================================================
// Fill-stage semantics that work but were not pinned end-to-end. Real spawned
// binary + in-process mock reviewer (support/mock-reviewer.ts) over runAsync.
//
// Covers three fill-stage behaviours the existing e2e suite does not reach:
//   (1) the deterministic gate seeded from a CACHED-VALID enforced det refusal
//       (fill.ts cached-seed branch) — distinct from the FRESH-violation gate
//       that cli-lock-cached-gate (3) exercises;
//   (2) the no-reviewer-configured fail-closed disposition — an effective
//       enforced LLM aspect with no usable reviewer leaves the pair unverified,
//       writes NO verdict, exits 1, and does not self-heal until config is fixed;
//   (3) an LLM consensus verdict that does NOT reach a satisfied majority is
//       recorded as `refused` in the lock (the boundary verifyWithConsensus
//       resolves with `satisfied > notSatisfied`).
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, mutated in place,
// rmSync'd in finally. No fixed ports, no clock/random assertions. Strong
// observables only: HTTP call counts, lock entries/tokens, exit codes.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply, type ChatRequest } from './support/mock-reviewer.js';
import { readLock as readLockStore } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const yggRoot = (d: string) => path.join(d, '.yggdrasil');
// Committed LLM-verdict file of the 5.1.0 triad — where a has-doc-comment verdict lands.
const nondetLockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.nondeterministic.json');
const ordersFile = (d: string) => path.join(d, 'src', 'services', 'orders.ts');
const contentMd = (d: string) => path.join(d, '.yggdrasil', 'aspects', 'has-doc-comment', 'content.md');
// Read the unified lock by merging the 5.1.0 triad (nondeterministic + logs + deterministic).
const readLock = (d: string) => readLockStore(yggRoot(d));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-fillsem-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — fill-stage semantics', () => {
  // ===========================================================================
  // (1) DETERMINISTIC GATE seeded from a CACHED-VALID enforced det refusal.
  //
  //   The fixture's services/orders node carries an enforced deterministic
  //   aspect (no-todo-comments) AND an enforced LLM aspect (has-doc-comment).
  //
  //   Step 1: plant a TODO so the det check refuses, fill once → the det refusal
  //           is recorded in the lock (VALID for the current source).
  //   Step 2: WITHOUT touching the det subject, edit ONLY the LLM aspect's
  //           content.md. This invalidates the LLM pair (content.md is hashed
  //           into the LLM input) while leaving the det pair's recorded refusal
  //           still VALID — so the det pair is NOT in this run's fill set.
  //   Step 3: yg check --approve. The cached det refusal must STILL gate the
  //           node's LLM fill: ZERO new reviewer calls for orders, the skip is
  //           reported, and no LLM verdict is written for orders.
  //
  //   This pins the cached-seed gate branch (the seed loop over verifyLock's
  //   already-classified pairs) that the FRESH-violation test in
  //   cli-lock-cached-gate (3) — which fills the det violation THIS run — never
  //   reaches. The cached-seed branch is the one that fires during real
  //   incremental re-fills.
  // ===========================================================================

  it('(1) a CACHED-VALID enforced det refusal gates the LLM fill on an LLM-only re-verify (0 calls for that node)', async () => {
    const dir = copyFixture('cached-det-gate');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // Step 1: plant the det violation on orders only, fill once.
      appendFileSync(ordersFile(dir), '\n// TODO: later\n');
      const fill1 = await runAsync(['check', '--approve'], dir);
      expect(fill1.status).toBe(1);
      const lock1 = readLock(dir);
      // The det refusal is recorded for orders.
      expect(lock1.verdicts['no-todo-comments']['node:services/orders'].verdict).toBe('refused');
      // orders' LLM pair was gated this run (no entry); payments' LLM ran.
      expect(lock1.verdicts['has-doc-comment']?.['node:services/orders']).toBeUndefined();
      expect(lock1.verdicts['has-doc-comment']['node:services/payments'].verdict).toBe('approved');
      // One reviewer call so far (payments only — orders was det-gated).
      expect(mock.chatCount()).toBe(1);

      // Step 2: edit ONLY the LLM aspect's content.md. The det subject
      // (orders.ts) is untouched, so the det refusal stays VALID and is NOT in
      // the fill set; the LLM pair on BOTH nodes goes unverified (content.md is
      // a hashed LLM input).
      const callsBefore = mock.chatCount();
      appendFileSync(contentMd(dir), '\nAn extra clarifying sentence for the reviewer.\n');

      // Step 3: re-fill. The CACHED det refusal must gate orders' LLM fill.
      const fill2 = await runAsync(['check', '--approve'], dir);
      expect(fill2.status).toBe(1); // still red — det refusal blocks orders.

      // STRONG OBSERVABLE: exactly ONE new reviewer call this run — payments'
      // re-review only. orders' LLM pair was suppressed by the cached det
      // refusal (not re-dispatched), so its call count delta is zero.
      expect(mock.chatCount() - callsBefore).toBe(1);

      // The skip is reported with the deterministic reason.
      expect(fill2.all).toContain(
        "LLM fills for node 'services/orders' skipped — an enforced deterministic check already refused it.",
      );
      // Only payments' LLM pair was dispatched/recorded this run; orders' was not.
      expect(fill2.all).not.toContain('[llm] has-doc-comment on node:services/orders');

      // No LLM verdict entry exists for orders — the gate left it unverified.
      const lock2 = readLock(dir);
      expect(lock2.verdicts['has-doc-comment']?.['node:services/orders']).toBeUndefined();

      // Plain check confirms orders' LLM pair is unverified (no false-green).
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Grouped view: unverified groups by code only (no aspect in header).
      expect(check.all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      // The aspect appears on the body line instead.
      expect(check.all).toContain("- services/orders  aspect 'has-doc-comment'");
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // (2) NO-REVIEWER-CONFIGURED → fail-closed, no verdict written, no self-heal.
  //
  //   An effective non-draft enforced LLM aspect (has-doc-comment) with NO
  //   usable reviewer must be a fail-closed infra disposition: the LLM pair is
  //   left UNVERIFIED, NO verdict entry is written for it, the run reports the
  //   reviewer/config failure class, and exit is 1. Re-running does not help
  //   until config is fixed.
  //
  //   NOTE ON ROUTING (verified against the binary, not a code bug): deleting
  //   the entire `reviewer:` section is caught by config validation as an
  //   APPROVE-gating error, so `yg check --approve` ABORTS the whole fill before
  //   dispatch and writes NO lock file at all (rather than reaching the per-pair
  //   "Cannot resolve a reviewer tier" disposition). This is a STRONGER
  //   fail-closed than a per-pair skip — the assertions below pin the real
  //   behaviour: no lock entry for the LLM aspect (here, no lock file), exit 1,
  //   and recovery only after the reviewer section is restored.
  // ===========================================================================

  it('(2) an effective enforced LLM aspect with NO reviewer configured fails closed: no verdict, exit 1, no self-heal', async () => {
    const dir = copyFixture('no-reviewer');
    try {
      const cfg = cfgPath(dir);
      const original = readFileSync(cfg, 'utf-8');
      // Strip the entire reviewer: section to EOF — the project now has an
      // effective enforced LLM aspect but no usable reviewer.
      writeFileSync(cfg, original.replace(/\nreviewer:[\s\S]*$/, '\n'), 'utf-8');

      // First approve: fails closed. No verdict written for the LLM aspect
      // (here, no lock at all — the run aborts at the config gate).
      const fill1 = run(['check', '--approve'], dir);
      expect(fill1.status).toBe(1);
      // The reviewer/config failure is reported (what/why/next).
      expect(fill1.all).toContain('no reviewer: section');
      // FAIL-CLOSED: NOTHING was committed — no committed LLM-verdict file, hence
      // no verdict entry under has-doc-comment that a later check could read as green.
      expect(existsSync(nondetLockPath(dir))).toBe(false);

      // Re-running does NOT help — the config is still broken.
      const fill2 = run(['check', '--approve'], dir);
      expect(fill2.status).toBe(1);
      expect(existsSync(nondetLockPath(dir))).toBe(false);

      // A plain `yg check` stays RED — no false-green over the unreviewed aspect.
      expect(run(['check'], dir).status).toBe(1);

      // Restore the reviewer section, pointed at a healthy mock → the fill now
      // verifies the LLM aspect and records a real verdict.
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        writeFileSync(cfg, original.replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${mock.endpoint}"`), 'utf-8');
        const fixed = await runAsync(['check', '--approve'], dir);
        expect(fixed.status).toBe(0);
        // Only now is a verdict entry written for the previously-unverifiable
        // LLM aspect — proving nothing was recorded while it was unreviewable.
        expect(readLock(dir).verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('approved');
        expect(run(['check'], dir).status).toBe(0);
      } finally {
        await mock.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // (3) CONSENSUS sub-majority → recorded REFUSED in the lock.
  //
  //   verifyWithConsensus resolves a pair as satisfied only when
  //   satisfied > notSatisfied; at the boundary (satisfied does NOT strictly
  //   exceed notSatisfied) the verdict falls to refused and is WRITTEN to the
  //   lock as a `refused` entry.
  //
  //   NOTE (verified against the binary, not a code bug): an EVEN consensus
  //   (e.g. 2, which would give a literal 1-1 tie) is REJECTED by config
  //   validation — `consensus must be a positive odd integer; even values
  //   cannot break ties` — so a true tie is unreachable end-to-end by design.
  //   The reachable boundary is an ODD consensus whose satisfied votes do not
  //   form a majority (consensus 3, split 1 satisfied / 2 not). The load-bearing
  //   observable the existing odd-consensus test (cli-llm-reviewer-mock case 6)
  //   does NOT assert is the LOCK record: this test pins that the sub-majority
  //   verdict is stored as `refused`, not merely printed.
  // ===========================================================================

  it('(3) an odd-consensus sub-majority verdict is recorded as REFUSED in the lock', async () => {
    const dir = copyFixture('consensus-refused');
    // Per pair (consensus 3), vote pattern: 1 satisfied, 2 not-satisfied →
    // satisfied (1) is NOT > notSatisfied (2) → refused.
    const respond: (r: ChatRequest, i: number) => ChatReply = (_r, i) =>
      i % 3 === 0 ? { satisfied: true, reason: 'ok' } : { satisfied: false, reason: 'sub-majority refusal' };
    const mock = await startMockReviewer({ respond });
    try {
      pointReviewer(dir, mock.endpoint);
      // Set the standard tier's consensus to 3.
      const cfg = cfgPath(dir);
      writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace(/consensus:\s*\d+/, 'consensus: 3'), 'utf-8');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1); // the refused enforced pair blocks the run.
      // One LLM aspect × two service nodes × consensus 3 = 6 votes.
      expect(mock.chatCount()).toBe(6);

      // STRONG OBSERVABLE: the lock records the sub-majority verdict as REFUSED
      // (with the reviewer's reason) — not approved, not absent.
      const lock = readLock(dir);
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('refused');
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].reason).toBe('sub-majority refusal');
      expect(lock.verdicts['has-doc-comment']['node:services/payments'].verdict).toBe('refused');

      // The fill line reports the refusal for each pair.
      expect(fill.all).toContain('[llm] has-doc-comment on node:services/orders — refused');

      // Plain check renders the cached enforced refusal (exit 1) and does not
      // re-roll the reviewer.
      const callsBefore = mock.chatCount();
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Grouped view: an enforced refusal group for the LLM aspect; the retained
      // per-member tail names orders with its reviewer reason.
      expect(check.all).toContain("enforced  2 pairs  2 nodes  aspect 'has-doc-comment'");
      expect(check.all).toContain('A refused verdict for unchanged inputs is final and cached');
      expect(check.all).toContain('- services/orders  Reviewer reason: sub-majority refusal');
      expect(mock.chatCount()).toBe(callsBefore); // check made no calls.
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // (4) --approve --dry-run: a free cost preview that previews the budget with
  //     ZERO reviewer calls and writes nothing, and a real --approve afterward
  //     bills no more than the previewed upper bound.
  // ===========================================================================

  it('(4) dry-run previews the budget with 0 reviewer calls; real --approve then bills <= the preview', async () => {
    const dir = copyFixture('dry-run-preview');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // Preview: structural gate + classification + budget, but NO reviewer
      // calls and NO writes.
      const preview = await runAsync(['check', '--approve', '--dry-run'], dir);
      expect(preview.status).toBe(0); // a preview never blocks.
      expect(mock.chatCount()).toBe(0); // STRONG OBSERVABLE: zero reviewer calls.
      // No committed lock file was created by the preview.
      expect(existsSync(nondetLockPath(dir))).toBe(false);

      // Parse the previewed reviewer-call budget from the header — it must be > 0
      // (the fixture has effective enforced LLM pairs on the service nodes).
      const m = preview.all.match(/—\s*\d+ deterministic \(no cost\),\s*(\d+) reviewer calls \(consensus included\)/);
      expect(m).not.toBeNull();
      const budget = Number(m![1]);
      expect(budget).toBeGreaterThan(0);
      // The upper-bound caveat is present.
      expect(preview.all).toContain('UPPER BOUND');

      // Now the REAL fill. It bills at most the previewed budget.
      const real = await runAsync(['check', '--approve'], dir);
      expect(real.status).toBe(0);
      expect(mock.chatCount()).toBeGreaterThan(0);
      expect(mock.chatCount()).toBeLessThanOrEqual(budget);
      // The real run wrote the committed verdict file.
      expect(existsSync(nondetLockPath(dir))).toBe(true);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('(4b) dry-run with nothing unverified previews a 0 budget, 0 reviewer calls, exit 0', async () => {
    const dir = copyFixture('dry-run-clean');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // First, a real fill to bring everything green.
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      const callsAfterFill = mock.chatCount();
      expect(callsAfterFill).toBeGreaterThan(0);

      // Now a preview: nothing is unverified, so the budget is 0 and no reviewer
      // call is made.
      const preview = await runAsync(['check', '--approve', '--dry-run'], dir);
      expect(preview.status).toBe(0);
      expect(preview.all).toMatch(/Filling 0 unverified pairs[\s\S]*?0 reviewer calls/);
      expect(mock.chatCount()).toBe(callsAfterFill); // no new calls.
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('(4c) dry-run on a broken config aborts with the same FillGatingError/exit 1 and writes no lock', async () => {
    const dir = copyFixture('dry-run-broken-cfg');
    try {
      const cfg = cfgPath(dir);
      const original = readFileSync(cfg, 'utf-8');
      // Point reviewer.default at a tier that does not exist — the config is
      // broken, not merely absent. The step-1 structural gate fires; a preview
      // of an unrunnable --approve must surface that blocker. (A reviewer: section
      // that is simply MISSING no longer aborts a preview — see (4d).)
      writeFileSync(cfg, original.replace('default: standard', 'default: nosuch'), 'utf-8');

      const preview = run(['check', '--approve', '--dry-run'], dir);
      expect(preview.status).toBe(1); // the config gate aborts the preview.
      expect(preview.all).toContain("reviewer.default is 'nosuch'");
      // The retry names the command as it was run.
      expect(preview.all).toContain('then re-run: yg check --approve --dry-run');
      // FAIL-CLOSED: the gate aborts before the preview emits a budget — nothing
      // was written.
      expect(existsSync(nondetLockPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('(4d) dry-run with NO reviewer: section previews (exit 0), naming the missing reviewer, and writes no lock', async () => {
    const dir = copyFixture('dry-run-no-reviewer');
    try {
      const cfg = cfgPath(dir);
      writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace(/\nreviewer:[\s\S]*$/, '\n'), 'utf-8');
      const preview = run(['check', '--approve', '--dry-run'], dir);
      // A preview calls no reviewer, so a missing one is reported, not a stop.
      expect(preview.status).toBe(0);
      expect(preview.all).not.toContain('aborted');
      expect(preview.all).toContain('No reviewer is configured');
      expect(existsSync(nondetLockPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
