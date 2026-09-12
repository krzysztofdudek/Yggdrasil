// =============================================================================
// CLI E2E — `yg check --approve --quiet` flag.
//
// --quiet suppresses the fill progress stream on STDERR (milestone lines,
// refused/infra immediate lines) while leaving the final report on STDOUT and
// the exit code intact.  The emitIssue sink (diagnostic errors printed by the
// build-context phase) is NOT affected.
//
// Uses the e2e-lifecycle fixture in deterministic-only mode (LLM aspect
// stripped) so no network dependency.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Copy fixture and strip the LLM aspect so fills are deterministic-only (no network). */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-quiet-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check --quiet flag', () => {
  it('(1) --approve --quiet: STDERR has no progress, STDOUT has final report, exit code preserved', () => {
    const dir = deterministicFixture('quiet-approve');
    try {
      // Cold fill (unverified pairs) with --quiet.
      const result = run(['check', '--approve', '--quiet'], dir);

      // STDERR must be silent — no milestone lines, no "filling..." header,
      // no pair-outcome lines. Progress suppression is the contract of --quiet.
      expect(result.stderr).toBe('');

      // STDOUT must contain the final report.
      // On a clean fill the output starts with "yg check: PASS".
      // On a fill with errors/warnings it shows "Errors (N)" or "Warnings (N)".
      expect(result.stdout).toMatch(/(?:yg check: PASS|Errors|Warnings)/);

      // Exit code must reflect the actual check result — NOT forced to 0.
      // (Fixture is clean after fill, so we expect 0 here.)
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) --approve --quiet with a det refusal: STDERR still silent, exit code is 1', () => {
    const dir = deterministicFixture('quiet-refused');
    try {
      // Plant a TODO to trigger the enforced det refusal.
      const ordersFile = path.join(dir, 'src', 'services', 'orders.ts');
      appendFileSync(ordersFile, '\n// TODO: later\n');

      const result = run(['check', '--approve', '--quiet'], dir);

      // STDERR must still be silent — even when pairs are refused.
      expect(result.stderr).toBe('');

      // STDOUT has the final report with the refusal detail.
      expect(result.stdout).toContain('no-todo-comments');

      // Exit code must be 1 — --quiet never masks failures.
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) --approve --dry-run --quiet: the budget preview STILL prints on STDOUT (--dry-run wins over --quiet)', () => {
    const dir = deterministicFixture('quiet-dryrun');
    try {
      // Cold lock: --dry-run previews the budget without writing or calling the
      // reviewer. --quiet must NOT swallow it — the budget is the deliverable.
      const result = run(['check', '--approve', '--dry-run', '--quiet'], dir);

      // The budget breakdown reaches STDOUT (the dry-run path's deliverable).
      // The dry-run-specific UPPER BOUND budget line is emitted via the `write`
      // sink — which --quiet must NOT swallow when --dry-run is also set.
      expect(result.stdout).not.toBe('');
      expect(result.stdout).toContain('reviewer call(s) is an UPPER BOUND');
      // The per-pair budget breakdown also lands on stdout.
      expect(result.stdout).toMatch(/Filling \d+ unverified pairs/);

      // --quiet still keeps stderr free of progress.
      expect(result.stderr).toBe('');

      // --dry-run always exits 0 (it is a cost preview, never a verdict).
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) --approve --dry-run --json --quiet: the budget preview moves to STDERR, never vanishes', () => {
    const dir = deterministicFixture('quiet-dryrun-json');
    try {
      // All four flags at once: --json claims STDOUT for the machine document,
      // so the budget preview joins the stderr stream; --quiet must NOT swallow
      // it there. --dry-run wins over --quiet on EVERY combination — the
      // preview is the command's deliverable and the JSON document carries no
      // budget field of its own, so dropping it loses the information outright.
      const result = run(['check', '--approve', '--dry-run', '--json', '--quiet'], dir);

      // The budget breakdown reaches STDERR (stdout is the JSON document's).
      expect(result.stderr).toContain('reviewer call(s) is an UPPER BOUND');
      expect(result.stderr).toMatch(/Filling \d+ unverified pairs/);

      // STDOUT stays a clean, parseable JSON document — no preview text mixed in.
      expect(result.stdout).not.toContain('UPPER BOUND');
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      // --dry-run always exits 0 (it is a cost preview, never a verdict).
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6) --approve --dry-run --json (no --quiet): preview on STDERR, JSON document alone on STDOUT', () => {
    const dir = deterministicFixture('quiet-dryrun-json-loud');
    try {
      // Regression guard for the deliberate --json redirect: without --quiet the
      // preview already belongs on stderr so stdout carries the document alone.
      const result = run(['check', '--approve', '--dry-run', '--json'], dir);

      expect(result.stderr).toContain('reviewer call(s) is an UPPER BOUND');
      expect(result.stdout).not.toContain('UPPER BOUND');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(7) --approve --dry-run (no --json, no --quiet): preview on STDOUT, unchanged', () => {
    const dir = deterministicFixture('quiet-dryrun-plain');
    try {
      // Regression guard for the fourth combination: plain --dry-run keeps the
      // preview on stdout, where it has always been.
      const result = run(['check', '--approve', '--dry-run'], dir);

      expect(result.stdout).toContain('reviewer call(s) is an UPPER BOUND');
      expect(result.stdout).toMatch(/Filling \d+ unverified pairs/);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) plain `yg check` with --quiet: no-op (no progress anyway on read-only), exit 0 on verified', () => {
    const dir = deterministicFixture('quiet-plain-check');
    try {
      // First, fill without --quiet to make everything verified.
      run(['check', '--approve'], dir);

      // Plain check with --quiet: read-only, already verified, no progress produced.
      const result = run(['check', '--quiet'], dir);

      // STDERR silent (already silent for plain check even without --quiet).
      expect(result.stderr).toBe('');

      // STDOUT has the summary report.
      expect(result.stdout).toMatch(/(?:yg check: PASS|Errors|Warnings)/);

      // Everything is verified, so exit 0.
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
