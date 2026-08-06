// =============================================================================
// FAIL-CLOSED — an unreadable mapped file under a PLAIN per:node aspect (NO
// content filter) is NEVER silently dropped into a vacuous green. It blocks with
// a file-unreadable error on BOTH `yg check` and `yg check --approve`, records no
// approved verdict, and stays red across re-checks.
//
// This is the sibling of cli-scope-unreadable.test.ts: that suite covers a
// content-filter (scope.files {content}) aspect, whose evaluator already reads
// every mapped file and so already detected the unreadable one. A plain per:node
// aspect (no scope.files) does NOT read its subject files during pair
// computation, so an unreadable mapped file was previously:
//   (1) silently dropped from the deterministic subject set → vacuous "approved",
//   (2) crashed `yg check --approve` with a raw, unclassified EACCES, and
//   (3) left a bogus approved entry so the NEXT plain check returned PASS (exit 0)
//       over a node whose source the check never read — a false green.
// The contract: a file written into a node's mapping MUST be readable; if it is
// not, the run fails closed with file-unreadable. No dropping, no vacuous pass.
//
// CRITICAL privileged-runtime guard: under root (CI / container) chmod 0o000 is
// ignored and readFileSync still succeeds — the EACCES branch is unreachable, so
// a test relying on it would either fail for the wrong reason or, worse, run zero
// assertions and be reported as passed. Probed ONCE at module load
// (ENFORCES_FILE_PERMISSIONS); the affected tests are marked SKIPPED via
// `it.skipIf` for this environment — an honest, visible non-execution.
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, perms restored in finally
// BEFORE rmSync so the tree is removable. No fixed ports, no clock/random asserts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (d: string) => path.join(d, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.json');

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-unreadable-pn-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Reduce the service type to a single PLAIN per:node deterministic aspect (no
 * scope.files) whose check reads ctx.files. Broaden the service `when` to src/**
 * so a directory-mapped node classifies. The aspect refuses if any file contains
 * 'FORBIDDEN' — proving the check would react to content it could actually read.
 */
function installPlainRule(dir: string): void {
  let arch = readFileSync(archPath(dir), 'utf-8');
  arch = arch.replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n      - has-doc-comment\n',
    '    aspects:\n      - plain-rule\n',
  );
  arch = arch.replace('path: "src/services/**"', 'path: "src/**"');
  writeFileSync(archPath(dir), arch, 'utf-8');
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });

  const pr = path.join(dir, '.yggdrasil', 'aspects', 'plain-rule');
  mkdirSync(pr, { recursive: true });
  writeFileSync(
    path.join(pr, 'yg-aspect.yaml'),
    ['name: PlainRule', 'description: No file may contain the FORBIDDEN token.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(pr, 'check.mjs'),
    ['export function check(ctx) {', '  for (const f of ctx.files) {', "    if (f.content.includes('FORBIDDEN')) return [{ file: f.path, message: 'contains FORBIDDEN' }];", '  }', '  return [];', '}', ''].join('\n'),
    'utf-8',
  );

  // Drop the unused payments node so only orders is in play (incl. flow entry).
  rmSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments'), { recursive: true, force: true });
  rmSync(path.join(dir, 'src', 'services', 'payments.ts'), { force: true });
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('  - services/payments\n', ''), 'utf-8');
}

/**
 * Whether this runtime actually enforces a chmod(0o000) restriction on a file
 * readable by its owner. A privileged process (root, or certain containers)
 * ignores file mode bits entirely, so a test relying on a chmod(0o000)'d file
 * genuinely refusing to read cannot execute there. Probed ONCE at module load
 * — never per-test, never via an early `return` that lets vitest report a
 * test that ran zero assertions as passed — so the affected tests are marked
 * SKIPPED for this environment via `it.skipIf`.
 */
function probeEnforcesFilePermissions(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-permcheck-'));
  const probe = path.join(dir, 'probe.txt');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o000);
  let enforced = false;
  try {
    readFileSync(probe, 'utf8');
  } catch {
    enforced = true;
  }
  chmodSync(probe, 0o644); // restore so rmSync can remove it
  rmSync(dir, { recursive: true, force: true });
  return enforced;
}
const ENFORCES_FILE_PERMISSIONS = probeEnforcesFilePermissions();

describe.skipIf(!distExists)('CLI E2E — per:node fail-closed: unreadable mapped file blocks (no content filter)', () => {
  // ===========================================================================
  // The sole mapped file under a plain per:node deterministic aspect is
  // unreadable. The contract holds across the whole lifecycle:
  //   - plain `yg check` → exit 1, file-unreadable (not a vacuous "unverified"/pass)
  //   - `yg check --approve` → exit 1, file-unreadable (NOT a raw EACCES crash),
  //     and NO approved verdict is written for the aspect
  //   - a second plain `yg check` → still exit 1 (no false green from a stale entry)
  // ===========================================================================

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('the sole mapped file unreadable → file-unreadable on check AND --approve, no false green', () => {
    const dir = copyFixture('sole');
    let lockedAbs: string | undefined;
    try {
      installPlainRule(dir);

      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'svc.ts'), 'export const s = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );

      lockedAbs = path.join(base, 'svc.ts');
      chmodSync(lockedAbs, 0o000);

      // (1) plain check — blocking file-unreadable, exit 1, never a vacuous pass.
      const check1 = run(['check'], dir);
      expect(check1.status).toBe(1);
      expect(check1.all).toContain('file-unreadable');
      // Grouped view: the per-issue `what` ("could not read subject file") is no
      // longer in the default body; the shared why carries the fail-closed
      // rationale and the Fix names the unreadable file + the aspect segment.
      expect(check1.all).toContain('could not be read, so it cannot be reviewed');
      expect(check1.all).toContain('src/services/orders/svc.ts');
      expect(check1.all).toContain('plain-rule');

      // (2) --approve — blocking file-unreadable, exit 1, NOT a raw EACCES crash,
      // and no approved verdict recorded for the aspect (no false green seed).
      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('file-unreadable');
      expect(approve.all).not.toContain('Unexpected error');
      expect(approve.all).not.toContain('This is a bug');
      if (existsSync(lockPath(dir))) {
        const lock = JSON.parse(readFileSync(lockPath(dir), 'utf-8'));
        const entry = lock.verdicts?.['plain-rule']?.['node:services/orders'];
        if (entry) {
          expect(entry.verdict).not.toBe('approved');
        }
      }

      // (3) a second plain check stays RED — no stale approved entry turns green.
      const check2 = run(['check'], dir);
      expect(check2.status).toBe(1);
      expect(check2.all).toContain('file-unreadable');
    } finally {
      if (lockedAbs) {
        try { chmodSync(lockedAbs, 0o644); } catch { /* already restored / privileged */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // MIXED node: one readable + one unreadable file under a plain per:node aspect.
  // The readable sibling does not rescue the run into a vacuous pass — the
  // unreadable file still blocks with file-unreadable on both check and --approve.
  // ===========================================================================

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('one of two mapped files unreadable → still blocks (file-unreadable) on check and --approve', () => {
    const dir = copyFixture('mixed');
    let lockedAbs: string | undefined;
    try {
      installPlainRule(dir);

      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'readable.ts'), 'export const r = 1;\n');
      writeFileSync(path.join(base, 'locked.ts'), 'export const l = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );

      lockedAbs = path.join(base, 'locked.ts');
      chmodSync(lockedAbs, 0o000);

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file-unreadable');
      expect(check.all).toContain('src/services/orders/locked.ts');

      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('file-unreadable');
      expect(approve.all).not.toContain('Unexpected error');
    } finally {
      if (lockedAbs) {
        try { chmodSync(lockedAbs, 0o644); } catch { /* already restored / privileged */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
