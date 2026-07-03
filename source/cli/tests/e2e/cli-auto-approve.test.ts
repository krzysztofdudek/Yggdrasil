// Hermetic E2E — AUTO_APPROVE CONFIG FEATURE.
//
// Phase 3 of the `yg check` redesign added `auto_approve` to yg-config.yaml
// with three values:
//   false (default) → bare `yg check` is read-only (no fill)
//   'deterministic' → bare `yg check` performs a deterministic fill (no LLM)
//   'full'          → bare `yg check` emits a STDERR banner, then calls the reviewer
//
// Explicit CLI flags override config:
//   --no-approve    → always read-only, even when auto_approve is configured
//   --approve       → always fills (explicit, no banner)
//   --only-deterministic → fills only deterministic pairs
//
// Triage views (--top, --summary) are always read-only regardless of config.
//
// Tests use the e2e-lifecycle fixture (hermetic, no real network). The LLM
// aspects use an in-process mock that speaks the Ollama protocol — no real
// model, no real endpoint, fully reproducible.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readTriadLock, detLockPath } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Copy fixture into a fresh temp dir for mutation. */
function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-auto-approve-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy fixture and strip the LLM aspect so only deterministic aspects remain.
 * Makes tests hermetic: no LLM calls, no network, fully reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = fixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/** Write auto_approve value into the fixture's yg-config.yaml. */
function setAutoApprove(dir: string, value: 'deterministic' | 'full' | false): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  let cfg = readFileSync(cfgPath, 'utf-8');
  // Remove any existing auto_approve line, then append the new one.
  cfg = cfg
    .split('\n')
    .filter((l) => !l.startsWith('auto_approve:'))
    .join('\n');
  cfg = cfg.trimEnd() + `\nauto_approve: ${value === false ? 'false' : value}\n`;
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** Point the reviewer tier's endpoint at the mock. */
function pointReviewer(dir: string, endpoint: string): void {
  const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    p,
    readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`),
    'utf-8',
  );
}

/** Synchronous run helper (for deterministic-only tests — no mock server to serve). */
function runSync(args: string[], cwd: string) {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

const detLockFile = (dir: string) => detLockPath(path.join(dir, '.yggdrasil'));
const readLock = (dir: string) => readTriadLock(path.join(dir, '.yggdrasil'));

// ── Test suite ─────────────────────────────────────────────────────────────

describe.skipIf(!distExists)('CLI E2E — auto_approve config feature', () => {

  // ── Case a: auto_approve: deterministic ─────────────────────────────────

  describe('Case a: auto_approve: deterministic + bare yg check', () => {
    it('a1: bare yg check performs a deterministic fill and pairs go from unverified to verified', () => {
      const dir = deterministicFixture('a1');
      try {
        // Verify baseline without auto_approve: pairs are unverified, no lock.
        const cold = runSync(['check'], dir);
        expect(cold.status).toBe(1);
        expect(cold.stdout).toContain('unverified');
        expect(existsSync(detLockFile(dir))).toBe(false);

        // Now set auto_approve: deterministic.
        setAutoApprove(dir, 'deterministic');

        // Bare `yg check` with auto_approve: deterministic → acts like --approve --only-deterministic.
        runSync(['check'], dir);
        // The fill writes the deterministic lock.
        expect(existsSync(detLockFile(dir))).toBe(true);

        // A subsequent bare `yg check` now sees the valid verdicts and passes.
        const verified = runSync(['check'], dir);
        expect(verified.status).toBe(0);
        expect(verified.stdout).toContain('PASS');
        // No unverified pairs for the orders service node.
        const unverifiedLines = verified.stdout
          .split('\n')
          .filter((l) => l.includes('unverified') && l.includes('services/orders'));
        expect(unverifiedLines.length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a2: bare yg check with auto_approve: deterministic fills the lock (det file written)', () => {
      const dir = deterministicFixture('a2');
      try {
        setAutoApprove(dir, 'deterministic');

        // Two bare checks: first fills (writing the det lock), second verifies.
        runSync(['check'], dir); // fills
        expect(existsSync(detLockFile(dir))).toBe(true);

        const lock = readLock(dir);
        expect(lock.verdicts['no-todo-comments']?.['node:services/orders']?.verdict).toBe('approved');
        expect(lock.verdicts['no-todo-comments']?.['node:services/payments']?.verdict).toBe('approved');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a3: auto_approve: deterministic does not emit the full-auto banner to stderr', () => {
      const dir = deterministicFixture('a3');
      try {
        setAutoApprove(dir, 'deterministic');

        const result = runSync(['check'], dir);
        // The banner is ONLY for auto_approve: full (to warn before LLM calls).
        // Deterministic fill has no LLM cost, so no banner.
        expect(result.stderr).not.toContain("auto-approve: full");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a4: --no-approve overrides auto_approve: deterministic — stays read-only, no fill', () => {
      const dir = deterministicFixture('a4');
      try {
        setAutoApprove(dir, 'deterministic');

        // With --no-approve, must stay read-only even though config says 'deterministic'.
        const result = runSync(['check', '--no-approve'], dir);

        // Read-only: no fill → pairs unverified → exit 1.
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('unverified');
        // No lock was written.
        expect(existsSync(detLockFile(dir))).toBe(false);
        // No banner (no LLM fill attempted).
        expect(result.stderr).not.toContain('auto-approve');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Case b: auto_approve: full + bare yg check ──────────────────────────

  describe('Case b: auto_approve: full + bare yg check', () => {
    it('b1: bare yg check emits the auto-approve banner to stderr before calling the reviewer', async () => {
      const dir = fixture('b1');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'looks fine' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check'], dir);

        // The banner must appear on stderr.
        expect(result.stderr).toContain("auto-approve: full — bare 'yg check' will call the reviewer.");
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('b2: bare yg check with auto_approve: full calls the reviewer and reports PASS (auto-filled)', async () => {
      const dir = fixture('b2');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'looks fine' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check'], dir);

        // Banner on stderr.
        expect(result.stderr).toContain("auto-approve: full — bare 'yg check' will call the reviewer.");
        // Fill ran: reviewer was called.
        expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
        // PASS header with (auto-filled) marker.
        expect(result.stdout).toContain('PASS');
        expect(result.stdout).toContain('auto-filled');
        expect(result.status).toBe(0);
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('b3: bare yg check with auto_approve: full, reviewer refuses → FAIL header, no (auto-filled)', async () => {
      const dir = fixture('b3');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing doc comment' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check'], dir);

        // Banner still emitted (before the fill runs).
        expect(result.stderr).toContain("auto-approve: full — bare 'yg check' will call the reviewer.");
        // Fill ran: reviewer was called.
        expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
        // FAIL — no auto-filled marker on a failed run.
        expect(result.stdout).toContain('FAIL');
        expect(result.stdout).not.toContain('auto-filled');
        expect(result.status).toBe(1);
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('b4: explicit --approve with auto_approve: full does NOT emit the banner (explicit flag, not config-driven)', async () => {
      const dir = fixture('b4');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        // Explicit --approve → not a config-driven fill → no banner.
        const result = await runAsync(['check', '--approve'], dir);

        expect(result.stderr).not.toContain('auto-approve: full');
        // Still fills (explicit --approve).
        expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
        expect(result.status).toBe(0);
        // No (auto-filled) marker — explicit flag.
        expect(result.stdout).toContain('PASS');
        expect(result.stdout).not.toContain('auto-filled');
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Case c: auto_approve: full + --no-approve ────────────────────────────

  describe('Case c: auto_approve: full + --no-approve overrides to read-only', () => {
    it('c1: --no-approve suppresses the banner, stays read-only, and leaves the lock untouched', async () => {
      const dir = fixture('c1');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check', '--no-approve'], dir);

        // No banner — --no-approve forces read-only, no fill attempted.
        expect(result.stderr).not.toContain('auto-approve');
        // No reviewer calls (read-only path).
        expect(mock.chatCount()).toBe(0);
        // Unverified pairs → exit 1.
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('unverified');
        // Deterministic lock was not written (no fill at all).
        expect(existsSync(detLockFile(dir))).toBe(false);
        // Nondeterministic lock was not written.
        const nondetPath = path.join(dir, '.yggdrasil', 'yg-lock.nondeterministic.json');
        expect(existsSync(nondetPath)).toBe(false);
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('c2: --no-approve with auto_approve: deterministic also forces read-only', () => {
      const dir = deterministicFixture('c2');
      try {
        setAutoApprove(dir, 'deterministic');

        const result = runSync(['check', '--no-approve'], dir);

        // No fill → unverified → exit 1.
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('unverified');
        // No lock written.
        expect(existsSync(detLockFile(dir))).toBe(false);
        // No banner (not a full fill attempt).
        expect(result.stderr).not.toContain('auto-approve');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Case d: triage views with auto_approve: full — always read-only ──────

  describe('Case d: triage views (--summary) with auto_approve: full are always read-only', () => {
    it('d1: --summary with auto_approve: full is read-only — no banner, no fill', async () => {
      const dir = fixture('d1');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check', '--summary'], dir);

        // No banner — triage views force read-only regardless of auto_approve.
        expect(result.stderr).not.toContain('auto-approve');
        // No reviewer calls.
        expect(mock.chatCount()).toBe(0);
        // Summary view: per-node counts present.
        expect(result.stdout).toContain('unverified');
        // No lock written.
        expect(existsSync(detLockFile(dir))).toBe(false);
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('d2: --top with auto_approve: full is read-only — no banner, no fill', async () => {
      const dir = fixture('d2');
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
      try {
        setAutoApprove(dir, 'full');
        pointReviewer(dir, mock.endpoint);

        const result = await runAsync(['check', '--top'], dir);

        // No banner — triage view.
        expect(result.stderr).not.toContain('auto-approve');
        // No reviewer calls.
        expect(mock.chatCount()).toBe(0);
        // No lock written.
        expect(existsSync(detLockFile(dir))).toBe(false);
      } finally {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('d3: --summary with auto_approve: deterministic is read-only — no fill', () => {
      const dir = deterministicFixture('d3');
      try {
        setAutoApprove(dir, 'deterministic');

        const result = runSync(['check', '--summary'], dir);

        // Triage view → read-only even with auto_approve: deterministic.
        expect(result.stdout).toContain('unverified');
        expect(existsSync(detLockFile(dir))).toBe(false);
        // No banner.
        expect(result.stderr).not.toContain('auto-approve');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
