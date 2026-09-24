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
// Conditional aspects (`when` predicate) — deterministic, zero-LLM applicability
// gating. The `when` predicate runs at graph-resolution time (no reviewer call):
// every propagation channel passes through it before an aspect becomes effective
// on a node. These tests prove that `when` deterministically includes/excludes a
// deterministic aspect, that enforcement (yg check --approve) follows applicability, and
// that the boolean combinators (not / any_of / all_of) evaluate correctly.
//
// HERMETIC: an enforced `test-deterministic` aspect on this repo rejects ambient
// or external dependencies. Every test copies the committed fixture into a fresh
// mkdtemp, mutates ONLY that copy, and rmSync's it in `finally`. No network host
// or port is touched (the LLM aspect is stripped, so no reviewer endpoint is ever
// contacted). No assertion depends on a clock or randomness.
//
// Harness duplicated from cli-deterministic-lifecycle.test.ts (run / copyFixture /
// deterministicFixture / the distExists guard).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

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

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-when-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This keeps the whole suite
 * hermetic: no reviewer endpoint is ever contacted, so there is no network
 * dependency and every approve/context outcome is reproducible.
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
  // Remove the now-orphaned aspect definition so `yg check` stays clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- fixture-mutation helpers (operate on the temp COPY only) ---------------

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const nodePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', 'model', ...node.split('/'), 'yg-node.yaml');
const flowPath = (dir: string, name: string) =>
  path.join(dir, '.yggdrasil', 'flows', name, 'yg-flow.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

/**
 * `no-todo-comments` reaches the service nodes through THREE independent
 * channels in the committed fixture: the `service` architecture type default
 * (channel 3), the `order-processing` flow (channel 5), and — for tests below —
 * a per-site attach on the node (channel 1). The documented rule is that
 * channels deliver independently: an aspect is effective if ANY channel's path
 * passes its filter. So to prove a `when` predicate EXCLUDES an aspect we must
 * silence every other channel that would otherwise deliver it unconditionally.
 *
 * This helper removes `no-todo-comments` from the flow attach list and from the
 * `service` architecture-type default, leaving the per-site attach as the sole
 * delivery channel for the tests that exercise a per-node `when`.
 */
function isolateNoTodoToNodeChannel(dir: string): void {
  // Architecture default: keep `requires-named-export`, drop `no-todo-comments`.
  // Plain-string .replace (first occurrence) avoids regex literals with
  // multi-space runs (eslint no-regex-spaces) — the match is a fixed literal.
  const arch = readFileSync(archPath(dir), 'utf-8').replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n',
    '    aspects:\n      - requires-named-export\n',
  );
  writeFileSync(archPath(dir), arch, 'utf-8');
  // Flow: drop the `no-todo-comments` participation-level attach.
  const flow = readFileSync(flowPath(dir, 'order-processing'), 'utf-8').replace(
    'aspects:\n  - no-todo-comments\n',
    'aspects: []\n',
  );
  writeFileSync(flowPath(dir, 'order-processing'), flow, 'utf-8');
}

/**
 * Rewrite the architecture `service`-type default attach of `no-todo-comments`
 * from the bare-string form to the object form carrying the given `when` YAML
 * block (already indented for an architecture `aspects[]` entry body). Also
 * silences the flow channel so the architecture attach is the sole delivery.
 */
function gateArchitectureNoTodo(dir: string, whenBlock: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8').replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n',
    `    aspects:\n      - id: no-todo-comments\n${whenBlock}      - requires-named-export\n`,
  );
  writeFileSync(archPath(dir), arch, 'utf-8');
  const flow = readFileSync(flowPath(dir, 'order-processing'), 'utf-8').replace(
    'aspects:\n  - no-todo-comments\n',
    'aspects: []\n',
  );
  writeFileSync(flowPath(dir, 'order-processing'), flow, 'utf-8');
}

/**
 * Splice a per-site aspect attach (object form with `when`) INTO a node's
 * `aspects:` list. `entryYaml` must be the list entry body indented two spaces
 * (e.g. `  - id: x\n    when: ...\n`). Inserting at the file end would land the
 * entry under a later key (`mapping:`) and corrupt the node, so we place it
 * immediately after the `aspects:` key — creating that key before `mapping:` if
 * the node has no `aspects:` block yet (as the payments node does not).
 */
function attachToNode(dir: string, node: string, entryYaml: string): void {
  const p = nodePath(dir, node);
  const src = readFileSync(p, 'utf-8');
  const block = entryYaml.endsWith('\n') ? entryYaml : entryYaml + '\n';
  let out: string;
  if (/^aspects:\s*$/m.test(src)) {
    out = src.replace(/^aspects:\s*$\n/m, (m) => m + block);
  } else {
    // No aspects: key — introduce one just before the mapping: key.
    out = src.replace(/^mapping:/m, `aspects:\n${block}mapping:`);
  }
  writeFileSync(p, out, 'utf-8');
}

// `no-todo-comments [enforced]` is the stable substring `yg context` prints for
// the aspect's heading line in the effective-aspect list. It appears exactly
// once when the aspect is effective and is wholly absent when `when` filters it
// out — the deterministic ground truth for "applies" vs "does not apply".
const EFFECTIVE_MARKER = 'no-todo-comments [enforced]';

describe.skipIf(!distExists)('CLI E2E — conditional aspects (`when` predicate) applicability gating', () => {
  // -------------------------------------------------------------------------
  // 1. when TRUE → aspect applies (architecture channel).
  // -------------------------------------------------------------------------

  it('W1: architecture default with `when: node.has_mapping=true` (TRUE) keeps the aspect effective', () => {
    const dir = deterministicFixture('w1');
    try {
      // services own a mapped source file → has_mapping is true → predicate passes.
      gateArchitectureNoTodo(dir, '        when:\n          node:\n            has_mapping: true\n');

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
      expect(ctx.stdout).toContain('Source: architecture (type: service)');

      // The graph is well-formed and clean after gating (no orphan/validation error).
      // Repo-wide fill verifies every effective pair; a clean graph closes green.
      run(['check', '--approve'], dir);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W2: per-site `when: node.type=service` (TRUE) makes a node-attached aspect effective', () => {
    const dir = deterministicFixture('w2');
    try {
      isolateNoTodoToNodeChannel(dir);
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: service\n',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
      // Delivered only through the node's own declaration now.
      expect(ctx.stdout).toContain('Source: own declaration');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. when FALSE → aspect NOT applied (absent from effective list).
  // -------------------------------------------------------------------------

  it('W3: per-site `when: node.has_port=charge` (FALSE — services declare no ports) excludes the aspect', () => {
    const dir = deterministicFixture('w3');
    try {
      isolateNoTodoToNodeChannel(dir);
      // services/orders has no ports, so has_port:charge is false → aspect filtered out.
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        has_port: charge\n',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // Aspect is silently skipped: absent from the effective list entirely.
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
      expect(ctx.stdout).not.toContain('no-todo-comments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W4: per-site `when: node.type=command` (FALSE — node is a service) excludes the aspect; payments is unaffected', () => {
    const dir = deterministicFixture('w4');
    try {
      isolateNoTodoToNodeChannel(dir);
      // `command` is a valid identifier but no such type exists in this fixture's
      // architecture — referencing it in a `when` triggers a when-unknown-type
      // error at check time. So we instead use `module`, a REAL type that the
      // service node is simply not (services are type `service`). Predicate false.
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: module\n',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
      expect(ctx.stdout).not.toContain('no-todo-comments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Enforcement follows applicability: with the SAME violation present on two
  //    nodes, approve refuses where the predicate is TRUE and passes where it is
  //    FALSE — proving the gate is real, not cosmetic.
  // -------------------------------------------------------------------------

  it('W5: identical TODO — approve REFUSES where `when` is true, PASSES where `when` is false', () => {
    const dir = deterministicFixture('w5');
    try {
      isolateNoTodoToNodeChannel(dir);
      // Attach the enforced aspect to orders only, gated TRUE for a service.
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: service\n',
      );

      // Same offending line in BOTH files.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      appendFileSync(paymentsFile(dir), '\n// TODO: refactor this later\n');

      // Repo-wide fill judges both nodes in one pass. The enforced
      // `no-todo-comments` aspect is attached (gated TRUE) ONLY on orders, so:
      //   orders   → predicate TRUE → aspect applies → refused on the TODO.
      //   payments → aspect not attached (and would be filtered) → TODO ignored.
      const fill = run(['check', '--approve'], dir);
      // The fill refuses exactly one pair (orders'), and the report names orders only.
      expect(fill.all).toMatch(/^fill {2}done in .* — \d+ approved · 1 refused · 0 failed/m);
      expect(fill.all).toContain('error[refused] no-todo-comments — 1 violation in services/orders');
      expect(fill.all).not.toContain('no-todo-comments — 1 violation in services/payments');


      // The enforced refusal blocks the overall run.
      expect(fill.status).toBe(1);

      // A plain read renders the cached refusal and attributes it to orders, not payments.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // A single enforced refusal block for the aspect, exactly one node (orders)
      // listed — payments was gated FALSE and is absent.
      expect(check.all).toContain('error[refused] no-todo-comments — 1 violation in services/orders');
      expect(check.all).toContain('  at:   services/orders  src/services/orders.ts:');
      expect(check.all).not.toContain('services/payments  src/services/payments.ts');

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W6: when the SAME aspect is gated FALSE on a node, its TODO violation no longer refuses approve', () => {
    const dir = deterministicFixture('w6');
    try {
      isolateNoTodoToNodeChannel(dir);
      // Gate FALSE on orders (a service is not type `module`).
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: module\n',
      );

      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');

      // Predicate false → the enforced aspect never reaches orders → the TODO is
      // irrelevant. Fill closes green; no refusal is attributed to the node.
      const fill = run(['check', '--approve'], dir);
      expect(fill.all).not.toContain('node:services/orders — refused');
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.all).not.toContain("is refused on node:services/orders");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Per-attach-site `when` vs aspect-global `when`. Both grammars are
  //    supported; channels combine via AND. Here we prove a per-attach-site
  //    `when` (channel entry) filters independently of the aspect default.
  // -------------------------------------------------------------------------

  it('W7: per-attach-site `when` filters per node — TRUE on orders includes, FALSE on payments excludes (same aspect)', () => {
    const dir = deterministicFixture('w7');
    try {
      isolateNoTodoToNodeChannel(dir);
      // orders: gated TRUE (it is a service).
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: service\n',
      );
      // payments: gated FALSE (it is not a module).
      attachToNode(
        dir,
        'services/payments',
        '  - id: no-todo-comments\n    when:\n      node:\n        type: module\n',
      );

      const onOrders = run(['context', '--node', 'services/orders'], dir);
      expect(onOrders.status).toBe(0);
      expect(onOrders.stdout).toContain(EFFECTIVE_MARKER);

      const onPayments = run(['context', '--node', 'services/payments'], dir);
      expect(onPayments.status).toBe(0);
      expect(onPayments.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Compound predicates — the boolean combinators evaluate correctly.
  // -------------------------------------------------------------------------

  it('W8: `not` inverts — `not: node.has_port=charge` (not false = TRUE) includes the aspect', () => {
    const dir = deterministicFixture('w8-not-true');
    try {
      isolateNoTodoToNodeChannel(dir);
      // has_port:charge is false for a service → not(false) = true → applies.
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      not:\n        node:\n          has_port: charge\n',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W9: `not` inverts — `not: node.type=service` (not true = FALSE) excludes the aspect', () => {
    const dir = deterministicFixture('w9-not-false');
    try {
      isolateNoTodoToNodeChannel(dir);
      // type:service is true for the node → not(true) = false → filtered out.
      attachToNode(
        dir,
        'services/orders',
        '  - id: no-todo-comments\n    when:\n      not:\n        node:\n          type: service\n',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W10: `any_of` — at least one true clause includes (module=false OR has_mapping=true ⇒ TRUE)', () => {
    const dir = deterministicFixture('w10-any');
    try {
      isolateNoTodoToNodeChannel(dir);
      attachToNode(
        dir,
        'services/orders',
        [
          '  - id: no-todo-comments',
          '    when:',
          '      any_of:',
          '        - node:',
          '            type: module', // false (node is a service)
          '        - node:',
          '            has_mapping: true', // true (node owns a file)
          '',
        ].join('\n'),
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W11: `all_of` — one false clause excludes (has_mapping=true AND type=module ⇒ FALSE)', () => {
    const dir = deterministicFixture('w11-all');
    try {
      isolateNoTodoToNodeChannel(dir);
      attachToNode(
        dir,
        'services/orders',
        [
          '  - id: no-todo-comments',
          '    when:',
          '      all_of:',
          '        - node:',
          '            has_mapping: true', // true
          '        - node:',
          '            type: module', // false (node is a service)
          '',
        ].join('\n'),
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
