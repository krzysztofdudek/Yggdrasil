// =============================================================================
// THE LOCK MATRIX — part 4: prompt-too-large gate, lock merge recovery,
// lock-invalid recovery, aspect-test diagnostic isolation.
// MATRIX points (7), (9), (10), (12). Real spawned binary; mock reviewer for LLM
// over runAsync (never spawnSync while the mock serves).
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, mutated in place,
// rmSync'd in finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readMergedLock, nondetLockPath, logsLockPath, detLockPath } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
// The 5.1.0 lock is a three-file triad under <dir>/.yggdrasil/. The unified view
// is read by merging all three (readLock); to seed/garble a scenario we write the
// specific triad file the CLI actually parses for that scenario:
//   - LLM verdicts (has-doc-comment) → yg-lock.nondeterministic.json (committed)
//   - the `nodes` section (per-node source/log baseline) → yg-lock.logs.json (committed)
//   - deterministic verdicts → .yg-lock.deterministic.json (gitignored)
const ygDir = (d: string) => path.join(d, '.yggdrasil');
const nondetPath = (d: string) => nondetLockPath(ygDir(d));
const logsPath = (d: string) => logsLockPath(ygDir(d));
const detPath = (d: string) => detLockPath(ygDir(d));
const readLock = (d: string) => readMergedLock(ygDir(d));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
/** Set (or replace) max_prompt_chars on the standard tier. */
function setPromptLimit(dir: string, n: number): void {
  const p = cfgPath(dir);
  const stripped = readFileSync(p, 'utf-8').replace(/\n\s*max_prompt_chars: \d+/, '');
  writeFileSync(p, stripped.replace(/consensus: 1/, `consensus: 1\n      max_prompt_chars: ${n}`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lockfmt-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — lock matrix: prompt-too-large / merge / lock-invalid / aspect-test', () => {
  // ===========================================================================
  // MATRIX (7) — PROMPT-TOO-LARGE
  //   tier max_prompt_chars tiny → check shows prompt-too-large (NOT unverified)
  //   for the pair, exit 1; fill skips it (0 reviewer calls for that pair); raise
  //   limit → fill verifies; THEN lower limit again → verdict stays valid AND the
  //   gate error renders (both visible).
  // ===========================================================================

  it('(7) prompt-too-large: gate precedence, fill-skip, raise→verify, lower→verdict-survives + gate-renders', async () => {
    const dir = copyFixture('ptl');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // Tiny limit → the LLM pairs trip prompt-too-large.
      setPromptLimit(dir, 50);
      const check1 = run(['check'], dir);
      expect(check1.status).toBe(1);
      expect(check1.all).toContain('prompt-too-large');
      // prompt-too-large is NOT a FULL_WHAT code, so the per-issue `what`
      // ("Assembled reviewer prompt for aspect '<id>' on <unit> is N chars, over
      // the '<tier>' tier limit of 50.") — including the char/limit numbers — is
      // gone in the grouped read-only view. Assert the group label, the aspect
      // segment, the now-visible why, and the offending node line instead.
      expect(check1.all).toContain("aspect 'has-doc-comment'");
      expect(check1.all).toContain('An over-limit prompt risks context-window truncation and a false verdict.');
      expect(check1.all).toContain('- services/orders');
      // GATE PRECEDENCE: the pair shows prompt-too-large, NOT a duplicate
      // unverified. With the per-issue `what` gone, the surviving unverified
      // discriminator is that has-doc-comment never appears under an
      // `unverified (not yet reviewed)` group header.
      expect(check1.all).not.toMatch(/unverified \(not yet reviewed\)[^\n]*aspect 'has-doc-comment'/);

      // FILL skips the over-limit pairs → ZERO reviewer calls. Deterministic pairs still fill.
      const fill1 = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(0);
      expect(fill1.status).toBe(1); // the skipped LLM pairs keep the run red (prompt-too-large)
      expect(fill1.all).toContain('prompt-too-large');

      // RAISE the limit → the LLM pairs now fit → fill verifies them.
      setPromptLimit(dir, 100000);
      const fill2 = await runAsync(['check', '--approve'], dir);
      expect(fill2.status).toBe(0);
      expect(mock.chatCount()).toBe(2); // both LLM pairs verified
      expect(readLock(dir).verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('approved');

      // LOWER the limit AGAIN → the stored verdict STAYS valid (max_prompt_chars is
      // a gate, not a hash input) AND the gate error renders. Both are visible; the
      // gate never points at --approve (which would be a no-op).
      setPromptLimit(dir, 50);
      const check2 = run(['check'], dir);
      expect(check2.status).toBe(1);
      expect(check2.all).toContain('prompt-too-large');
      // The verdict survived in the lock — lowering the limit did NOT invalidate it.
      expect(readLock(dir).verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('approved');
      // And it is NOT rendered as unverified. The per-issue `what` is gone in the
      // grouped view, so the surviving discriminator is that has-doc-comment
      // never appears under an `unverified (not yet reviewed)` group header.
      expect(check2.all).not.toMatch(/unverified \(not yet reviewed\)[^\n]*aspect 'has-doc-comment'/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // MATRIX (9) — LOCK MERGE
  //   simulate conflict resolution: take one side wholesale (which is missing
  //   some pairs), run --approve → missing pairs re-verified, result green; no
  //   hand-merge needed.
  // ===========================================================================

  it('(9) lock merge: take a side wholesale → --approve re-verifies the missing pairs → green', () => {
    const dir = deterministicFixture('merge');
    try {
      // Reach green, then simulate "git checkout --ours" of a side whose lock only
      // verified the orders node (payments entries absent — the other branch added them).
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const lock = readLock(dir);
      for (const aspectId of Object.keys(lock.verdicts)) {
        for (const unitKey of Object.keys(lock.verdicts[aspectId])) {
          if (unitKey.includes('payments')) delete lock.verdicts[aspectId][unitKey];
        }
      }
      delete lock.nodes['services/payments'];
      // Write the taken side in a NON-canonical shape (as a human/tool merge might);
      // the self-validating entries make this safe — a wrong line cannot lie. The aspects
      // here are all deterministic, so the verdicts live in the gitignored det file and the
      // `nodes` baseline in the committed logs file; write each section to its triad file.
      writeFileSync(detPath(dir), JSON.stringify({ version: lock.version, verdicts: lock.verdicts, nodes: {} }, null, 2) + '\n', 'utf-8');
      writeFileSync(logsPath(dir), JSON.stringify({ version: lock.version, verdicts: {}, nodes: lock.nodes }, null, 2) + '\n', 'utf-8');

      // The missing pairs surface as unverified. The per-issue `what`
      // ("No valid verdict for aspect '<id>' on <unit>.") is gone in the grouped
      // view for the non-FULL_WHAT unverified code; assert the gloss + aspect
      // segment + the offending node line instead.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('unverified (not yet reviewed)');
      expect(check.all).toContain("aspect 'no-todo-comments'");
      expect(check.all).toContain('- services/payments');

      // --approve re-verifies ONLY the missing pairs → green. No hand-merge.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
      // The kept (orders) entries were never re-verified — they carried forward.
      expect(refill.all).not.toContain('node:services/orders — approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // MATRIX (10) — LOCK-INVALID
  //   garbled JSON / conflict markers / version 99 → check exits 1 with
  //   lock-invalid + a recovery next:; delete lock → cold start works.
  // ===========================================================================

  it('(10) lock-invalid: garbled JSON, conflict markers, unknown version all fail closed with recovery', () => {
    const dir = deterministicFixture('invalid');
    try {
      run(['check', '--approve'], dir); // establish a valid lock first

      // Garble a COMMITTED triad file (one readLock parses). The committed nondeterministic
      // file carries the committed-recovery guidance (git restore), which is what these
      // assertions pin; the message now names the specific triad file that was hit.
      // (a) Garbled JSON.
      writeFileSync(nondetPath(dir), '{ this is not json', 'utf-8');
      const garbled = run(['check'], dir);
      expect(garbled.status).toBe(1);
      expect(garbled.all).toContain('lock-invalid');
      // lock-invalid is not a FULL_WHAT code, so the per-issue `what`
      // ('unparseable JSON') is gone in the grouped view; the detail now lives in
      // the shared why. Assert the now-visible why plus the recovery command.
      expect(garbled.all).toContain('a garbled lock file cannot be read');
      expect(garbled.all).toContain('git checkout HEAD -- .yggdrasil/yg-lock.nondeterministic.json');

      // (b) Git conflict markers.
      writeFileSync(
        nondetPath(dir),
        ['<<<<<<< HEAD', '{ "version": 1, "verdicts": {}, "nodes": {} }', '=======', '{ "version": 1, "verdicts": {}, "nodes": {} }', '>>>>>>> branch', ''].join('\n'),
        'utf-8',
      );
      const conflict = run(['check'], dir);
      expect(conflict.status).toBe(1);
      expect(conflict.all).toContain('lock-invalid');
      // The per-issue `what` ('contains git conflict markers') is gone in the
      // grouped view; the detail now lives in the shared why.
      expect(conflict.all).toContain('a conflict-markered lock file cannot be parsed');
      expect(conflict.all).toContain('git checkout --ours');

      // (c) Unknown version.
      writeFileSync(nondetPath(dir), JSON.stringify({ version: 99, verdicts: {}, nodes: {} }) + '\n', 'utf-8');
      const badVersion = run(['check'], dir);
      expect(badVersion.status).toBe(1);
      expect(badVersion.all).toContain('lock-invalid');
      // The per-issue `what` ('has unsupported version 99 ...') is gone in the
      // grouped view; the detail now lives in the shared why.
      expect(badVersion.all).toContain('an unrecognized lock version means the file was written by a different or newer CLI');

      // (d) Delete the lock → cold start works again (all pairs unverified, fill recovers).
      //     Remove the garbled committed file AND the gitignored deterministic verdict file;
      //     with both absent every pair reads unverified (cold start), not lock-invalid.
      rmSync(nondetPath(dir), { force: true });
      rmSync(detPath(dir), { force: true });
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.all).toContain('unverified');
      expect(cold.all).not.toContain('lock-invalid');
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // MATRIX (12) — ASPECT-TEST DIAGNOSTIC ISOLATION
  //   LLM run + --dry-run → lock file byte-identical before/after; footer
  //   present; det run likewise.
  // ===========================================================================

  it('(12a) aspect-test (deterministic) is diagnostic-only: lock byte-identical, footer present', () => {
    const dir = deterministicFixture('at-det');
    try {
      run(['check', '--approve'], dir);
      // `no-todo-comments` is deterministic → its verdict lives in the gitignored det
      // triad file. Snapshot THAT file (the one a det aspect-test could plausibly touch).
      const before = readFileSync(detPath(dir), 'utf-8');
      const test = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
      expect(test.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');
      // Byte-identical: aspect-test NEVER writes the lock.
      expect(readFileSync(detPath(dir), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(12b) aspect-test --dry-run (LLM) prints the prompt, makes ZERO calls, lock byte-identical', async () => {
    const dir = copyFixture('at-llm');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Establish a lock via a real fill first.
      await runAsync(['check', '--approve'], dir);
      // `has-doc-comment` is an LLM aspect → its verdict lives in the committed
      // nondeterministic triad file. Snapshot THAT file to prove aspect-test never writes it.
      const before = readFileSync(nondetPath(dir), 'utf-8');
      const callsBefore = mock.chatCount();

      // --dry-run prints the assembled prompt and makes NO provider call.
      const dry = await runAsync(['aspect-test', '--aspect', 'has-doc-comment', '--node', 'services/orders', '--dry-run'], dir);
      expect(dry.status).toBe(0);
      expect(dry.all).toContain('=== prompt for node:services/orders ===');
      expect(dry.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');
      expect(mock.chatCount()).toBe(callsBefore); // ZERO new calls
      // Byte-identical lock.
      expect(readFileSync(nondetPath(dir), 'utf-8')).toBe(before);

      // A LIVE aspect-test (no --dry-run) DOES call the reviewer but STILL never
      // writes the lock — it is a sanctioned diagnostic re-roll.
      const live = await runAsync(['aspect-test', '--aspect', 'has-doc-comment', '--node', 'services/orders'], dir);
      expect(live.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');
      expect(mock.chatCount()).toBeGreaterThan(callsBefore); // it did call the reviewer
      expect(readFileSync(nondetPath(dir), 'utf-8')).toBe(before); // but the lock is unchanged
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
