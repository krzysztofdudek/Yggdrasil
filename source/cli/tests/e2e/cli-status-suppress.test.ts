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

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable — port 1 never has a listener, on ANY machine, with no
// reliance on a real endpoint being present or absent. Used by killReviewer().
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-status-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the check/fill
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced), `requires-named-export` (advisory) and
 * `wip-rule` (draft) deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  // Drop the LLM aspect from the `service` node type's default aspects.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  // Remove the now-orphaned aspect definition so `yg check` is clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address. The
 * deterministicFixture already removes the only LLM aspect, but killing the
 * endpoint as well guarantees no test in this suite can reach out over the
 * network even if a future fixture edit reintroduces an LLM aspect.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

const aspectYaml = (dir: string, aspect: string) =>
  path.join(dir, '.yggdrasil', 'aspects', aspect, 'yg-aspect.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Status-flip drift/render semantics + suppress edge cases, exercised through
// the REAL built binary against fresh per-test fixture copies. Fully hermetic:
// no LLM, no network, no wall-clock or random sources in any assertion.
//
// Verdict-lock model: `yg approve` is gone — verification happens via
// `yg check --approve` (fill), state lives in `.yggdrasil/yg-lock.json`, and the
// states are verified/unverified/refused. A newly-effective non-draft pair with
// no recorded verdict renders as `unverified` (error if enforced, warning if
// advisory); `yg aspect-test` runs a check diagnostically without writing the
// lock and reports per-line violations (used to pin which TODO a single-line
// suppress waives).
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — status-flip drift/render semantics + suppress edge cases', () => {
  // --- 1. draft -> enforced makes the aspect newly active (no verdict -> unverified) ---
  //
  // Re-anchored from the old draft->advisory case: in the verdict-lock model an
  // advisory unverified pair is a non-blocking WARNING (exit 0). To preserve the
  // original "newly-active BLOCKS check, then approve clears it" intent we
  // promote to ENFORCED, whose newly-effective unverified pair is a blocking
  // error (exit 1) that a fill clears.

  it('1: flipping wip-rule draft->enforced makes check fail (unverified, no verdict); a fill clears it', () => {
    const dir = hermeticFixture('newly-active');
    try {
      // Fill both nodes while wip-rule is still DRAFT (dormant, no verdict).
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Promote wip-rule draft -> enforced. It is an OWN aspect of services/orders,
      // so it becomes effective there with no recorded verdict yet.
      const flipped = readFileSync(aspectYaml(dir, 'wip-rule'), 'utf-8').replace(
        /^status: draft$/m,
        'status: enforced',
      );
      writeFileSync(aspectYaml(dir, 'wip-rule'), flipped, 'utf-8');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // The newly-active aspect has no verdict — check reports it explicitly.
      expect(drifted.stdout).toContain('unverified');
      expect(drifted.stdout).toContain('wip-rule');
      expect(drifted.stdout).toContain('services/orders');

      // A fill records the missing verdict and clears the drift.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. advisory <-> enforced is a render flip, not a source change ---

  it('2: flipping no-todo-comments enforced->advisory (check.mjs unchanged) carries the verdict forward — check passes, re-fill is a no-op', () => {
    const dir = hermeticFixture('render-flip');
    try {
      // Fill both nodes with no-todo-comments at its default ENFORCED status.
      // The source is clean (no TODO), so both approve.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Flip the aspect status ONLY — check.mjs is left byte-for-byte unchanged.
      const before = readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8');
      const after = before.replace(/^status: enforced$/m, 'status: advisory');
      expect(after).not.toBe(before); // guard: the flip actually applied
      writeFileSync(aspectYaml(dir, 'no-todo-comments'), after, 'utf-8');

      // advisory<->enforced is NOT a source change and NOT drift: the status is
      // excluded from the canonical verdict hash, so the prior `approved` verdict
      // carries forward (only the render severity flips). check stays green and a
      // re-fill finds every pair already valid — a clean no-op.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');

      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // A fill with no pair to judge prints no pair count and no closing line;
      // the only fill output is the standing-change record on STDERR.
      expect(refill.stderr).not.toMatch(/^fill {2}\d+ pairs? /m);
      expect(refill.stderr).not.toMatch(/^fill {2}done /m);
      expect(refill.stderr).toContain("fill  rule 'no-todo-comments' now stands at advisory (was enforced)");
      expect(refill.all).not.toContain('[refused]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. explicit attach-site status that relaxes a stricter cascade is rejected ---

  it('3: attaching no-todo-comments with explicit status:advisory below its enforced default is an aspect-status-downgrade error', () => {
    const dir = hermeticFixture('downgrade');
    try {
      // Re-author the orders node so it attaches no-todo-comments (whose aspect
      // default is `enforced`) with an explicit, weaker `status: advisory`.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - id: no-todo-comments',
          '    status: advisory',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Exact validator code: an explicit attach-site status cannot relax a
      // stricter cascading anchor (here the aspect-default `enforced`).
      expect(check.stdout).toContain('aspect-status-downgrade');
      expect(check.stdout).toContain('services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. bracket wildcard suppress waives every aspect within its range ---

  it('4: a yg-suppress-disable(*)..enable(*) bracket waives a TODO inside the range; fill exits 0', () => {
    const dir = hermeticFixture('bracket-suppress');
    try {
      // Baseline fill on the clean source.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Append a block carrying a TODO (would trip enforced no-todo-comments) and
      // a non-exported helper, wrapped entirely in a wildcard bracket suppress.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress-disable(*) legacy reconciliation path, tracked in the issue tracker',
          '// TODO: migrate the legacy reconciliation path',
          'function legacyReconcile(p: Payment): Payment {',
          '  return p;',
          '}',
          '// yg-suppress-enable(*)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      // Everything inside the bracket range is waived -> the pair approves.
      expect(fill.status).toBe(0);
      expect(fill.all).toMatch(/^fill {2}done in .* · 0 refused · /m);
      expect(fill.all).not.toContain('[refused]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4b. control: the same TODO WITHOUT the bracket refuses (proves the bracket did the waiving) ---

  it('4b: the identical TODO block WITHOUT bracket markers refuses the fill (proves the suppress is what waived it)', () => {
    const dir = hermeticFixture('bracket-control');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Same payload, but no suppress markers.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// TODO: migrate the legacy reconciliation path',
          'function legacyReconcile(p: Payment): Payment {',
          '  return p;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.stderr).toMatch(/^fill {2}done in .* · 1 refused · /m);
      expect(fill.stdout).toContain('error[refused] no-todo-comments — 1 violation in services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. single-line suppress is contextual: it covers only the next line ---

  it('5: a single-line yg-suppress over ONE TODO leaves a second un-suppressed TODO flagged; fill exits 1', () => {
    const dir = hermeticFixture('single-line-suppress');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // First TODO is suppressed (marker on the line immediately above it);
      // the second TODO is left bare.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker',
          '// TODO: first todo is suppressed',
          '// TODO: second todo is NOT suppressed',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.stderr).toMatch(/^fill {2}done in .* · 1 refused · /m);
      // Exactly ONE violation is recorded — the un-suppressed second TODO.
      expect(fill.stdout).toContain('error[refused] no-todo-comments — 1 violation in services/orders');

      // aspect-test surfaces the per-line detail: exactly ONE TODO is reported —
      // the un-suppressed second one. The single suppress covered only the line
      // directly beneath it, not both TODOs. The appended block places the
      // suppress marker on the original last line + 2, the first (suppressed)
      // TODO on +3 and the second (flagged) TODO on +4. The original file is 15
      // lines (a trailing newline keeps line 15 empty), so the flagged TODO lands
      // on line 18 — and the suppressed first TODO on line 17 is NOT reported.
      const diag = run(
        ['aspect-test', '--node', 'services/orders', '--aspect', 'no-todo-comments'],
        dir,
      );
      expect(diag.status).toBe(1);
      const todoViolations = diag.stdout
        .split('\n')
        .filter((l) => l.includes('TODO comment found'));
      expect(todoViolations.length).toBe(1);
      expect(diag.stdout).toMatch(/:18 {2}/);
      expect(diag.stdout).not.toContain('L17:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. suppressing a draft aspect is a no-op (the reviewer never runs it) ---

  it('6: yg-suppress(wip-rule) near a WIP marker is inert while wip-rule is draft; fill exits 0 with no suppress error', () => {
    const dir = hermeticFixture('draft-suppress-noop');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // wip-rule (draft) would flag any line containing "WIP" if it were active.
      // Suppressing a draft aspect is documented as a no-op: the reviewer never
      // runs the aspect, so there is nothing to waive and no error to raise.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(wip-rule) draft aspect, suppress should be inert',
          '// WIP marker here',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // The draft aspect is skipped, not evaluated — it never appears as a fill
      // pair, regardless of the suppress marker.
      expect(fill.stdout).not.toContain('wip-rule on node:services/orders');
      // No violation, and no error about the suppress marker itself.
      expect(fill.all).toMatch(/^fill {2}done in .* · 0 refused · /m);
      expect(fill.all).not.toContain('[refused]');
      expect(fill.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
