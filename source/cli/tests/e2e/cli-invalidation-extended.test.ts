import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// INVALIDATION — extended paths.
//
// In the verdict-lock model a stored verdict is valid only while its inputs hash
// to the recorded value. "Drift" and "cascade" are EMERGENT from that hashing —
// there is no typed cause attribution. This suite exercises the less-common
// invalidation paths the variety suite does not:
//   * CROSS-NODE observation — a graph-aware deterministic aspect on node A reads
//     a file owned by node B (reachable via a `uses` relation). Editing B's
//     source re-points A's pair to unverified; a re-fill re-runs only that one
//     local check at zero LLM cost.
//   * PARTIAL-FAILURE INDEPENDENCE — a single repo-wide fill processes every pair
//     independently: the clean nodes approve while one node's enforced aspect
//     refuses, and every per-pair line is printed.
//   * LOG GATE vs no-source re-fill — on a log_required node, a SOURCE change
//     blocks the fill until a fresh log entry exists, while an aspect-content
//     invalidation (no source change) re-fills with NO log entry.
//   * ALL-DRAFT node — a node whose only effective aspect is draft is never
//     unverified, even after a source edit.
//   * MULTIPLE simultaneous invalidation channels on one node, all surfaced,
//     cleared by one re-fill.
//   * PARTIAL mapping deletion — one of several mapped files removed surfaces
//     mapping-path-missing + unverified; restoring it byte-identically clears
//     both with no re-fill.
//   * NO-CHANGE re-fill — a zero-cost no-op that fills 0 pairs.
//
// Hermetic: each test builds its graph in a FRESH mkdtemp copy of the committed
// e2e-lifecycle fixture, strips the LLM `has-doc-comment` aspect so every
// effective aspect is deterministic (no network, no LLM), mutates only that copy,
// and rmSync's it in a finally. Every refuse/pass is driven solely by the
// deterministic check.mjs aspects plus authored-in graph-aware aspects.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-invex-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic — no network, no LLM verdict.
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

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const parentNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const noTodoCheckMjs = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');

/** Flip the `service` node type to log_required: true (default in the fixture is false). */
function makeServiceLogRequired(dir: string): void {
  const raw = readFileSync(archPath(dir), 'utf-8').replace(
    /(\n {2}service:\n(?: {4}[^\n]*\n)*? {4}log_required: )false/,
    '$1true',
  );
  writeFileSync(archPath(dir), raw, 'utf-8');
}

// A graph-aware deterministic aspect that reaches the DEPENDENCY node
// 'services/payments' (declared via a `uses` relation on orders) and flags a
// TODO marker in any of its files. Reading a cross-node file folds an
// observation into orders' verdict hash, so changing that file's content
// re-points orders' pair to unverified.
const CROSS_READ_TODO_CHECK = `export function check(ctx) {
  const violations = [];
  const dep = ctx.graph.node('services/payments');
  if (!dep) return violations;
  for (const file of dep.files) {
    if (file.content.includes('TODO')) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`Dependency file \${file.path} contains a TODO marker.\`,
      });
    }
  }
  return violations;
}
`;

/** Author the cross-read-todo deterministic aspect into the temp graph. */
function writeCrossReadAspect(dir: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'cross-read-todo');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: CrossReadTodo',
      'description: The dependency services/payments must not contain a TODO marker.',
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), CROSS_READ_TODO_CHECK, 'utf-8');
}

/**
 * Rewrite orders' yg-node.yaml to KEEP the draft `wip-rule` (so it stays
 * referenced), declare a `uses` relation to services/payments (widening the
 * allowed-reads boundary so the cross-node check can reach it), and attach the
 * cross-read-todo aspect.
 */
function wireOrdersToPayments(dir: string): void {
  writeFileSync(
    ordersNodeYaml(dir),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      '  - wip-rule',
      '  - cross-read-todo',
      'relations:',
      '  - type: uses',
      '    target: services/payments',
      'mapping:',
      '  - src/services/orders.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
}

// An uncapped `yg check --details` view lists every unverified pair as its own
// member line, `<aspect> @ <unit>`, under an `error[unverified]` /
// `warning[unverified]` block (the capped default view folds many pairs of one
// rule into a count line). To assert WHICH nodes are unverified for a given
// aspect, scan the member lines of the unverified blocks.
function unverifiedNodesForAspect(all: string, aspectId: string): string[] {
  const nodes: string[] = [];
  let inUnverified = false;
  for (const line of all.split('\n')) {
    const head = line.match(/^(?:error|warning)\[([^\]]+)\]/);
    if (head) { inUnverified = head[1].startsWith('unverified'); continue; }
    if (!line.startsWith(' ')) { inUnverified = false; continue; }
    if (!inUnverified) continue;
    const m = line.match(/^\s+(?:at:\s+)?(\S+) @ (\S+)\s*$/);
    if (m && m[1] === aspectId) nodes.push(m[2]);
  }
  return nodes;
}

describe.skipIf(!distExists)('CLI E2E — invalidation extended paths', () => {
  // -------------------------------------------------------------------------
  // 1. CROSS-NODE observation.
  //
  // A graph-aware deterministic aspect on services/orders reads a file owned by
  // services/payments (reachable via a declared `uses` relation). Because the
  // check accessed payments via ctx.graph.node, payments' source content folds
  // into orders' verdict hash. Editing the payments file therefore re-points
  // orders' cross-read-todo pair to unverified — while orders' OTHER pairs (which
  // never read payments) stay valid. A re-fill re-runs only the affected pairs.
  // -------------------------------------------------------------------------

  it('1: editing a file owned by node B re-points node A\'s graph-aware pair (only it) to unverified; a re-fill clears it', () => {
    const dir = deterministicFixture('cross');
    try {
      writeCrossReadAspect(dir);
      wireOrdersToPayments(dir);

      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Edit the CROSS-NODE file (owned by services/payments) with a benign,
      // non-TODO change: the cross-read check still passes, but its observed
      // content hash changed → orders' cross-read-todo pair goes unverified, and
      // payments' own pairs go unverified as ordinary source change.
      appendFileSync(paymentsFile(dir), '\n// benign cross-node edit\n');

      const drifted = run(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // The uncapped --details view lists every unverified pair as
      // "<aspect> @ <node>". Read which nodes are unverified for a given aspect
      // from those member lines.
      // The graph-aware pair on the DEPENDENT node is invalidated by the cross-node edit.
      expect(unverifiedNodesForAspect(drifted.all, 'cross-read-todo')).toContain('services/orders');
      // orders' OTHER aspects did NOT read payments, so they stay valid — orders
      // appears under NEITHER no-todo-comments nor requires-named-export.
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments')).not.toContain('services/orders');
      expect(unverifiedNodesForAspect(drifted.all, 'requires-named-export')).not.toContain('services/orders');
      // payments itself is invalidated as an ordinary source change.
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments')).toContain('services/payments');

      // A re-fill re-runs only the invalidated pairs (zero LLM — all deterministic).
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. PARTIAL-FAILURE INDEPENDENCE within one repo-wide fill.
  //
  // (The old per-node `yg approve --node A --node B --node C` batch is removed
  // surface — fill is repo-wide. The independence guarantee survives: every pair
  // is processed on its own, so one refusal does not abort the siblings.)
  // -------------------------------------------------------------------------

  it('2: a repo-wide fill processes every pair independently — clean nodes approve while one node\'s enforced aspect refuses', () => {
    const dir = deterministicFixture('independence');
    try {
      // Author a third clean service node, services/inventory.
      const invDir = path.join(dir, '.yggdrasil', 'model', 'services', 'inventory');
      mkdirSync(invDir, { recursive: true });
      writeFileSync(
        path.join(invDir, 'yg-node.yaml'),
        [
          'name: InventoryService',
          'description: Tracks stock levels for products.',
          'type: service',
          'mapping:',
          '  - src/services/inventory.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, 'src', 'services', 'inventory.ts'),
        [
          '// Inventory service — tracks stock levels.',
          'export interface Stock {',
          '  sku: string;',
          '  qty: number;',
          '}',
          'export function setStock(sku, qty) {',
          '  return { sku, qty };',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      // services/orders violates the enforced no-todo-comments aspect.
      appendFileSync(ordersFile(dir), '\n// TODO: orders violates on purpose\n');

      const fill = run(['check', '--approve'], dir);
      // Overall exit 1 because the enforced refusal makes the post-fill check fail.
      expect(fill.status).toBe(1);
      // Every pair is processed — the clean nodes approve.
      // The bad pair refuses — not aborted, its sibling pairs still ran.
      // The closing fill line counts them: five approved, the one bad pair refused.
      expect(fill.all).toMatch(/fill {2}done in .* — 5 approved · 1 refused · 0 failed/);
      // The refusal renders as an enforced error block in the post-fill check,
      // one member line per violation: the unit, the file:line, the message.
      expect(fill.all).toContain('error[refused] no-todo-comments — 1 violation in services/orders');
      expect(fill.all).toMatch(/ {2}at: {3}services\/orders {2}src\/services\/orders\.ts:\d+ {2}TODO comment found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. LOG GATE vs no-source re-fill.
  //
  // On a log_required node, a SOURCE change blocks the fill of that node's pairs
  // until a fresh log entry exists. An aspect-content invalidation (no source
  // change) needs NO fresh log entry. Both halves are asserted to make the
  // distinction load-bearing.
  // -------------------------------------------------------------------------

  it('3: a source change on a log_required node demands a fresh log entry, while an aspect-content re-fill (no source change) does not', () => {
    const dir = deterministicFixture('loggate');
    try {
      makeServiceLogRequired(dir);
      // Provide log entries, then fill clean.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'initial verification context for orders'], dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'initial verification context for payments'], dir);
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Half A — a SOURCE change with no fresh log entry: the fill skips that
      // node's pairs and prints the mandatory-log message.
      appendFileSync(ordersFile(dir), '\n// benign source edit needing a log\n');
      const noLog = run(['check', '--approve'], dir);
      expect(noLog.status).toBe(1);
      expect(noLog.all).toContain('yg check: ABORTED  nothing recorded — 1 node needs a log entry first');
      expect(noLog.all).toContain('error[log-entry-missing] 1 node changed with no log entry');
      expect(noLog.all).toMatch(/ {2}at: {3}services\/orders$/m);
      expect(noLog.all).toContain("next: yg log add --node services/orders --reason '<why this change was made>'");
      expect(noLog.all).toContain('log_required: true');

      // Provide the fresh log entry and re-fill — orders settles green.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'benign edit re-verified'], dir);
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Half B — an aspect-content invalidation (upstream-only; no source change).
      // The re-fill needs NO fresh log entry and succeeds.
      appendFileSync(noTodoCheckMjs(dir), '\n// no-op aspect comment\n');
      expect(run(['check'], dir).status).toBe(1);
      const reFill = run(['check', '--approve'], dir);
      expect(reFill.status).toBe(0);
      expect(reFill.all).not.toContain('log-entry-missing');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. ALL-DRAFT node — never unverified.
  //
  // A node whose ONLY effective aspect is draft is never flagged unverified and
  // never invalidates, even after a source edit. Authored as a new `widget` node
  // type with no default aspects, carrying only the draft `wip-rule`.
  // -------------------------------------------------------------------------

  it('4: an all-draft node with no cross-node dependency stays green across a source edit (no aspect pair, no live relation error)', () => {
    const dir = deterministicFixture('alldraft');
    try {
      appendFileSync(
        archPath(dir),
        [
          '',
          '  widget:',
          "    description: 'A widget whose only effective aspect is draft.'",
          '    log_required: false',
          '    when:',
          '      path: "src/widgets/**"',
          '    parents: [module]',
          '',
        ].join('\n'),
      );
      mkdirSync(path.join(dir, '.yggdrasil', 'model', 'widgets', 'gadget'), { recursive: true });
      mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'widgets', 'yg-node.yaml'),
        ['name: Widgets', 'description: Organizational parent grouping widgets.', 'type: module', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'widgets', 'gadget', 'yg-node.yaml'),
        [
          'name: Gadget',
          'description: A widget whose only effective aspect is draft.',
          'type: widget',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/widgets/gadget.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const gadgetFile = path.join(dir, 'src', 'widgets', 'gadget.ts');
      writeFileSync(
        gadgetFile,
        ['// Gadget widget — only a draft aspect applies here.', "export const gadget = { name: 'gadget' };", ''].join('\n'),
        'utf-8',
      );

      // Fill the real service nodes. The gadget has no enforceable ASPECT pair (draft
      // only) and no cross-node dependency, so it is silently green.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Green and the all-draft gadget is not named: it has no aspect pair, and the live
      // relation pass finds no cross-node dependency to flag.
      const before = run(['check'], dir);
      expect(before.status).toBe(0);
      expect(before.all).not.toContain('widgets/gadget');

      // Edit the gadget's source. The DRAFT aspect still has no pair to invalidate, and
      // relations are computed LIVE: the gadget imports nothing across a node boundary,
      // so a plain `yg check` (no --approve) stays green and never names the node.
      appendFileSync(gadgetFile, '\n// edited; no non-draft aspect cares\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(0); // no aspect pair, no live relation error
      expect(after.all).not.toContain('relation-undeclared-dependency');
      expect(after.all).not.toContain('widgets/gadget');
      // The draft aspect still produces NO aspect pair — no wip-rule verdict is ever named.
      expect(after.all).not.toContain('wip-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. MULTIPLE simultaneous invalidation channels on one node.
  //
  // A source edit (invalidates orders' pairs) + an aspect-content edit
  // (invalidates the no-todo-comments pair on every node) applied at once all
  // surface, and one repo-wide re-fill clears every one. (A description-only edit
  // to the parent node yaml is also applied here as a NEGATIVE control — it
  // changes no pair's inputs, so it adds no invalidation.)
  // -------------------------------------------------------------------------

  it('5: source edit + aspect-content edit at once all surface; a parent description edit adds nothing; one re-fill clears them', () => {
    const dir = deterministicFixture('multi');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// benign source edit\n'); // invalidates orders' pairs
      appendFileSync(noTodoCheckMjs(dir), '\n// aspect tweak\n'); // invalidates no-todo on every node
      appendFileSync(parentNodeYaml(dir), '\n# parent metadata tweak — NEGATIVE control\n'); // no input change

      const drifted = run(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // The uncapped --details view lists every unverified pair as
      // "<aspect> @ <node>". Read which nodes are unverified for a given aspect
      // from those member lines.
      // The aspect-content edit invalidates no-todo on BOTH nodes.
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments')).toContain('services/orders');
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments')).toContain('services/payments');
      // The source edit additionally invalidates orders' other deterministic aspect.
      expect(unverifiedNodesForAspect(drifted.all, 'requires-named-export')).toContain('services/orders');
      // NEGATIVE control: the parent metadata edit invalidated nothing — payments'
      // requires-named-export pair (untouched by either real edit) stays valid.
      expect(unverifiedNodesForAspect(drifted.all, 'requires-named-export')).not.toContain('services/payments');

      // One repo-wide re-fill clears every invalidation at once.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. PARTIAL mapping deletion.
  //
  // A node mapping several files loses ONE on disk: check reports
  // mapping-path-missing (plus unverified — the node's source hash changed).
  // Restoring the file with identical content clears both with no re-fill (the
  // byte-identical hash matches the stored verdict).
  // -------------------------------------------------------------------------

  it('6: deleting one of several mapped files surfaces mapping-path-missing + unverified; restoring it clears both', () => {
    const dir = deterministicFixture('partial-del');
    try {
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/orders.ts',
          '  - src/services/orders-helpers.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const helpersFile = path.join(dir, 'src', 'services', 'orders-helpers.ts');
      const helpersContent = [
        '// Orders helpers — secondary mapped file.',
        'export function fmtOrderId(id) {',
        '  return `ORD-${id}`;',
        '}',
        '',
      ].join('\n');
      writeFileSync(helpersFile, helpersContent, 'utf-8');

      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Delete ONE of the two mapped files.
      rmSync(helpersFile, { force: true });
      const drifted = run(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // The mapping-path-missing block names the missing path and the offending node.
      expect(drifted.all).toContain("error[mapping-path-missing] Mapping path 'src/services/orders-helpers.ts' does not exist on disk");
      expect(drifted.all).toContain('Node maps a file that was deleted or moved.');
      expect(drifted.all).toMatch(/ {2}at: {3}services\/orders$/m);
      // The deletion also changes the node's source hash → its pairs go unverified;
      // the member line "no-todo-comments @ services/orders" confirms it.
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments')).toContain('services/orders');

      // Restore the file byte-identically — both issues clear (the recorded
      // verdict's input hash matches again; no re-fill needed).
      writeFileSync(helpersFile, helpersContent, 'utf-8');
      const recovered = run(['check'], dir);
      expect(recovered.status).toBe(0);
      expect(recovered.all).not.toContain('mapping-path-missing');
      expect(recovered.all).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. NO-CHANGE re-fill — a zero-cost no-op.
  //
  // Re-running fill with nothing invalidated records nothing new and reports it
  // filled 0 pairs, exit 0.
  // -------------------------------------------------------------------------

  it('7: re-filling with nothing invalidated is a no-op — fills 0 pairs and exits 0', () => {
    const dir = deterministicFixture('nochange');
    try {
      const first = run(['check', '--approve'], dir);
      expect(first.status).toBe(0);
      expect(first.all).toContain('fill  4 pairs · 4 script (free) · 0 reviewer calls');
      expect(first.all).toMatch(/fill {2}done in .* — 4 approved · 0 refused · 0 failed · 0 reviewer calls/);

      // Nothing changed: the second fill is the true no-op.
      const second = run(['check', '--approve'], dir);
      expect(second.status).toBe(0);
      // A fill with nothing to do prints no fill line at all — no header, no
      // closing count — and the verdict line still holds every pair verified.
      expect(second.all).not.toMatch(/^fill {2}/m);
      expect(second.all).toContain('4 pairs verified');
      // A no-op re-runs no aspect.
      expect(second.all).not.toContain('approved');
      expect(second.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
