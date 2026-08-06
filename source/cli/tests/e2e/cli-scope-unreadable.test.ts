// =============================================================================
// SCOPE / FAIL-CLOSED — an unreadable subject file is NEVER silently dropped into
// a vacuous green; it surfaces as a BLOCKING file-unreadable error end-to-end.
//
// Covers the verdict-lock bounty E2E gap: a content-filter (scope.files {content})
// aspect MUST read each mapped file to evaluate the filter. When a mapped file is
// unreadable (chmod 0o000 → EACCES), the spawned `yg check` must exit 1 with a
// file-unreadable error — never drop the file and pass vacuously. Two variants:
//   (4a) one of two mapped files unreadable → the readable sibling still produces
//        a pair, but the run is still RED on the unreadable one (blocks, not drops).
//   (4b) the only mapped+matching file is unreadable → exit 1 with file-unreadable
//        AND the lock records NO approved entry for that aspect (no false green).
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-unreadable-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Reduce the service type to a single deterministic content-filter aspect
 * (marker-rule) so the only effective rule on the orders node is the one whose
 * scope.files {content} filter MUST read every mapped file. Broaden the service
 * `when` to src/** so a directory-mapped node classifies.
 */
function installMarkerRule(dir: string): void {
  let arch = readFileSync(archPath(dir), 'utf-8');
  arch = arch.replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n      - has-doc-comment\n',
    '    aspects:\n      - marker-rule\n',
  );
  arch = arch.replace('path: "src/services/**"', 'path: "src/**"');
  writeFileSync(archPath(dir), arch, 'utf-8');
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });

  const mr = path.join(dir, '.yggdrasil', 'aspects', 'marker-rule');
  mkdirSync(mr, { recursive: true });
  writeFileSync(
    path.join(mr, 'yg-aspect.yaml'),
    ['name: MarkerRule', 'description: Files carrying the @reviewed marker are reviewed.', 'reviewer:', '  type: deterministic', 'status: enforced',
      'scope:', '  per: node', '  files:', '    content: "@reviewed"', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(mr, 'check.mjs'),
    ['export function check(ctx) {', '  void ctx;', '  return [];', '}', ''].join('\n'),
    'utf-8',
  );

  // Drop the unused payments node so only orders is in play — including its flow
  // participation entry (else a flow-node-broken error blocks for an unrelated reason).
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

describe.skipIf(!distExists)('CLI E2E — scope fail-closed: unreadable subject file blocks (file-unreadable)', () => {
  // ===========================================================================
  // (4a) ONE OF TWO MAPPED FILES UNREADABLE
  //   Content-filter aspect over a 2-file node; one file chmod 0o000. The run
  //   must be RED (exit 1) with a file-unreadable error — the readable sibling
  //   does not rescue it into a vacuous pass.
  // ===========================================================================

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('(4a) an unreadable mapped file blocks the run (file-unreadable, exit 1) — never a vacuous pass', () => {
    const dir = copyFixture('mixed');
    let lockedAbs: string | undefined;
    try {
      installMarkerRule(dir);

      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'readable.ts'), '// @reviewed\nexport const r = 1;\n');
      writeFileSync(path.join(base, 'locked.ts'), '// @reviewed\nexport const l = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );

      lockedAbs = path.join(base, 'locked.ts');
      chmodSync(lockedAbs, 0o000);

      const check = run(['check'], dir);
      // FAIL-CLOSED: blocking error, NOT a silent vacuous pass.
      expect(check.status).toBe(1);
      expect(check.all).toContain('file-unreadable');
      // The per-issue `what` ("could not read subject file") is no longer rendered
      // in the grouped view; the fail-closed rationale survives in the shared why,
      // and the unreadable path survives in the Fix text below.
      expect(check.all).toContain('could not be read, so it was dropped from the review subject set');
      expect(check.all).toContain('A silently dropped file can turn an enforced rule into a vacuous pass.');
      expect(check.all).toContain('src/services/orders/locked.ts');
      // The error names the marker-rule aspect (the content filter that had to read it).
      expect(check.all).toContain('marker-rule');
    } finally {
      if (lockedAbs) {
        try { chmodSync(lockedAbs, 0o644); } catch { /* already restored / privileged */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // (4b) THE ONLY MATCHING FILE IS UNREADABLE
  //   Single mapped+matching file chmod 0o000 → plain `yg check` exits 1 with
  //   file-unreadable (no vacuous pass) AND the lock records NO approved verdict
  //   for the aspect (no false green over a dropped subject).
  //
  //   Both the PLAIN `yg check` path (core/check.ts surfaces
  //   verification.unreadable as a blocking issue) AND the `yg check --approve`
  //   (fill) path block cleanly: computeExpectedPairs excludes the unreadable
  //   subject (so no pair is filled into a vacuous approve) and
  //   computeSourceFingerprint throws a typed FileUnreadableError that positive
  //   closure catches (no stale-green close), instead of the former raw EACCES
  //   crash. The lock records NO approved verdict for the aspect.
  // ===========================================================================

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('(4b) the sole matching file unreadable → check AND --approve: file-unreadable, exit 1, NO approved verdict', () => {
    const dir = copyFixture('sole');
    let lockedAbs: string | undefined;
    try {
      installMarkerRule(dir);

      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'locked.ts'), '// @reviewed\nexport const l = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );

      lockedAbs = path.join(base, 'locked.ts');
      chmodSync(lockedAbs, 0o000);

      // Plain check: blocking file-unreadable error, exit 1 — never a vacuous pass.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file-unreadable');
      // The per-issue `what` ("could not read subject file") is no longer rendered
      // in the grouped view; the fail-closed rationale survives in the shared why,
      // and the unreadable path survives in the Fix text.
      expect(check.all).toContain('could not be read, so it was dropped from the review subject set');
      expect(check.all).toContain('A silently dropped file can turn an enforced rule into a vacuous pass.');
      expect(check.all).toContain('src/services/orders/locked.ts');

      // --approve blocks cleanly too (no raw EACCES crash) and writes no verdict.
      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('file-unreadable');
      expect(approve.all).not.toContain('Unexpected error');
      expect(approve.all).not.toContain('This is a bug');

      // No false green: no approved marker-rule verdict was written for this node.
      if (existsSync(lockPath(dir))) {
        const lock = JSON.parse(readFileSync(lockPath(dir), 'utf-8'));
        const entry = lock.verdicts?.['marker-rule']?.['node:services/orders'];
        if (entry) {
          expect(entry.verdict).not.toBe('approved');
        }
      }
    } finally {
      if (lockedAbs) {
        try { chmodSync(lockedAbs, 0o644); } catch { /* already restored / privileged */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
