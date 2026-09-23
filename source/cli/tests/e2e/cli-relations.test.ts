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

// ---------------------------------------------------------------------------
// Harness — duplicated here because e2e test files do not share a module.
// Pattern mirrors cli-deterministic-lifecycle.test.ts: spawn the REAL built
// binary against a fixture COPIED into a fresh mkdtemp dir, assert exit code
// plus stdout/stderr substrings. Every scenario is hermetic: fresh temp dir
// per test, rmSync cleanup in finally, no network host dependency, no clock
// or RNG reads in assertions.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');

const SAMPLE = path.join(FIXTURES, 'sample-project');
const BROKEN_RELATION = path.join(FIXTURES, 'sample-project-broken-relation');
const LIFECYCLE = path.join(FIXTURES, 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

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

/** Copy any fixture directory into a fresh temp dir for mutation. */
function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-rel-${label}-`));
  cpSync(source, dir, { recursive: true });
  return dir;
}

/**
 * Copy the e2e-lifecycle fixture and strip the LLM aspect (`has-doc-comment`)
 * so the `service` node type's effective aspects are purely deterministic.
 * This makes the approve/check lifecycle hermetic — no network, no LLM
 * verdict, fully reproducible. Mirrors deterministicFixture() in the lifecycle
 * suite.
 */
function deterministicLifecycleFixture(label: string): string {
  const dir = copyFixture(LIFECYCLE, label);
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

const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const paymentsSrc = (dir: string) =>
  path.join(dir, 'src', 'services', 'payments.ts');

describe.skipIf(!distExists)('CLI E2E — architecture relation rules, event pairing, relational cascade', () => {
  // -------------------------------------------------------------------------
  // 1. relation-broken — a relation pointing at a node that does not exist.
  //    The sample-project-broken-relation fixture declares
  //    orders/broken-service -> nonexistent/missing-target (type: uses).
  // -------------------------------------------------------------------------
  it('1: relation-broken — check fails when a relation target does not exist', () => {
    const dir = copyFixture(BROKEN_RELATION, 'broken');
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-broken');
      // The grouped block carries the shared unresolvable-dependency WHY.
      expect(stdout).toContain('This node declares a dependency on a node the graph does not contain');
      // It is attributed to the node that declares the broken relation.
      expect(stdout).toContain('orders/broken-service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. event-unpaired — an emits with no matching listens.
  //    sample-project pairs orders/order-service --emits order.created-->
  //    users/user-repo with users/user-repo --listens order.created-->
  //    orders/order-service. Removing the listens half leaves the emit
  //    unpaired.
  //
  //    NOTE ON ASSERTION: in the grouped check output the event-unpaired block
  //    attributes the unpaired relation to the EMITTER node and lists it under
  //    the group (the per-issue `what` that named both ends is no longer
  //    rendered). So we assert on the stable error code plus the emitter node
  //    path — the substrings the grouped output actually emits.
  // -------------------------------------------------------------------------
  it('2: event-unpaired — removing the listens half of an emits/listens pair fails check', () => {
    const dir = copyFixture(SAMPLE, 'event');
    try {
      const userRepoNode = path.join(
        dir,
        '.yggdrasil',
        'model',
        'users',
        'user-repo',
        'yg-node.yaml',
      );
      // Rewrite user-repo without the `listens order.created` relation block.
      writeFileSync(
        userRepoNode,
        [
          'name: UserRepo',
          'description: x',
          'type: repository',
          'mapping:',
          '- src/users/user.repository.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('event-unpaired');
      // The unpaired emit is attributed to the emitter in the group node list.
      expect(stdout).toContain('orders/order-service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. relation-target-forbidden — a relation pointing at a node whose TYPE
  //    the architecture does not allow as a target for that relation.
  //
  //    e2e-lifecycle architecture allows `service` to `uses: [service]` /
  //    `calls: [service]` only. The `services` parent node is type `module`,
  //    which is NOT an allowed target for a `uses` relation from a service.
  //    Pointing services/orders --uses--> services (module) is forbidden.
  // -------------------------------------------------------------------------
  it('3: relation-target-forbidden — uses pointing at a disallowed target type fails check', () => {
    const dir = deterministicLifecycleFixture('forbidden');
    try {
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          // `services` is type `module`; `uses` only allows `service`.
          '  - target: services',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-target-forbidden');
      // Attributed to the declaring node and naming the forbidden relation.
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('uses');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. high-fan-out — too many direct relations on a single node.
  //    sample-project's orders/order-service declares 3 relations. Lowering
  //    quality.max_direct_relations to 1 makes it exceed the threshold.
  //
  //    We assert the high-fan-out diagnostic appears. We deliberately do NOT
  //    over-assert the exit code: in this fixture the diagnostic surfaces as a
  //    blocking finding (non-zero exit), but the scenario only requires the
  //    warning to appear, so we just record that the exit code is non-null.
  // -------------------------------------------------------------------------
  it('4: high-fan-out — lowering max_direct_relations flags a node with multiple relations', () => {
    const dir = copyFixture(SAMPLE, 'fanout');
    try {
      const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      const cfg = readFileSync(cfgPath, 'utf-8').replace(
        /max_direct_relations:\s*\d+/,
        'max_direct_relations: 1',
      );
      writeFileSync(cfgPath, cfg, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(stdout).toContain('high-fan-out');
      // The node that exceeds the fan-out limit is named.
      expect(stdout).toContain('orders/order-service');
      // Exit code is captured but not pinned to a specific value.
      expect(status).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Structural dependency scope (verdict-lock model).
  //    Wire services/orders --uses--> services/payments, fill the lock, then
  //    exercise how edits to the dependency affect each node's verdicts.
  //
  //    CONVERTED behavior. The verdict-lock model is input-precise: a pair's
  //    verdict hash folds the node's own subject files + the aspect rule, and
  //    the frozen pair-hash contract EXCLUDES node/description metadata of a
  //    dependency ("prompt garnish, not a judgment input"). So:
  //      (a) editing the dependency's SOURCE leaves the dependency's own pairs
  //          unverified (source hash changed); the dependent is untouched —
  //          surviving behavior, now spelled `unverified` instead of the old
  //          `source-drift`/"Source files changed" vocabulary.
  //      (b) changing the dependency's yg-node.yaml METADATA (description) no
  //          longer cascades onto the dependent — the old
  //          "dependency 'services/payments' metadata changed" cascade was
  //          removed when verdicts became input-precise. This half is replaced
  //          by its now-correct counterpart: a dependency metadata reword keeps
  //          the dependent's verdict valid (no fill needed).
  // -------------------------------------------------------------------------
  it('5: structural dependency scope — a source edit leaves only the dependency unverified; a dependency metadata reword does not invalidate the dependent', () => {
    const dir = deterministicLifecycleFixture('cascade');
    try {
      // Wire orders --uses--> payments (allowed: service uses service).
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - target: services/payments',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Fill the lock; baseline check is clean.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // --- (a) Edit the dependency's SOURCE. Adds a named export so no
      // enforced aspect is violated; the file simply changes. ---
      appendFileSync(
        paymentsSrc(dir),
        '\nexport function describePayment(p: Payment): string {\n  return p.orderId;\n}\n',
      );

      const afterSourceEdit = run(['check'], dir);
      expect(afterSourceEdit.status).toBe(1);
      // The edited dependency's own pairs go unverified (its source hash moved).
      expect(afterSourceEdit.stdout).toContain('unverified');
      expect(afterSourceEdit.stdout).toContain('services/payments');
      // The dependent's ASPECT pairs are NOT dragged in by the dependency's
      // source edit (aspect-verdict scope is input-precise). The dependent's
      // RELATION verdict is a separate, legitimately-cascading input: orders
      // declares `uses: services/payments`, and a relation verdict folds in the
      // resolved dependency-target's source (so a target edit re-validates the
      // edge) — with live TypeScript extraction the orders relation verdict
      // therefore goes unverified here. That is correct, not a spurious drag, so
      // we scope the "dependent untouched" assertion to the aspect-pair
      // (`unverified`) lines, excluding the relation-conformance line.
      // (The relation-conformance message body itself contains the word
      // "unverified", so we exclude lines carrying the relation code rather than
      // matching on that word — only true aspect-pair lines should remain.)
      const orderAspectLines = afterSourceEdit.stdout
        .split('\n')
        .filter(
          (l) =>
            l.includes('services/orders') &&
            l.includes('unverified') &&
            !l.includes('relation-undeclared-dependency'),
        );
      expect(orderAspectLines.length).toBe(0);

      // Re-filling clears the dependency's unverified pairs.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // --- (b) Reword the dependency's METADATA (description only). Under the
      // verdict-lock model this does NOT cascade onto the dependent — the
      // dependent's verdict inputs are unchanged, so its verdict stays valid. ---
      writeFileSync(
        paymentsNodePath(dir),
        [
          'name: PaymentsService',
          'description: Charges and refunds payments for orders (updated wording).',
          'type: service',
          'mapping:',
          '  - src/services/payments.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const afterMetaChange = run(['check'], dir);
      // No cascade onto the dependent; check stays clean with no fill needed.
      expect(afterMetaChange.status).toBe(0);
      expect(afterMetaChange.stdout).toContain('PASS');
      expect(afterMetaChange.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. yg context --node — a node with relations lists its relation targets.
  //    sample-project's orders/order-service declares three relations.
  // -------------------------------------------------------------------------
  it('6: context --node lists a node\'s relation targets', () => {
    const dir = copyFixture(SAMPLE, 'context');
    try {
      const { status, stdout } = run(
        ['context', '--node', 'orders/order-service'],
        dir,
      );
      expect(status).toBe(0);
      // The relation targets and their relation types are listed.
      expect(stdout).toContain('auth/auth-api');
      expect(stdout).toContain('users/user-repo');
      expect(stdout).toContain('uses');
      expect(stdout).toContain('emits');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
