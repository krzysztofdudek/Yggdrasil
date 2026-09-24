// =============================================================================
// THE LOCK MATRIX — part 2: cached refusals, deterministic-first gate, infra
// fail-closed. MATRIX points (2), (3), (8). Real spawned binary + in-process
// mock reviewer over runAsync (never spawnSync while the mock serves).
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, mutated in place,
// rmSync'd in finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';
import { readLock as readTriadLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const yggRoot = (d: string) => path.join(d, '.yggdrasil');
// LLM verdicts (the subject of every verdict assertion below) live in the committed
// nondeterministic file of the 5.1.0 triad; read the merged view via the src store.
const nondetLockPath = (d: string) => path.join(yggRoot(d), 'yg-lock.nondeterministic.json');
const ordersFile = (d: string) => path.join(d, 'src', 'services', 'orders.ts');
const readLock = (d: string) => readTriadLock(yggRoot(d));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lockgate-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — lock matrix: cached refusals / det gate / infra', () => {
  // ===========================================================================
  // MATRIX (2) — CACHED REFUSALS
  //   reviewer refuses once → entry refused; second --approve makes ZERO reviewer
  //   HTTP calls, output carries the cached marker + three exits; plain check
  //   renders the refusal (exit 1 enforced).
  // ===========================================================================

  it('(2) a cached LLM refusal is never re-rolled: second fill makes ZERO reviewer calls', async () => {
    const dir = copyFixture('cached-refusal');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing doc comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // First fill: the LLM aspect refuses on both nodes → exit 1, entries recorded refused.
      const fill1 = await runAsync(['check', '--approve'], dir);
      expect(fill1.status).toBe(1);
      expect(fill1.all).toContain('[llm] has-doc-comment on node:services/orders — refused');
      const callsAfterFirst = mock.chatCount();
      expect(callsAfterFirst).toBe(2); // consensus 1 × 2 LLM pairs

      // The lock holds the refused verdict with the reviewer's reason.
      const lock = readLock(dir);
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('refused');
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].reason).toContain('missing doc comment');

      // Plain check renders the cached refusal (exit 1, enforced). In the grouped
      // view the `what` line-0 header ("Aspect '...' is refused on ... cached
      // verdict — the reviewer did NOT re-run; ...") is dropped; the "cached/final"
      // semantics now live in the shared why, and the retained FULL_WHAT tail is
      // the "Reviewer reason: <reason>" line carried on the `- <node>` bullet.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('enforced');
      expect(check.all).toContain("aspect 'has-doc-comment'");
      expect(check.all).toContain('A refused verdict for unchanged inputs is final and cached');
      expect(check.all).toContain('Reviewer reason: missing doc comment');
      // The three exits are present in the rendered Fix line.
      expect(check.all).toContain('Four exits:');
      expect(check.all).toContain('yg impact --aspect has-doc-comment');
      expect(check.all).toContain('yg-suppress');

      // SECOND fill: ZERO new reviewer HTTP calls — the refusal is cached/final.
      const fill2 = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount() - callsAfterFirst).toBe(0);
      expect(fill2.all).toContain('0 reviewer calls made');
      expect(fill2.status).toBe(1); // still red — the refusal blocks.
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // Regression — the `Next:` footer must NOT truncate a multi-line "Three
  // exits:" pointer to its bare heading. computeSuggestedNext hands the footer
  // the refusal's full `next` (the heading plus the three numbered exits); the
  // renderer used to print only line 1 ("Three exits:"), dead-ending the agent
  // with a colon and nothing after it. This covers both the enforced (error)
  // and advisory (warnings-only PASS) refusal footers — the same render path.
  // ===========================================================================

  it("(2b) an ENFORCED cached refusal renders the three exits under the Next footer, not a bare 'Three exits:' heading", async () => {
    const dir = copyFixture('footer-enforced');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing doc comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir); // cache the enforced refusal
      const check = run(['check'], dir); // plain read renders the cached refusal (exit 1)
      expect(check.status).toBe(1);
      // The footer must carry the actual exits — not dead-end on the heading.
      expect(check.all).toMatch(/Next: Four exits:\n\s+1\. Fix the code/);
      expect(check.all).toMatch(/\n\s+2\. Sharpen the aspect/);
      expect(check.all).toMatch(/\n\s+3\. Propose a `yg-suppress`/);
      // Issue 210 (m16): the fourth exit — advisory while deciding — is offered too.
      expect(check.all).toMatch(/\n\s+4\. Not sure yet which it is: propose `status: advisory`/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("(2c) an ADVISORY cached refusal (warnings-only PASS) renders the three exits under the Next footer, not a bare 'Three exits:' heading", async () => {
    const dir = copyFixture('footer-advisory');
    // Flip the LLM aspect to advisory: its refusal becomes a warning, so the run
    // is a warnings-only PASS whose suggestedNext falls back to this refusal's
    // `next` — the exact case a real project hit.
    const aspPath = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
    writeFileSync(aspPath, readFileSync(aspPath, 'utf-8').replace(/status:\s*enforced/, 'status: advisory'), 'utf-8');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing doc comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir); // cache the advisory refusal
      const check = run(['check'], dir); // warnings-only PASS (exit 0)
      expect(check.status).toBe(0);
      expect(check.all).toContain('advisory');
      // Even on a warnings-only PASS, the footer must carry the exits.
      expect(check.all).toMatch(/Next: Four exits:\n\s+1\. Fix the code/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // MATRIX (3) — DETERMINISTIC-FIRST GATE
  //   enforced det violation + LLM aspect on the same node → fill makes ZERO
  //   reviewer calls for that node, reports the skip; fix det violation → re-fill
  //   runs the LLM.
  // ===========================================================================

  it('(3) det-first gate: an enforced det refusal skips the LLM fill for that node, reported', async () => {
    const dir = copyFixture('det-gate');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Plant an enforced det violation on orders only (no-todo-comments is enforced).
      appendFileSync(ordersFile(dir), '\n// TODO: later\n');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // orders' det check refused → its LLM fill is SKIPPED and reported.
      expect(fill.all).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(fill.all).toContain("LLM fills for node 'services/orders' skipped — an enforced deterministic check already refused it.");
      // payments has NO det violation → its LLM fill ran. orders' did NOT.
      expect(fill.all).not.toContain('[llm] has-doc-comment on node:services/orders');
      // Exactly ONE reviewer call (payments only). orders' LLM pair was never dispatched.
      expect(mock.chatCount()).toBe(1);
      // orders' LLM pair stays unverified (never billed). The per-issue `what`
      // ("No valid verdict for aspect '<id>' on <unit>.") is gone in the grouped
      // view for the non-FULL_WHAT unverified code; assert the gloss + aspect
      // segment + the offending node line instead.
      const check = run(['check'], dir);
      expect(check.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      expect(check.all).toContain("aspect 'has-doc-comment'");
      expect(check.all).toContain('- services/orders');

      // Fix the det violation → re-fill now runs the LLM for orders.
      const callsBefore = mock.chatCount();
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8').replace('\n// TODO: later\n', '\n'), 'utf-8');
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1); // orders' LLM pair, finally.
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // MATRIX (8) — INFRA FAIL-CLOSED
  //   mock returns 500/garbage → fill writes NOTHING for the pair (lock unchanged
  //   for it, prior entries intact), infra summary printed, exit 1; restore mock
  //   → re-fill succeeds.
  // ===========================================================================

  it('(8) infra fail-closed: a provider 500 writes NOTHING; prior entries intact; restore → green', async () => {
    const dir = copyFixture('infra-500');
    const okMock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, okMock.endpoint);
      // Clean fill → green lock.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const lockBefore = readFileSync(nondetLockPath(dir), 'utf-8');
      const ordersEntryBefore = readLock(dir).verdicts['has-doc-comment']['node:services/orders'];
      const paymentsEntryBefore = readLock(dir).verdicts['has-doc-comment']['node:services/payments'];
      await okMock.close();

      // Edit orders' source (its LLM pair now unverified), then fill with the provider down.
      appendFileSync(ordersFile(dir), '\nexport const edited = 1;\n');
      const infraMock = await startMockReviewer({ respond: () => ({ httpStatus: 500 }) });
      try {
        pointReviewer(dir, infraMock.endpoint);
        const fill = await runAsync(['check', '--approve'], dir);
        expect(fill.status).toBe(1);
        // The infra summary class is printed.
        expect(fill.all).toContain('pairs failed on provider/config errors');

        // FAIL-CLOSED: the edited orders LLM pair must NOT have advanced to a green
        // verdict — its hash no longer matches the edited source (stale entry),
        // and no NEW verdict was written. The PAYMENTS entry is byte-identical.
        const lockNow = readLock(dir);
        expect(lockNow.verdicts['has-doc-comment']['node:services/payments']).toEqual(paymentsEntryBefore);
        // orders entry, if still present, is the OLD (now-stale) entry — never a
        // fresh green over the edited source.
        const ordersNow = lockNow.verdicts['has-doc-comment']['node:services/orders'];
        if (ordersNow) expect(ordersNow).toEqual(ordersEntryBefore);

        // A plain read stays RED — the edited pair is unverified, no false-green.
        // The per-issue `what` ("No valid verdict for aspect '<id>' on <unit>.")
        // is gone in the grouped view for the non-FULL_WHAT unverified code;
        // assert the gloss + aspect segment + the offending node line instead.
        const check = run(['check'], dir);
        expect(check.status).toBe(1);
        expect(check.all).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
        expect(check.all).toContain("aspect 'has-doc-comment'");
        expect(check.all).toContain('- services/orders');
      } finally {
        await infraMock.close();
      }

      // Restore a healthy provider → re-fill succeeds.
      const restoreMock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        pointReviewer(dir, restoreMock.endpoint);
        const refill = await runAsync(['check', '--approve'], dir);
        expect(refill.status).toBe(0);
        expect(run(['check'], dir).status).toBe(0);
      } finally {
        await restoreMock.close();
      }
      void lockBefore;
    } finally {
      await okMock.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  it('(8b) infra fail-closed: a garbled reviewer response containing "satisfied" is NOT a pass', async () => {
    const dir = copyFixture('infra-garbled');
    const okMock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, okMock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const paymentsBefore = readLock(dir).verdicts['has-doc-comment']['node:services/payments'];
      await okMock.close();

      appendFileSync(ordersFile(dir), '\nexport const edited2 = 2;\n');
      const junk: () => ChatReply = () => ({ rawContent: 'sure, looks satisfied to me!!! {{{' });
      const junkMock = await startMockReviewer({ respond: junk });
      try {
        pointReviewer(dir, junkMock.endpoint);
        const fill = await runAsync(['check', '--approve'], dir);
        expect(fill.status).toBe(1);
        // The unparseable response is treated as infra (no write), not a code PASS.
        expect(readLock(dir).verdicts['has-doc-comment']['node:services/payments']).toEqual(paymentsBefore);
        expect(run(['check'], dir).status).toBe(1);
      } finally {
        await junkMock.close();
      }
    } finally {
      await okMock.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
