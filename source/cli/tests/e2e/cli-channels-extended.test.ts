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

// ---------------------------------------------------------------------------
// 7-CHANNEL PROPAGATION — remaining `when`-on-a-CASCADING-channel paths.
//
// cli-channels covers own/ancestor max() + the cross-channel downgrade error;
// cli-conditional-when covers `when` atoms on the OWN channel; cli-implies
// covers BASIC implies; cli-aspect-status-extended covers the multi-node flip
// and single-channel draft max(). This suite fills the gap: a `when` predicate
// gating an aspect that arrives via a CASCADING channel — the ANCESTOR-NODE
// channel (ch2), the ANCESTOR-TYPE channel (ch4), the IMPLIES edge (ch7, object
// form), and the FLOW channel (ch5) — proving the predicate is evaluated
// against the DESCENDANT/recipient node (not the attach point), include AND
// exclude, with enforcement following applicability. Plus a cross-channel
// applicability case (same aspect via two channels, `when` false on one) and an
// effective-status max() where one contributor is a DRAFT default cascading
// past a second channel that raises it to enforced.
//
// HERMETIC: every test copies the committed e2e-lifecycle fixture into a fresh
// mkdtemp, strips the LLM aspect (`has-doc-comment`), points the reviewer at a
// guaranteed-dead loopback endpoint, mutates ONLY that copy, and rmSync's in a
// finally. Every aspect exercised is a deterministic reviewer (zero LLM cost),
// so `yg check --approve` (repo-wide fill) makes no LLM call and plain spawnSync
// is safe. No network, no clock, no randomness in any assertion. Harness
// duplicated from cli-deterministic-lifecycle.test.ts so the file is
// self-contained.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint — port 1 never has a listener on any machine, so the
// LLM reviewer path is always unreachable with no reliance on a real endpoint
// being present or absent.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-chanx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Strip the LLM aspect so the node's effective aspects are purely deterministic. */
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
const archYaml = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const servicesNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const flowYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const noTodoYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'yg-aspect.yaml');

/**
 * Author a self-contained deterministic aspect `no-banned-word` flagging any
 * line containing the literal `BANNED`. Raw-content check (mirrors the fixture's
 * `no-todo-comments`) — no AST imports, fully hermetic, zero LLM cost. Default
 * status is `defaultStatus`. Attached NOWHERE by default — each test attaches it
 * on exactly the channel under test, so the `Source:` attribution is unambiguous.
 */
function authorBannedAspect(dir: string, defaultStatus: 'draft' | 'advisory' | 'enforced'): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'no-banned-word');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: NoBannedWord',
      'description: Source files must not contain the banned token BANNED.',
      'reviewer:',
      '  type: deterministic',
      `status: ${defaultStatus}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      '      if (lines[i].includes("BANNED")) {',
      '        violations.push({ file: file.path, line: i + 1, column: 0, message: "Banned token found." });',
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

/** Append a `BANNED` token to a source file so no-banned-word trips. */
function plantBanned(file: string): void {
  appendFileSync(file, '\n// BANNED token here\n');
}

/**
 * Write the standard 2-type architecture (module parent + service child). The
 * `module` (ancestor) type carries the verbatim `moduleAspectsBlock` (its
 * `aspects:` entries, already indented for a node-type body) so channel-4
 * (ancestor arch type) can be exercised with a `when`. The `service` type keeps
 * its fixture defaults so the existing nodes remain valid.
 */
function writeArchitecture(dir: string, moduleAspectsBlock: string[]): void {
  const lines = [
    'node_types:',
    '  module:',
    "    description: 'Organizational grouping of related services. Parent-only — has no file mapping.'",
    '    log_required: false',
    ...moduleAspectsBlock.map((l) => `    ${l}`),
    '',
    '  service:',
    "    description: 'Discrete service unit implemented as a single source file under src/services/.'",
    '    log_required: false',
    '    when:',
    '      path: "src/services/**"',
    '    parents: [module]',
    '    aspects:',
    '      - no-todo-comments',
    '      - requires-named-export',
    '    relations:',
    '      uses: [service]',
    '      calls: [service]',
    '',
  ];
  writeFileSync(archYaml(dir), lines.join('\n'), 'utf-8');
}

/** Re-author the `services` (module) parent node, optionally attaching aspect lines. */
function writeServicesNode(dir: string, aspectLines: string[]): void {
  const lines = [
    'name: Services',
    "description: Organizational parent grouping the application's service units.",
    'type: module',
    ...(aspectLines.length > 0 ? ['aspects:', ...aspectLines] : []),
    '',
  ];
  writeFileSync(servicesNodeYaml(dir), lines.join('\n'), 'utf-8');
}

// The stable substring `yg context` prints for an effective aspect's heading
// line. It appears exactly once when the aspect is effective and is wholly
// absent when `when` filters it out — the deterministic ground truth for
// "applies" vs "does not apply". `[enforced]` etc. encodes the effective status.
const EFFECTIVE = (status: string) => `no-banned-word [${status}]`;

describe.skipIf(!distExists)('CLI E2E — 7-channel `when` on cascading channels (ch2/ch4/ch5/ch7) + cross-channel applicability', () => {
  // =========================================================================
  // Group A — `when` on the ANCESTOR-NODE channel (ch2), evaluated against the
  // DESCENDANT. The aspect is attached on the PARENT node; the predicate is
  // checked against the CHILD that receives it.
  // =========================================================================

  it('A1: ch2 attach with `when: node.type=service` (TRUE on the child) — aspect reaches the descendant, enforced approve refuses', () => {
    const dir = hermeticFixture('ch2-when-include');
    try {
      authorBannedAspect(dir, 'enforced');
      // Attach on the PARENT `services` node, gated on the recipient being a service.
      writeServicesNode(dir, [
        '  - id: no-banned-word',
        '    when:',
        '      node:',
        '        type: service',
      ]);

      // The predicate is checked against the CHILD (a service) → included, and
      // attributed to the parent node (ch2).
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE('enforced'));
      expect(ctx.stdout).toContain("Source: inherited from parent 'services'");

      // Enforcement follows: a clean fill passes, a BANNED token refuses.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The refusal block names the refused rule on the child node (an error:
      // enforced), with the child's violation as its member line.
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      expect(refused.all).toContain('  at:   services/orders  src/services/orders.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: ch2 attach with `when: node.type=module` (FALSE on the service child) — aspect excluded, identical BANNED fills clean', () => {
    const dir = hermeticFixture('ch2-when-exclude');
    try {
      authorBannedAspect(dir, 'enforced');
      // The child is a `service`, not a `module` → predicate FALSE on the child.
      writeServicesNode(dir, [
        '  - id: no-banned-word',
        '    when:',
        '      node:',
        '        type: module',
      ]);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // Silently skipped: absent from the effective list entirely.
      expect(ctx.stdout).not.toContain('no-banned-word');

      // The SAME BANNED token that refused in A1 now fills clean — the gate is
      // real, not cosmetic. No no-banned-word pair is filled or refused.
      plantBanned(ordersFile(dir));
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      expect(fill.all).not.toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: ch2 `when: relations.calls.target_type=service` (a RELATIONS atom) is evaluated against the DESCENDANT’s OWN relations — excluded until the child declares the relation', () => {
    const dir = hermeticFixture('ch2-when-relations');
    try {
      authorBannedAspect(dir, 'enforced');
      // ch2 attach gated on the RECIPIENT having a calls→service relation.
      writeServicesNode(dir, [
        '  - id: no-banned-word',
        '    when:',
        '      relations:',
        '        calls:',
        '          target_type: service',
      ]);

      // orders declares no relations yet → predicate FALSE on the child → excluded.
      const before = run(['context', '--node', 'services/orders'], dir);
      expect(before.status).toBe(0);
      expect(before.stdout).not.toContain('no-banned-word');

      // Give the CHILD a calls→service relation; the SAME ch2 attach now passes
      // because the predicate sees the descendant's own relations.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - type: calls',
          '    target: services/payments',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const after = run(['context', '--node', 'services/orders'], dir);
      expect(after.status).toBe(0);
      expect(after.stdout).toContain(EFFECTIVE('enforced'));
      expect(after.stdout).toContain("Source: inherited from parent 'services'");

      // And it now enforces: a BANNED token refuses.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The refusal block names the refused rule on the child node (an error:
      // enforced), with the child's violation as its member line.
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      expect(refused.all).toContain('  at:   services/orders  src/services/orders.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Group B — `when` on the ANCESTOR-TYPE channel (ch4). The default aspect is
  // declared on the PARENT type (`module`); the predicate is checked against the
  // descendant node that inherits it.
  // =========================================================================

  it('B1: ch4 type-default with `when: node.has_mapping=true` (TRUE on the mapped child) — descendant inherits it, enforced approve refuses', () => {
    const dir = hermeticFixture('ch4-when-include');
    try {
      authorBannedAspect(dir, 'enforced');
      // Declare on the `module` (ancestor) type, gated on the recipient owning files.
      writeArchitecture(dir, [
        'aspects:',
        '  - id: no-banned-word',
        '    when:',
        '      node:',
        '        has_mapping: true',
      ]);
      writeServicesNode(dir, []);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE('enforced'));
      expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');

      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The refusal block names the refused rule on the child node (an error:
      // enforced), with the child's violation as its member line.
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      expect(refused.all).toContain('  at:   services/orders  src/services/orders.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: ch4 type-default with `when: descendants.type=service` (a DESCENDANTS atom) — FALSE on a leaf child (no descendants), TRUE on the parent that has service descendants', () => {
    const dir = hermeticFixture('ch4-when-descendants');
    try {
      authorBannedAspect(dir, 'enforced');
      // Declare on `module`, gated on the RECIPIENT having a service descendant.
      writeArchitecture(dir, [
        'aspects:',
        '  - id: no-banned-word',
        '    when:',
        '      descendants:',
        '        type: service',
      ]);
      writeServicesNode(dir, []);

      // services/orders is a leaf — it has no service descendants → excluded.
      const onLeaf = run(['context', '--node', 'services/orders'], dir);
      expect(onLeaf.status).toBe(0);
      expect(onLeaf.stdout).not.toContain('no-banned-word');

      // The `services` module node DOES have service descendants (orders,
      // payments) → the SAME ch4 default applies there. Proves the descendants
      // atom is evaluated against the recipient node's own subtree.
      const onParent = run(['context', '--node', 'services'], dir);
      expect(onParent.status).toBe(0);
      expect(onParent.stdout).toContain(EFFECTIVE('enforced'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Group C — `when` on the IMPLIES edge (ch7, object form). The implier
  // (no-todo-comments, the service type-default) implies no-banned-word ONLY
  // when the edge's `when` passes on the node.
  // =========================================================================

  it('C1: implies-edge `when: node.type=service` (TRUE) — the implied aspect is effective via ch7 and its violation refuses approve', () => {
    const dir = hermeticFixture('ch7-when-include');
    try {
      authorBannedAspect(dir, 'enforced');
      // no-todo-comments implies no-banned-word, gated TRUE for a service node.
      writeFileSync(
        noTodoYaml(dir),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'implies:',
          '  - id: no-banned-word',
          '    when:',
          '      node:',
          '        type: service',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The implied aspect's effective heading is present, attributed to ch7.
      expect(ctx.stdout).toContain(EFFECTIVE('enforced'));
      expect(ctx.stdout).toContain("implied by 'no-todo-comments'");

      // Enforced via the implies edge: a BANNED token refuses, while the implier
      // itself (no TODO present) is satisfied.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-banned-word');
      // Fill-time progress goes to STDERR (its closing line counts the refusal); the report to STDOUT.
      expect(refused.stderr).toMatch(/^fill {2}done in .* — \d+ approved · 1 refused · 0 failed/m);
      // The refusal block (an error: enforced) names the node.
      expect(refused.stdout).toContain('error[refused] no-banned-word — 1 violation in services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: implies-edge `when: node.type=module` (FALSE on the service) — the implied aspect is NOT in the effective set and its violation does NOT refuse', () => {
    const dir = hermeticFixture('ch7-when-exclude');
    try {
      authorBannedAspect(dir, 'enforced');
      // Same implies edge but gated FALSE (the node is a service, not a module).
      writeFileSync(
        noTodoYaml(dir),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'implies:',
          '  - id: no-banned-word',
          '    when:',
          '      node:',
          '        type: module',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The implier still advertises the edge in its own `Implies:` line, but the
      // implied aspect's effective HEADING is absent — it never entered the set.
      expect(ctx.stdout).toContain('Implies: no-banned-word');
      expect(ctx.stdout).not.toContain(EFFECTIVE('enforced'));

      // A BANNED token fills clean — the implied aspect was filtered out.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      expect(fill.stdout).not.toContain(
        'no-banned-word\' is refused',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Group D — `when` on the FLOW channel (ch5). The flow attaches the aspect
  // with a per-attach `when`; the predicate is evaluated per-participant.
  // =========================================================================

  it('D1: ch5 flow attach with `when: relations.calls.target_type=service` — TRUE on the participant that calls a service (refuses), FALSE on the one that does not (passes)', () => {
    const dir = hermeticFixture('ch5-when-relations');
    try {
      authorBannedAspect(dir, 'enforced');
      // orders calls a service; payments declares no relations.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - type: calls',
          '    target: services/payments',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      // Flow attaches no-banned-word gated on the participant calling a service.
      writeFileSync(
        flowYaml(dir),
        [
          'name: OrderProcessing',
          'description: End-to-end processing of a customer order.',
          'nodes:',
          '  - services/orders',
          '  - services/payments',
          'aspects:',
          '  - no-todo-comments',
          '  - id: no-banned-word',
          '    when:',
          '      relations:',
          '        calls:',
          '          target_type: service',
          '',
        ].join('\n'),
        'utf-8',
      );

      // orders (calls a service) → included via the flow; payments → excluded.
      const onOrders = run(['context', '--node', 'services/orders'], dir);
      expect(onOrders.status).toBe(0);
      expect(onOrders.stdout).toContain(EFFECTIVE('enforced'));
      expect(onOrders.stdout).toContain("Source: flow 'order-processing'");

      const onPayments = run(['context', '--node', 'services/payments'], dir);
      expect(onPayments.status).toBe(0);
      expect(onPayments.stdout).not.toContain('no-banned-word');

      // Enforcement follows applicability: the SAME BANNED token refuses on
      // orders, passes on payments. A clean repo-wide fill records both
      // baselines; planting BANNED in BOTH files then refuses ONLY orders (where
      // the flow aspect is effective) — payments, gated out, holds no
      // no-banned-word pair at all.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      plantBanned(paymentsFile(dir));

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.stdout).toContain('no-banned-word');
      // Fill-time progress goes to STDERR (its closing line counts the refusal); the report to STDOUT.
      expect(fill.stderr).toMatch(/^fill {2}done in .* — \d+ approved · 1 refused · 0 failed/m);
      // The refusal block (an error: enforced) names orders.
      expect(fill.stdout).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      // payments is gated out of the flow aspect — no no-banned-word pair is
      // dispatched or refused for it (the only no-banned-word refusal is orders').
      expect(fill.stdout).not.toContain('no-banned-word — 1 violation in services/payments');
      expect(fill.stdout).not.toContain('services/payments  src/services/payments.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Group E — CROSS-CHANNEL applicability. The SAME aspect arrives via two
  // channels; a `when` on ONE channel is false, but the OTHER channel (no
  // `when`) still delivers it. Channels are independent — an aspect is effective
  // if ANY channel's path passes both its global and attach-site filters.
  // =========================================================================

  it('E1: same aspect via ch2 (gated FALSE) AND ch4 (no `when`) — still effective via ch4; removing the ch4 default makes it disappear', () => {
    const dir = hermeticFixture('cross-channel-when');
    try {
      authorBannedAspect(dir, 'enforced');
      // ch4: module type default, NO when (always delivers to descendants).
      writeArchitecture(dir, ['aspects:', '  - no-banned-word']);
      // ch2: parent-node attach, gated FALSE on the service child (node.type=module).
      writeServicesNode(dir, [
        '  - id: no-banned-word',
        '    when:',
        '      node:',
        '        type: module',
      ]);

      // ch2 is filtered out, but ch4 still delivers → effective.
      const both = run(['context', '--node', 'services/orders'], dir);
      expect(both.status).toBe(0);
      expect(both.stdout).toContain(EFFECTIVE('enforced'));

      // It genuinely enforces (the surviving ch4 channel is enforced).
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The refusal block names the refused rule on the child node (an error:
      // enforced), with the child's violation as its member line.
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      expect(refused.all).toContain('  at:   services/orders  src/services/orders.ts');

      // Drop the ch4 default — now ONLY the gated-FALSE ch2 path remains, so the
      // aspect disappears from the effective set entirely. Proves ch4 was the
      // sole surviving delivery channel above.
      writeArchitecture(dir, []);
      const ch2Only = run(['context', '--node', 'services/orders'], dir);
      expect(ch2Only.status).toBe(0);
      expect(ch2Only.stdout).not.toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Group F — effective-status max() ACROSS channels where one contributor is a
  // DRAFT default. The aspect default is DRAFT; it cascades via ch2 (bare parent
  // attach, inheriting draft) AND via ch4 (ancestor type, explicitly enforced).
  // max(draft, enforced) = enforced — visible in context AND enforced at approve.
  // No EXPLICIT attach-site status is below the cascade, so this is a legitimate
  // max() (not an aspect-status-downgrade).
  // =========================================================================

  it('F1: max() across channels with a DRAFT default — ch2 bare attach (draft) + ch4 enforced type-default = enforced; context tags [enforced], a violation BLOCKS, no downgrade error', () => {
    const dir = hermeticFixture('max-draft-across-channels');
    try {
      // Aspect DEFAULT is draft.
      authorBannedAspect(dir, 'draft');
      // ch4: module type-default explicitly enforced.
      writeArchitecture(dir, ['aspects:', '  - id: no-banned-word', '    status: enforced']);
      // ch2: parent-node BARE attach — inherits the draft default (no explicit
      // status, so no downgrade attempt).
      writeServicesNode(dir, ['  - no-banned-word']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The draft contributor does not pin it to draft — the enforced channel wins.
      expect(ctx.stdout).toContain(EFFECTIVE('enforced'));

      // The cross-channel combination is legal — no downgrade error from the
      // draft-default contributor cascading under an enforced channel.
      const check = run(['check'], dir);
      expect(check.all).not.toContain('aspect-status-downgrade');

      // Enforced at fill: clean passes, BANNED refuses (exit 1).
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(ordersFile(dir));
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-banned-word');
      // Fill-time progress goes to STDERR (its closing line counts the refusal); the report to STDOUT.
      expect(refused.stderr).toMatch(/^fill {2}done in .* — \d+ approved · 1 refused · 0 failed/m);
      // The refusal block (an error: enforced) names the node.
      expect(refused.stdout).toContain('error[refused] no-banned-word — 1 violation in services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: the draft contributor is NOT a downgrade — but an EXPLICIT `status: draft` attach below an enforced cascade IS an aspect-status-downgrade error', () => {
    const dir = hermeticFixture('explicit-draft-downgrade');
    try {
      // Aspect default advisory; ch4 raises to enforced; ch2 EXPLICITLY writes
      // status: draft — an attempt to relax the enforced cascade. Unlike F1 (a
      // bare attach inheriting the draft DEFAULT), this explicit downgrade is an
      // error: an attach-site status cannot weaken a stricter cascade.
      authorBannedAspect(dir, 'advisory');
      writeArchitecture(dir, ['aspects:', '  - id: no-banned-word', '    status: enforced']);
      writeServicesNode(dir, ['  - id: no-banned-word', '    status: draft']);

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-status-downgrade');
      // The child is named in the downgrade group, the cascading ancestor source
      // is listed as a member, and the shared why explains the rule.
      expect(check.all).toContain('services/orders');
      expect(check.all).toContain('  at:   services  Aspect \'no-banned-word\'');
      expect(check.all).toContain(
        'An explicit attach-site status cannot relax (downgrade) what already cascades',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
