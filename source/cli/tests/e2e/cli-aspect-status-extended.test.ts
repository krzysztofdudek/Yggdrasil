import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
import { readLock as readLockStore } from './support/read-lock.js';
import type { LockFile } from './support/read-lock.js';

// ---------------------------------------------------------------------------
// Harness — every test runs the REAL dist/bin.js against a fresh mkdtemp copy of
// the e2e-lifecycle fixture, mutates only that copy, and rmSync's it in a finally
// block. Fully hermetic: no committed fixtures of its own, no network, no
// wall-clock or random sources in any assertion. Every aspect exercised is a
// deterministic reviewer (zero LLM cost); the reviewer endpoint is additionally
// repointed at a dead loopback so no test can reach the network even if a future
// fixture edit reintroduces an LLM aspect.
//
// MODEL — `yg approve` / `.drift-state/` are GONE. Verification happens via
// `yg check --approve` (fill); state lives in the 5.1.0 lock triad under
// `.yggdrasil/` (yg-lock.nondeterministic.json + yg-lock.logs.json + the
// gitignored .yg-lock.deterministic.json), read here via the merged readLock. A
// deterministic refusal renders (at `yg check` / fill time) as
// `<status>  <node>  Aspect '<id>' is refused on <unitKey> by a deterministic
// check.` (approved pairs emit milestone progress lines; refused pairs emit an immediate line).
// Severity follows status: an ENFORCED refusal is an ERROR (exit 1); an ADVISORY
// refusal is a WARNING (exit 0); a DRAFT aspect produces NO pair (skipped). A
// bare advisory<->enforced status flip is NOT part of the canonical verdict hash,
// so it does NOT invalidate a verdict (no re-fill; the cached verdict is reused).
// A draft->non-draft activation surfaces as `unverified` (the pair simply has no
// stored verdict yet), fixed by a single repo-wide `yg check --approve`. The
// removed `aspect-newly-active` vocabulary maps to `unverified`.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so a fill never produces an environment-dependent LLM
// verdict — port 1 never has a listener, on ANY machine. Used by killReviewer().
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-aststatus-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced), `requires-named-export` (advisory) and
 * `wip-rule` (draft) deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
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

/** Repoint the reviewer endpoint at the dead loopback address. */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

const aspectYaml = (dir: string, aspect: string) =>
  path.join(dir, '.yggdrasil', 'aspects', aspect, 'yg-aspect.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const servicesNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');

const yggDir = (dir: string) => path.join(dir, '.yggdrasil');

/**
 * Parse the repo-wide lock. The 5.1.0 lock is a three-file triad under
 * `.yggdrasil/` (committed yg-lock.nondeterministic.json + yg-lock.logs.json and
 * the gitignored .yg-lock.deterministic.json); the store's readLock merges all
 * three back into the unified { version, verdicts, nodes } shape — so a
 * deterministic verdict written to .yg-lock.deterministic.json by a fill is read
 * here exactly like the legacy single file used to be.
 */
function readLock(dir: string): LockFile {
  return readLockStore(yggDir(dir));
}

/** The persisted per-pair verdict entry for an aspect on a node (model-scoped). */
function nodeVerdict(
  dir: string,
  node: string,
  aspectId: string,
): { hash: string; reason?: string; verdict: string } | undefined {
  return readLock(dir).verdicts[aspectId]?.[`node:${node}`];
}

/**
 * Author a self-contained deterministic aspect that flags any line containing
 * `literal`. Raw-content check (mirrors the fixture's `no-todo-comments`) — no
 * AST imports, fully hermetic, zero LLM cost. `status` is written verbatim, or
 * omitted entirely when `status === null` so the aspect-level default
 * (documented as `enforced`) can be exercised. The aspect is NOT attached
 * anywhere by default — each test attaches it on exactly the channel under test.
 */
function authorLiteralAspect(
  dir: string,
  id: string,
  literal: string,
  status: 'draft' | 'advisory' | 'enforced' | null,
): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  const yaml = [
    `name: ${id.replace(/-/g, '')}`,
    `description: Source files must not contain the literal token ${literal}.`,
    'reviewer:',
    '  type: deterministic',
    ...(status === null ? [] : [`status: ${status}`]),
    '',
  ];
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml.join('\n'), 'utf-8');
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(literal)})) {`,
      `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(
        `${literal} found.`,
      )} });`,
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// ASPECT-STATUS combinatorics — driven entirely through the real built binary.
// Covers the under-tested corners: effective-status max() involving DRAFT,
// default-to-enforced, multi-node status-flip cascade, verdict-hash (in)stability
// across the advisory<->enforced flip, the persisted refused-enforced verdict,
// the status_inherit chain, the draft-implier propagation path, and the all-draft
// skip. Each case asserts BOTH the `yg context` status tag AND the resulting
// block/warn/skip behavior at fill/check.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — aspect-status combinatorics (draft max(), flip cascade, defaults, persisted verdicts)', () => {
  // === Group A: effective-status max() across cascading channels with DRAFT ===

  // A1: max(draft, advisory) = advisory.
  // no-banned-word default DRAFT, attached on the parent NODE (channel 2) with
  // an explicit status:advisory. max(draft, advisory) -> advisory: context tags
  // it [advisory] and a violation is a NON-blocking warning (fill exits 0,
  // recorded but not blocking).
  it('A1: max(draft default, advisory attach) = advisory — context tags [advisory] and a violation does NOT block (warning, exit 0)', () => {
    const dir = hermeticFixture('max-draft-advisory');
    try {
      authorLiteralAspect(dir, 'no-banned-word', 'BANNED', 'draft');
      writeFileSync(
        servicesNodeYaml(dir),
        [
          'name: Services',
          "description: Organizational parent grouping the application's service units.",
          'type: module',
          'aspects:',
          '  - id: no-banned-word',
          '    status: advisory',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Effective status is advisory (max of draft default + advisory attach):
      // it is NO LONGER skipped (it carries a live `read:` line, not the draft
      // "reviewer skipped" note).
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');

      appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory does NOT block
      expect(fill.stderr).toContain('[det] no-banned-word on node:services/orders — refused');
      // The refusal renders as an advisory warning. The old per-issue WHAT line 0
      // ("Aspect '...' is refused on <unit>") is now the group header; assert the
      // grouped warning render — the advisory group naming the aspect and the
      // refusing node line.
      expect(fill.stdout).toMatch(/Warnings \(\d+\)( in \d+ groups)?:/);
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain("aspect 'no-banned-word'");
      expect(fill.stdout).toContain('- services/orders');
      expect(fill.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A2: max(draft, enforced) = enforced.
  // Same aspect default DRAFT, but the parent-node attach raises it to enforced.
  // max(draft, enforced) -> enforced: context tags [enforced] and a violation
  // BLOCKS (exit 1, refused).
  it('A2: max(draft default, enforced attach) = enforced — context tags [enforced] and a violation BLOCKS (exit 1)', () => {
    const dir = hermeticFixture('max-draft-enforced');
    try {
      authorLiteralAspect(dir, 'no-banned-word', 'BANNED', 'draft');
      writeFileSync(
        servicesNodeYaml(dir),
        [
          'name: Services',
          "description: Organizational parent grouping the application's service units.",
          'type: module',
          'aspects:',
          '  - id: no-banned-word',
          '    status: enforced',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');

      // A clean fill passes (the now-enforced aspect is satisfied).
      expect(run(['check', '--approve'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1); // enforced blocks
      expect(refused.stderr).toContain('[det] no-banned-word on node:services/orders — refused');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit>") is now
      // the group header; assert the grouped error render — the ENFORCED group
      // naming the aspect and the refusing node line.
      expect(refused.stdout).toContain('enforced');
      expect(refused.stdout).toContain("aspect 'no-banned-word'");
      expect(refused.stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group B: default-to-enforced when status is omitted ===

  // B3: an aspect with NO `status:` line in yg-aspect.yaml, attached with NO
  // status at the attach site, resolves to ENFORCED. context tags [enforced] and
  // a violation BLOCKS.
  it('B3: status omitted on BOTH the aspect default and the attach site resolves to enforced and blocks', () => {
    const dir = hermeticFixture('default-enforced');
    try {
      // authorLiteralAspect with status:null writes NO `status:` line.
      authorLiteralAspect(dir, 'no-marker', 'MARKER', null);
      // Attach bare (no `status:` at the attach site either) on the orders node.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - no-marker',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Sanity: the authored yaml truly has no status line, so this proves the
      // DEFAULT (not a written value) is what yields enforced.
      expect(readFileSync(aspectYaml(dir, 'no-marker'), 'utf-8')).not.toContain('status:');

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-marker [enforced]');

      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// MARKER here\n');
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('[det] no-marker on node:services/orders — refused');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit>") is now
      // the group header; assert the grouped error render — the ENFORCED group
      // (resolved from omitted-default) naming the aspect and the refusing node.
      expect(refused.stdout).toContain('enforced');
      expect(refused.stdout).toContain("aspect 'no-marker'");
      expect(refused.stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group C: a node whose EVERY effective aspect resolves to draft ===

  // C4: when every effective aspect on a node is draft, the node produces NO fill
  // pairs at all: the reviewer is skipped entirely, NO verdict is recorded, NO
  // source fingerprint is written for it, and `yg check` PASSES.
  it('C4: an all-draft node produces no pairs — no verdict, no source baseline, check PASSES', () => {
    const dir = hermeticFixture('all-draft');
    try {
      // Flip the two type-default aspects to draft. services/orders then has only
      // draft effective aspects: wip-rule (own, draft), no-todo-comments (type +
      // flow, now draft), requires-named-export (type, now draft).
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );
      writeFileSync(
        aspectYaml(dir, 'requires-named-export'),
        readFileSync(aspectYaml(dir, 'requires-named-export'), 'utf-8').replace(
          /^status: advisory$/m,
          'status: draft',
        ),
        'utf-8',
      );

      // context shows all three aspects as draft (each "reviewer skipped").
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('wip-rule [draft]');
      expect(ctx.stdout).toContain('no-todo-comments [draft]');
      expect(ctx.stdout).toContain('requires-named-export [draft]');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // No pairs to fill across the whole graph (both nodes are all-draft now).
      expect(fill.stderr).toContain('Filling 0 unverified pairs across 0 nodes');
      // No VERDICT is recorded for any draft aspect — the lock's verdicts map is
      // empty. (The fill still writes a per-node source fingerprint as routine
      // bookkeeping, but no draft aspect contributes a verdict.)
      expect(nodeVerdict(dir, 'services/orders', 'no-todo-comments')).toBeUndefined();
      expect(nodeVerdict(dir, 'services/orders', 'requires-named-export')).toBeUndefined();
      expect(nodeVerdict(dir, 'services/orders', 'wip-rule')).toBeUndefined();

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      // No draft node ever reports an unverified pair or a stale verdict.
      expect(check.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group D: multi-node cascade on a status FLIP of a SHARED aspect ===

  // D5: no-todo-comments is a type-default on `service`, so it is effective on
  // BOTH services/orders and services/payments. Flipping it draft -> enforced
  // leaves the pair WITHOUT a stored verdict on EVERY node that has it effective;
  // `yg check` reports `unverified` on both, and a single repo-wide
  // `yg check --approve` fills the missing verdict on both and clears it. (The
  // removed `aspect-newly-active` vocabulary maps to `unverified`.)
  it('D5: flipping a SHARED aspect draft->enforced leaves it unverified on EVERY effective node; one fill clears both', () => {
    const dir = hermeticFixture('flip-newly-active-multi');
    try {
      // Start with no-todo-comments DRAFT (dormant on both nodes). The advisory
      // requires-named-export keeps each node's effective set non-all-draft, so a
      // real verdict is written for both at the first fill.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );

      const initial = run(['check', '--approve'], dir);
      expect(initial.status).toBe(0);
      expect(initial.stdout).toContain('yg check: PASS');
      expect(run(['check'], dir).status).toBe(0);

      // Flip draft -> enforced. no-todo-comments now has no stored verdict on
      // either node.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: draft$/m,
          'status: enforced',
        ),
        'utf-8',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // unverified fires on BOTH nodes — the flip is graph-wide, not local. In the
      // grouped renderer the `unverified` label lives in the group HEADER while the
      // affected nodes are listed on separate `- <node>` lines under it (the two
      // pairs share one code+aspectId, so they collapse into a single group naming
      // both nodes). Assert the label + both node lines rather than expecting the
      // node path on the same line as the label.
      expect(drifted.stdout).toMatch(/unverified \((?:not yet reviewed|stale — inputs changed since the verdict|deterministic check not run on this checkout — free)\)/);
      // The aspect appears on each body line (not in the group header).
      expect(drifted.stdout).toContain("aspect 'no-todo-comments'");
      // Body lines include the aspect annotation per node.
      expect(drifted.stdout).toContain("- services/orders  aspect 'no-todo-comments'");
      expect(drifted.stdout).toContain("- services/payments  aspect 'no-todo-comments'");

      // A single repo-wide fill records the missing verdict on both nodes.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);

      // Cleared on both nodes.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // D6: flipping the SAME shared aspect enforced -> advisory is a RENDER flip,
  // not a re-fill. With a refused (TODO) verdict on BOTH nodes, the flip turns the
  // two BLOCKING errors into two NON-blocking warnings: `yg check` goes from FAIL
  // (2 errors) to PASS (2 warnings). The recorded refused verdicts are carried
  // forward unchanged (status is NOT in the verdict hash) — only their render
  // severity flips, with NO reviewer re-run.
  it('D6: flipping a SHARED aspect enforced->advisory flips block->warn on EVERY node (check FAIL -> PASS)', () => {
    const dir = hermeticFixture('flip-render-multi');
    try {
      // Plant a TODO in BOTH sources so no-todo-comments (enforced) refuses on
      // both nodes -> two persisted refused verdicts.
      appendFileSync(ordersFile(dir), '\n// TODO: orders debt\n');
      appendFileSync(paymentsFile(dir), '\n// TODO: payments debt\n');
      run(['check', '--approve'], dir);

      // While enforced: check FAILS with both nodes as blocking errors.
      const enforcedCheck = run(['check'], dir);
      expect(enforcedCheck.status).toBe(1);
      expect(enforcedCheck.stdout).toContain('FAIL');
      expect(enforcedCheck.stdout).toContain('enforced');

      // Flip enforced -> advisory. A bare status flip is NOT part of the verdict
      // hash, so the persisted refused verdict is carried forward verbatim — no
      // re-fill is needed; only the render severity flips.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: advisory',
        ),
        'utf-8',
      );

      const advisoryCheck = run(['check'], dir);
      // Block -> warn on BOTH nodes: the gate now PASSES with two warnings. In the
      // grouped renderer the `advisory` label lives in the Warnings group HEADER
      // while the affected nodes are listed on separate `- <node>` lines under it
      // (the two pairs share one code+aspectId, so they collapse into a single
      // group naming both nodes). Assert the label + both node lines rather than
      // expecting the node path on the same line as the label.
      expect(advisoryCheck.status).toBe(0);
      expect(advisoryCheck.stdout).toContain('PASS');
      expect(advisoryCheck.stdout).toMatch(/Warnings \(\d+\)( in \d+ groups)?:/);
      expect(advisoryCheck.stdout).toContain('advisory');
      // no-todo-comments is a FULL_WHAT code (aspect-violation-advisory), so each
      // node line carries its per-member Violations tail (`- <node>  Violations:`)
      // — match the node-line prefix rather than the bare node path.
      const advisoryLines = advisoryCheck.stdout.split('\n');
      expect(advisoryLines.some((l) => l.trim().startsWith('- services/orders'))).toBe(true);
      expect(advisoryLines.some((l) => l.trim().startsWith('- services/payments'))).toBe(true);
      expect(advisoryCheck.stdout).not.toContain('FAIL');
      // The violation is still recorded (not erased) — the lock keeps the refused
      // verdict with its reason; it just renders as a warning now.
      expect(nodeVerdict(dir, 'services/orders', 'no-todo-comments')?.verdict).toBe('refused');
      expect(nodeVerdict(dir, 'services/orders', 'no-todo-comments')?.reason).toContain('TODO comment found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group E: verdict-hash (in)stability across the advisory<->enforced flip ===

  // E7: the per-pair canonical verdict hash and the advisory<->enforced flip.
  //
  //   CONTRACT: status is NOT part of the canonical verdict hash. A bare
  //   advisory<->enforced flip — check.mjs and source byte-for-byte unchanged —
  //   does NOT invalidate the verdict, so the pair stays VALID, there is nothing
  //   to re-fill, and both the per-pair verdict hash and the per-node source hash
  //   stay stable. (A draft<->non-draft transition is still surfaced, but via
  //   `unverified`, covered by D5; the render-severity flip is covered by D6.)
  it('E7: a bare enforced->advisory status flip does NOT invalidate the verdict; the canonical hashes stay stable', () => {
    const dir = hermeticFixture('hash-flip-stable');
    try {
      run(['check', '--approve'], dir);
      const verdictBefore = nodeVerdict(dir, 'services/orders', 'no-todo-comments')?.hash;
      expect(verdictBefore).toBeTruthy();

      // Flip ONLY the status line — check.mjs and source are unchanged.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: advisory',
        ),
        'utf-8',
      );

      // No re-fill needed: status is not part of the verdict hash. The aspect
      // passes (orders.ts has no TODO), so advisory renders nothing → check clean.
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(0);
      expect(drifted.stdout).not.toContain('unverified');

      // The recorded verdict hash is unchanged — a status flip is not drift, so
      // there is nothing to re-fill and the verdict is untouched. (services is not
      // log_required, so it carries no source hash to compare.)
      expect(nodeVerdict(dir, 'services/orders', 'no-todo-comments')?.hash).toBe(verdictBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group F: a REFUSED enforced verdict is PERSISTED in the lock ===

  // F8: filling a node whose enforced aspect is violated writes a lock entry that
  // RECORDS the refused verdict (verdict:refused, reason naming the violation). A
  // SECOND `yg check` then renders the stored refusal as a blocking error WITHOUT
  // re-running the reviewer — the source is unchanged, so the verdict is read
  // straight from the lock (cached).
  it('F8: a refused ENFORCED verdict is persisted in the lock and a second check renders it without re-running', () => {
    const dir = hermeticFixture('refused-persisted');
    try {
      // Violate the enforced no-todo-comments and fill -> refused, exit 1.
      appendFileSync(ordersFile(dir), '\n// TODO: persisted refusal\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.stderr).toContain('[det] no-todo-comments on node:services/orders — refused');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit>") is now
      // the group header; assert the grouped enforced render — the aspect-named
      // group and the refusing node line.
      expect(fill.stdout).toContain('enforced');
      expect(fill.stdout).toContain("aspect 'no-todo-comments'");
      expect(fill.stdout).toContain('- services/orders');

      // The lock records the REFUSED verdict (not merely absent), with the reason.
      const verdict = nodeVerdict(dir, 'services/orders', 'no-todo-comments');
      expect(verdict?.verdict).toBe('refused');
      expect(verdict?.reason).toContain('TODO comment found');

      // A second check renders the STORED refusal as a blocking enforced error.
      // The source is unchanged since the fill, so this is NOT an unverified pair
      // — the verdict comes straight from the persisted lock (cached, no re-run).
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('enforced');
      expect(check.stdout).toContain('services/orders');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit> by a
      // deterministic check.") is now the group header; assert the grouped enforced
      // render — the aspect-named group, the refusing node line, and the shared
      // `why` confirming the verdict is read from the lock (cached, not re-run).
      expect(check.stdout).toContain("aspect 'no-todo-comments'");
      expect(check.stdout).toContain('- services/orders');
      expect(check.stdout).toContain('cached');
      // It is rendered from the lock, not re-flagged as a new unverified pair.
      expect(check.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group G: status_inherit chain for implies ===

  // G9: status_inherit `strictest` (the default) propagates the STRICTEST status
  // down a MULTI-LEVEL implies chain. no-todo-comments (enforced, the service
  // type-default) strictest-implies impA (own default advisory); impA
  // strictest-implies impB (own default advisory). Each level takes
  // max(implier_effective, own_default), so both impA and impB are promoted to
  // [enforced] transitively, and a violation of the deepest one BLOCKS the fill.
  it('G9: strictest status_inherit promotes advisory-default implied aspects to enforced TRANSITIVELY across a 2-level chain', () => {
    const dir = hermeticFixture('status-inherit-chain');
    try {
      // impA and impB both default ADVISORY, attached nowhere except via implies.
      authorLiteralAspect(dir, 'imp-a', 'AAA', 'advisory');
      authorLiteralAspect(dir, 'imp-b', 'BBB', 'advisory');
      // impA strictest-implies impB (bare `implies:` -> strictest default).
      writeFileSync(
        aspectYaml(dir, 'imp-a'),
        [
          'name: impa',
          'description: Source files must not contain the literal token AAA.',
          'reviewer:',
          '  type: deterministic',
          'status: advisory',
          'implies:',
          '  - imp-b',
          '',
        ].join('\n'),
        'utf-8',
      );
      // no-todo-comments (enforced) strictest-implies impA.
      appendFileSync(aspectYaml(dir, 'no-todo-comments'), 'implies:\n  - imp-a\n');

      // Both implied aspects render [enforced] — promoted from their advisory
      // own-default by the strictest cascade flowing through the chain.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('imp-a [enforced]');
      expect(ctx.stdout).toContain('imp-b [enforced]');
      expect(ctx.stdout).toContain("implied by 'no-todo-comments'");
      expect(ctx.stdout).toContain("implied by 'imp-a'");

      // A violation of the DEEPEST (2-level) implied aspect blocks the fill,
      // confirming the promotion to enforced is real (not cosmetic).
      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// BBB token\n');
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('[det] imp-b on node:services/orders — refused');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit>") is now
      // the group header; assert the grouped render — the ENFORCED group (proving
      // the transitive advisory->enforced promotion is real, not cosmetic) naming
      // the deepest implied aspect and the refusing node line.
      expect(refused.stdout).toContain('enforced');
      expect(refused.stdout).toContain("aspect 'imp-b'");
      expect(refused.stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // G10: a DRAFT implier is dormant for implies SET membership — it does NOT pull
  // its implied aspect into the node's effective set. Both the effective-SET
  // (expandImpliesFiltered) and the status MAP skip draft impliers, so the
  // implied aspect is absent from context and never evaluated at fill.
  it('G10: a DRAFT implier does NOT propagate its implied aspect (dormant); context omits it and the fill does not block', () => {
    const dir = hermeticFixture('draft-implier-dormant');
    try {
      // draft-implier: DRAFT. implied-by-draft: own default enforced, attached
      // NOWHERE except via the draft implier's implies edge.
      authorLiteralAspect(dir, 'draft-implier', 'DDD', 'draft');
      authorLiteralAspect(dir, 'implied-by-draft', 'EEE', 'enforced');
      writeFileSync(
        aspectYaml(dir, 'draft-implier'),
        [
          'name: draftimplier',
          'description: Source files must not contain the literal token DDD.',
          'reviewer:',
          '  type: deterministic',
          'status: draft',
          'implies:',
          '  - implied-by-draft',
          '',
        ].join('\n'),
        'utf-8',
      );
      // Attach the DRAFT implier on the orders node (channel 1). It is the ONLY
      // path to implied-by-draft.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - draft-implier',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The draft implier is shown skipped, and the dormant implier does NOT pull
      // its implied aspect into the effective set.
      expect(ctx.stdout).toContain('draft-implier [draft]');
      // implied-by-draft is NOT an effective aspect entry (only the implier's
      // "Implies:" metadata line names it, never as `implied-by-draft [status]`).
      expect(ctx.stdout).not.toContain('implied-by-draft [');
      expect(ctx.stdout).not.toContain("implied by 'draft-implier'");

      // Its violation does NOT block the fill — the implied aspect is dormant.
      appendFileSync(ordersFile(dir), '\n// EEE token\n');
      const result = run(['check', '--approve'], dir);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Aspect 'implied-by-draft' is refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group H: a fully-draft aspect is dormant everywhere ===

  // H11: an aspect whose default status is draft is skipped on every node — it
  // produces NO fill pair anywhere, so a repo-wide `yg check --approve` records no
  // verdict for it and the run stays clean (exit 0). (The old `approve --aspect`
  // batch target is gone; fill is repo-wide.)
  it('H11: a draft-default aspect produces no pair on any node — fill records no verdict for it and exits 0', () => {
    const dir = hermeticFixture('approve-aspect-draft');
    try {
      // Flip no-todo-comments to draft so it is fully dormant.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );
      // Plant a TODO in both sources — a draft aspect must NOT flag it.
      appendFileSync(ordersFile(dir), '\n// TODO: dormant draft debt\n');
      appendFileSync(paymentsFile(dir), '\n// TODO: dormant draft debt\n');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // The draft aspect never appears as a fill pair on either node.
      expect(fill.stdout).not.toContain('[det] no-todo-comments');
      expect(fill.stdout).toContain('yg check: PASS');
      // The lock records no verdict for the dormant draft aspect.
      expect(readLock(dir).verdicts['no-todo-comments']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
