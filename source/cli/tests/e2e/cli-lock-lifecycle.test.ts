// =============================================================================
// THE LOCK MATRIX — part 1: full lifecycle, log gate + positive closure, GC.
//
// User mandate (verdict-lock design, Task B8): the new lock/fill machinery must
// be ROCK SOLID end to end, exercised through the REAL spawned binary. This suite
// covers MATRIX points (1) full lock lifecycle, (6) closure + log gate, and
// (11) GC + draft round-trip. Siblings cover the rest:
//   cli-lock-cached-gate.test.ts   → (2) cached refusals, (3) det-first gate, (8) infra fail-closed
//   cli-lock-scope.test.ts         → (4) per-file scope + files filter, (5) observation invalidation
//   cli-lock-format-recovery.test.ts → (7) prompt-too-large, (9) merge, (10) lock-invalid, (12) aspect-test
//
// HERMETIC: each test copies the committed e2e-lifecycle fixture into a fresh
// mkdtemp, mutates ONLY that copy, rmSync's it in finally. LLM aspects are driven
// by the in-process mock reviewer (support/mock-reviewer.ts) over runAsync (never
// spawnSync — that would deadlock the in-process server). Deterministic-only
// scenarios strip the LLM aspect and use plain spawnSync. No fixed ports, no
// clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readTriadLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// ── shared helpers (duplicated per-suite so each file is self-contained) ──────

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
// 5.1.0 triad: the committed nondeterministic file holds LLM verdicts; the committed
// logs file holds the `nodes` section; the gitignored det file holds deterministic
// verdicts. The legacy single yg-lock.json is no longer written or read. `readLock`
// below merges all three into one { version, verdicts, nodes }; `nondetLockPath`
// names the committed LLM file used for cold-start existence and raw-content checks.
const nondetLockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.nondeterministic.json');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectYaml = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a, 'yg-aspect.yaml');
const ordersFile = (d: string) => path.join(d, 'src', 'services', 'orders.ts');
const readLock = (d: string) => readTriadLock(path.join(d, '.yggdrasil'));

function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lockcycle-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Strip the LLM aspect so the fixture is purely deterministic (no reviewer needed). */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  writeFileSync(
    archPath(dir),
    readFileSync(archPath(dir), 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'),
    'utf-8',
  );
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

/** Set log_required: true on the `service` node type (opt-in, default is false). */
function requireLogOnService(dir: string): void {
  const p = archPath(dir);
  // The `service:` block carries `log_required: false`; flip it to true.
  const out = readFileSync(p, 'utf-8').replace(
    /(service:\n(?:.*\n)*?\s*)log_required: false/,
    '$1log_required: true',
  );
  writeFileSync(p, out, 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — lock matrix: lifecycle / closure / GC', () => {
  // ===========================================================================
  // MATRIX (1) — FULL LOCK LIFECYCLE
  //   cold start (unverified, exit 1, suggestedNext) → fill → verified (exit 0)
  //   → edit subject → unverified → re-fill → verified.
  //   Lock file content is sane at each step.
  // ===========================================================================

  it('(1) full lifecycle: cold → fill → verified → edit → unverified → re-fill → verified', async () => {
    const dir = copyFixture('full');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // --- COLD START: no lock → every enforced pair unverified → exit 1 ---
      // No committed lock file exists yet (the triad is written only by a fill).
      expect(existsSync(nondetLockPath(dir))).toBe(false);
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.all).toContain('unverified (not yet reviewed)');
      // Grouped view: an unverified group for the aspect lists the node; the
      // per-issue `what` ("No valid verdict ...") is no longer in the default body.
      expect(cold.all).toContain("aspect 'no-todo-comments'");
      expect(cold.all).toContain('- services/orders');
      // suggestedNext points at the fill command.
      expect(cold.all).toContain('Next: yg check --approve');

      // --- FILL ---
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).toContain('Filling');

      // Lock content sane: valid JSON, version 1, sorted keys, entries present.
      const lock = readLock(dir);
      expect(lock.version).toBe(1); // relations are computed live; the lock is back to v1
      const raw = readFileSync(nondetLockPath(dir), 'utf-8');
      expect(raw.endsWith('}\n')).toBe(true); // trailing newline
      // top-level aspect ids sorted (code-point)
      const aspectIds = Object.keys(lock.verdicts);
      expect(aspectIds).toEqual([...aspectIds].sort());
      // an enforced det entry and the LLM entry are both present + approved
      expect(lock.verdicts['no-todo-comments']['node:services/orders'].verdict).toBe('approved');
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('approved');
      // services is not a log_required type, so closure records NO source
      // fingerprint for it (the fingerprint is the log gate's drift basis, kept
      // only for log_required nodes) — its nodes[] entry is absent entirely.
      expect(lock.nodes['services/orders']?.source).toBeUndefined();

      // --- VERIFIED: a plain read is green, makes no calls ---
      const callsAfterFill = mock.chatCount();
      const verified = run(['check'], dir);
      expect(verified.status).toBe(0);
      expect(verified.all).toContain('yg check: PASS');
      expect(mock.chatCount()).toBe(callsAfterFill); // plain check never calls the reviewer

      // --- EDIT SUBJECT → the edited node's pairs go unverified ---
      appendFileSync(ordersFile(dir), '\nexport const extra = 1;\n');
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('unverified (not yet reviewed)');
      // Grouped view: the edited node's pairs go unverified and list orders.
      expect(drifted.all).toContain('- services/orders');
      // payments was untouched — its verdict stays valid (it is never listed as an
      // unverified member, so no `- services/payments` line appears).
      expect(drifted.all).not.toContain('- services/payments');

      // --- RE-FILL → verified again. Only the edited node's pairs re-run. ---
      const callsBeforeRefill = mock.chatCount();
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // Exactly one reviewer call (consensus 1) — only orders' LLM pair re-verified.
      expect(mock.chatCount() - callsBeforeRefill).toBe(1);
      const final = run(['check'], dir);
      expect(final.status).toBe(0);
      expect(final.all).toContain('yg check: PASS');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // ===========================================================================
  // MATRIX (6) — CLOSURE + LOG GATE
  //   log_required type → fill without fresh entry → log-entry-missing, pairs
  //   skipped, exit 1; yg log add → fill succeeds; another fill after a
  //   failed-then-fixed code edit needs NO second entry (one per cycle);
  //   aspect-content-only edit (cascade-only) → fill needs NO entry; lock.nodes
  //   carries source fingerprint + log baseline after closure.
  // ===========================================================================

  it('(6a) log gate: fill without a fresh entry → log-entry-missing, pairs skipped, exit 1', () => {
    const dir = deterministicFixture('loggate');
    try {
      requireLogOnService(dir);
      // First verification of a non-empty mapping with log_required → gate fires.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('No fresh log entry for node');
      expect(fill.all).toContain('services/orders');
      // The blocked node's pairs were NOT verified — no lock entry written for it.
      // readLock merges the triad and tolerates absent files (empty sections),
      // so a never-written deterministic verdict simply reads back absent.
      const lock = readLock(dir);
      const noTodo = lock.verdicts['no-todo-comments'] ?? {};
      expect(noTodo['node:services/orders']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6b) log gate: after yg log add the fill succeeds and records the log baseline', () => {
    const dir = deterministicFixture('logadd');
    try {
      requireLogOnService(dir);
      // Add a fresh entry for each service node, then fill.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'Initial verification of orders.'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'Initial verification of payments.'], dir).status).toBe(0);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).not.toContain('log-entry-missing');
      expect(fill.all).not.toContain('No fresh log entry');
      // Closure recorded BOTH the source fingerprint and the log baseline.
      const lock = readLock(dir);
      expect(typeof lock.nodes['services/orders'].source).toBe('string');
      expect(typeof lock.nodes['services/orders'].log!.last_entry_datetime).toBe('string');
      expect(typeof lock.nodes['services/orders'].log!.prefix_hash).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6c) one log entry covers a failed-then-fixed code edit within a single cycle', () => {
    const dir = deterministicFixture('onecycle');
    try {
      requireLogOnService(dir);
      // Edit source to introduce an enforced det violation, then add ONE entry.
      appendFileSync(ordersFile(dir), '\n// TODO: temporary\n');
      run(['log', 'add', '--node', 'services/orders', '--reason', 'Reworking the order summary path.'], dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'Baseline payments.'], dir);

      // First fill: orders refuses (TODO), but the gate did NOT fire (entry is fresh),
      // so the refusal is a real verdict — the cycle stays open (node not green).
      const fill1 = run(['check', '--approve'], dir);
      expect(fill1.status).toBe(1);
      expect(fill1.all).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(fill1.all).not.toContain('No fresh log entry');

      // Fix the code WITHOUT adding a new entry; fill again — same single entry
      // must still satisfy the gate (one entry per cycle until positive closure).
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8').replace('\n// TODO: temporary\n', '\n'), 'utf-8');
      const fill2 = run(['check', '--approve'], dir);
      expect(fill2.all).not.toContain('No fresh log entry');
      expect(fill2.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6d) cascade-only edit (aspect content, source untouched) needs NO log entry', () => {
    const dir = deterministicFixture('cascadeonly');
    try {
      requireLogOnService(dir);
      // Reach green with a fresh entry per node.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'Initial orders.'], dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'Initial payments.'], dir);
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Edit the aspect's check.mjs (cascade) WITHOUT touching any source file.
      const checkMjs = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');
      appendFileSync(checkMjs, '\n// cosmetic edit that changes the rule hash\n');

      // The pairs are now unverified (rule hash changed) but the SOURCE fingerprint
      // is unchanged → the log gate must NOT fire on the re-fill.
      const refill = run(['check', '--approve'], dir);
      expect(refill.all).not.toContain('No fresh log entry');
      expect(refill.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // MATRIX (11) — GC + DRAFT ROUND-TRIP + NODE DELETION
  // ===========================================================================

  it('(11a) detaching an aspect from a node prunes its lock entries on the next fill', () => {
    const dir = deterministicFixture('gc-detach');
    try {
      // Attach an extra enforced det aspect to orders only, fill, confirm entry, then detach.
      const extraDir = path.join(dir, '.yggdrasil', 'aspects', 'extra-rule');
      cpSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), extraDir, { recursive: true });
      writeFileSync(
        path.join(extraDir, 'yg-aspect.yaml'),
        ['name: ExtraRule', 'description: A second deterministic rule for GC testing.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
        'utf-8',
      );
      // Attach to orders node (own declaration).
      const oy = nodeYaml(dir, 'services/orders');
      writeFileSync(oy, readFileSync(oy, 'utf-8').replace(/^aspects:\n/m, 'aspects:\n  - extra-rule\n'), 'utf-8');

      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(readLock(dir).verdicts['extra-rule']['node:services/orders'].verdict).toBe('approved');

      // Detach: remove the aspect from the node's list.
      writeFileSync(oy, readFileSync(oy, 'utf-8').replace('  - extra-rule\n', ''), 'utf-8');
      // Also delete the aspect dir so the graph stays clean (no orphaned-aspect).
      rmSync(extraDir, { recursive: true, force: true });

      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // GC pruned the now-orphan verdict entry entirely.
      expect(readLock(dir).verdicts['extra-rule']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(11b) draft round-trip (enforced→draft→enforced, no code change) reuses the verdict, zero re-verification', () => {
    const dir = deterministicFixture('gc-draft');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      // The enforced det entry exists.
      expect(readLock(dir).verdicts['no-todo-comments']['node:services/orders'].verdict).toBe('approved');

      // Flip enforced → draft. GC must RETAIN the entry (draft pairs are in the
      // GC universe), and the fill is a no-op.
      const ay = aspectYaml(dir, 'no-todo-comments');
      writeFileSync(ay, readFileSync(ay, 'utf-8').replace('status: enforced', 'status: draft'), 'utf-8');
      const draftFill = run(['check', '--approve'], dir);
      expect(draftFill.all).toContain('Filling 0 unverified pairs');
      expect(readLock(dir).verdicts['no-todo-comments']['node:services/orders']).toBeDefined();

      // Flip back to enforced — the verdict survives the status flips → reused, no re-fill.
      writeFileSync(ay, readFileSync(ay, 'utf-8').replace('status: draft', 'status: enforced'), 'utf-8');
      const backFill = run(['check', '--approve'], dir);
      expect(backFill.all).toContain('Filling 0 unverified pairs');
      expect(backFill.all).toContain('0 reviewer calls made');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(11c) deleting a node prunes its nodes[] entry from the lock', () => {
    const dir = deterministicFixture('gc-nodedel');
    try {
      // Give the non-log_required payments node a log.md so it owns a nodes[]
      // entry (its append-only log baseline) for the GC-pruning check below.
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'gc fixture'], dir).status).toBe(0);
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(readLock(dir).nodes['services/payments']).toBeDefined();

      // Delete the payments node (its yg-node.yaml + mapped source).
      rmSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments'), { recursive: true, force: true });
      rmSync(path.join(dir, 'src', 'services', 'payments.ts'), { force: true });

      const refill = run(['check', '--approve'], dir);
      // GC pruned the absent node's nodes[] entry and its verdict entries.
      const lock = readLock(dir);
      expect(lock.nodes['services/payments']).toBeUndefined();
      expect(lock.verdicts['no-todo-comments']?.['node:services/payments']).toBeUndefined();
      // No leftover UNVERIFIED reference to the deleted node (the original
      // failure mode this test guards against — a dangling pair the run
      // thinks still needs review). The writer's own prune summary (Task 6)
      // DOES name the deleted node's pruned entries — that is the intended,
      // informative report of what GC just did, not a leftover.
      expect(refill.all).not.toMatch(/unverified[^\n]*services\/payments|services\/payments[^\n]*unverified/);
      expect(refill.all).toContain('node:services/payments — node deleted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(11d) --quiet suppresses the prune summary on a REAL --approve fill (no leak into quiet mode)', () => {
    const dir = deterministicFixture('gc-quiet');
    try {
      // Same attach/detach setup as (11a) — give the next --approve something
      // real to prune, so a passing assertion below is not vacuous.
      const extraDir = path.join(dir, '.yggdrasil', 'aspects', 'extra-rule');
      cpSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), extraDir, { recursive: true });
      writeFileSync(
        path.join(extraDir, 'yg-aspect.yaml'),
        ['name: ExtraRule', 'description: A second deterministic rule for GC testing.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
        'utf-8',
      );
      const oy = nodeYaml(dir, 'services/orders');
      writeFileSync(oy, readFileSync(oy, 'utf-8').replace(/^aspects:\n/m, 'aspects:\n  - extra-rule\n'), 'utf-8');

      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(readLock(dir).verdicts['extra-rule']['node:services/orders'].verdict).toBe('approved');

      // Detach the aspect, then re-fill under --quiet.
      writeFileSync(oy, readFileSync(oy, 'utf-8').replace('  - extra-rule\n', ''), 'utf-8');
      rmSync(extraDir, { recursive: true, force: true });

      const refill = run(['check', '--approve', '--quiet'], dir);
      expect(refill.status).toBe(0);
      // The prune genuinely happened this run...
      expect(readLock(dir).verdicts['extra-rule']).toBeUndefined();
      // ...but --quiet suppressed the writer's report of it — the summary text
      // must not leak into stdout or stderr just because something was pruned.
      expect(refill.all).not.toContain('Pruned');
      expect(refill.all).not.toContain('stale verdict');
      expect(refill.all).not.toContain('extra-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
