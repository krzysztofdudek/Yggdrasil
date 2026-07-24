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
// Advanced flow-aspect mechanics (channel 5). The basic channel-5 propagation
// (flow aspect reaches participants + descendants, repo-wide fill, the
// `yg flows` listing) is already pinned by cli-flow-channel5.test.ts. This suite
// covers what those do NOT:
//
//   1. CONDITIONAL flow aspect — a flow-level aspect carrying a `when` predicate
//      applies to only the SUBSET of participants matching the predicate, and is
//      enforced exactly where it applies.
//   2. ADVISORY flow aspect — a flow-level advisory aspect violation warns
//      (yg check exit 0) and does NOT block, contrasted with an ENFORCED flow
//      aspect violation that blocks (exit 1).
//   3. DRAFT flow aspect — a flow-level draft aspect is skipped on every
//      participant: no verdict, no block, no fill pair.
//   4. FLOW-SET CASCADE — changing the flow's EFFECTIVE ASPECT SET (adding an
//      aspect to `aspects:`) or its PARTICIPANT SET (adding a node to `nodes:`)
//      makes the new effective pair UNVERIFIED (blocking error, exit 1) on the
//      affected participant(s), and a fill clears it.
//
// Verdict-lock model: `yg approve` is gone — verification happens via
// `yg check --approve` (repo-wide fill), state lives in
// `.yggdrasil/yg-lock.json`, and the states are verified/unverified/refused. A
// newly-effective pair with no recorded verdict renders as `unverified` (the
// old `aspect-newly-active` finding); a deterministic refusal renders as a
// cached `enforced`/`advisory` finding.
//
// HERMETIC: every test copies the committed e2e-lifecycle fixture into a fresh
// mkdtemp, mutates ONLY that copy, and rmSync's it in `finally`. The LLM aspect
// (`has-doc-comment`) is stripped so the reviewer endpoint is never contacted —
// only deterministic check.mjs aspects drive every outcome. No network, no
// clock, no randomness in any assertion.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-flowadv-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. No reviewer endpoint is ever
 * contacted, so the suite is hermetic and reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archP = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archP, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archP, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);

/**
 * Write a tiny deterministic aspect that flags any line containing `token`. The
 * token is chosen so the committed fixture sources NEVER contain it — a fresh
 * fill passes until the test deliberately introduces the token.
 */
function writeTokenAspect(
  dir: string,
  id: string,
  token: string,
  status: 'draft' | 'advisory' | 'enforced',
): void {
  const d = aspectDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, 'yg-aspect.yaml'),
    [
      `name: ${id.replace(/(^|-)([a-z])/g, (_m, _s, c) => c.toUpperCase())}`,
      `description: Source files must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      `status: ${status}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(d, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split(String.fromCharCode(10));',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      '        violations.push({',
      '          file: file.path,',
      '          line: i + 1,',
      '          column: 0,',
      `          message: ${JSON.stringify(`${token} token found.`)},`,
      '        });',
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

/** Overwrite the order-processing flow file with the given nodes + aspects YAML. */
function writeFlow(dir: string, nodesYaml: string[], aspectsYaml: string[]): void {
  writeFileSync(
    flowPath(dir),
    [
      'name: OrderProcessing',
      'description: End-to-end processing of a customer order, from creation through payment.',
      'nodes:',
      ...nodesYaml,
      'aspects:',
      ...aspectsYaml,
      '',
    ].join('\n'),
    'utf-8',
  );
}

/**
 * Strip `no-todo-comments` from the `service` architecture-type defaults so the
 * flow becomes the SOLE channel delivering it. `requires-named-export` stays as
 * the type default (every fixture source already satisfies it).
 */
function dropNoTodoFromServiceDefault(dir: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- no-todo-comments')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
}

/**
 * Build a fixture with TWO distinct node types so a flow aspect gated on
 * `node.type` discriminates participants. Keeps `services/orders` (type
 * `service`) and adds `gateways/api` (type `gateway`). `no-todo-comments` is
 * removed from BOTH type defaults so the flow is its only source; the flow
 * carries it gated `when: node.type=service`. Result: it reaches the `service`
 * participant and is filtered out on the `gateway` participant.
 */
function conditionalFlowFixture(label: string): string {
  const dir = deterministicFixture(label);

  writeFileSync(
    archPath(dir),
    [
      'node_types:',
      '  module:',
      "    description: 'Organizational grouping. Parent-only.'",
      '    log_required: false',
      '',
      '  service:',
      "    description: 'Discrete service unit under src/services/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '    parents: [module]',
      '    aspects:',
      '      - requires-named-export',
      '    relations:',
      '      uses: [service]',
      '      calls: [service]',
      '',
      '  gateway:',
      "    description: 'Edge gateway unit under src/gateways/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/gateways/**"',
      '    parents: [module]',
      '    aspects:',
      '      - requires-named-export',
      '    relations:',
      '      uses: [service]',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Organizational parent module for the gateway subtree.
  const gwParent = path.join(dir, '.yggdrasil', 'model', 'gateways');
  mkdirSync(gwParent, { recursive: true });
  writeFileSync(
    path.join(gwParent, 'yg-node.yaml'),
    [
      'name: Gateways',
      'description: Organizational parent grouping the application gateway units.',
      'type: module',
      '',
    ].join('\n'),
    'utf-8',
  );

  // The gateway node + its (clean) source file.
  const gwNode = path.join(gwParent, 'api');
  mkdirSync(gwNode, { recursive: true });
  writeFileSync(
    path.join(gwNode, 'yg-node.yaml'),
    [
      'name: ApiGateway',
      'description: Routes inbound API requests to services.',
      'type: gateway',
      'mapping:',
      '  - src/gateways/api.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  const gwSrc = path.join(dir, 'src', 'gateways');
  mkdirSync(gwSrc, { recursive: true });
  writeFileSync(
    path.join(gwSrc, 'api.ts'),
    [
      '// API gateway — routes inbound requests to services.',
      '',
      'export function route(requestPath) {',
      '  return requestPath;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Flow: a service participant + the gateway participant. The aspect is gated
  // TRUE only for services.
  writeFlow(
    dir,
    ['  - services/orders', '  - gateways/api'],
    [
      '  - id: no-todo-comments',
      '    when:',
      '      node:',
      '        type: service',
    ],
  );

  return dir;
}

const gatewayFile = (dir: string) => path.join(dir, 'src', 'gateways', 'api.ts');

// `<id> [enforced]` is the stable heading `yg context` prints for an effective
// aspect; it is wholly absent when `when` filters the aspect out.
const EFFECTIVE_TODO = 'no-todo-comments [enforced]';

describe.skipIf(!distExists)('CLI E2E — advanced flow-aspect mechanics (conditional / advisory / draft / flow-set cascade)', () => {
  // =========================================================================
  // 1. CONDITIONAL flow aspect — `when` filters per participant.
  // =========================================================================

  it('CF1: a flow aspect gated `when: node.type=service` is effective on the service participant and ABSENT on the gateway participant', () => {
    const dir = conditionalFlowFixture('cf1');
    try {
      // Service participant: predicate TRUE → aspect effective, attributed to the flow.
      const onService = run(['context', '--node', 'services/orders'], dir);
      expect(onService.status).toBe(0);
      expect(onService.stdout).toContain(EFFECTIVE_TODO);
      expect(onService.stdout).toContain("flow 'order-processing'");

      // Gateway participant: predicate FALSE → aspect silently filtered out.
      const onGateway = run(['context', '--node', 'gateways/api'], dir);
      expect(onGateway.status).toBe(0);
      expect(onGateway.stdout).not.toContain(EFFECTIVE_TODO);
      expect(onGateway.stdout).not.toContain('no-todo-comments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF2: with the SAME TODO on both, a fill REFUSES the matching (service) participant but the non-matching (gateway) participant is never judged', () => {
    const dir = conditionalFlowFixture('cf2');
    try {
      // Identical violation in both source files.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      appendFileSync(gatewayFile(dir), '\n// TODO: refactor this later\n');

      const fill = run(['check', '--approve'], dir);
      // Service participant: predicate TRUE → enforced flow aspect applies → refuse.
      expect(fill.status).toBe(1);
      // Fill-time progress ([det] lines) go to STDERR; grouped report to STDOUT.
      expect(fill.stderr).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(fill.stdout).toContain('enforced');
      expect(fill.stdout).toContain('services/orders');

      // Gateway participant: predicate FALSE → no-todo-comments never reaches it,
      // so there is NO such pair for the gateway — the identical TODO is not
      // judged. The gateway's own requires-named-export still approves.
      expect(fill.stderr).not.toContain('no-todo-comments on node:gateways/api');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 2. ADVISORY flow aspect — violation warns, does NOT block. Contrast with an
  //    ENFORCED flow aspect violation that blocks.
  // =========================================================================

  it('CF3: an ADVISORY flow-aspect violation does NOT block the fill — exit 0 with a recorded, non-blocking warning', () => {
    const dir = deterministicFixture('cf3');
    try {
      // `no-flowwip` advisory aspect carried by the flow (alongside the enforced
      // `no-todo-comments` already on the flow). Source has no FLOWWIP token yet.
      writeTokenAspect(dir, 'no-flowwip', 'FLOWWIP', 'advisory');
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments', '  - no-flowwip'],
      );

      // Violate ONLY the advisory flow aspect on payments (no TODO → enforced clean).
      appendFileSync(paymentsFile(dir), '\n// FLOWWIP marker\n');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory does NOT block the fill
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(fill.stderr).toContain('[det] no-flowwip on node:services/payments — refused');
      // Rendered as a non-blocking advisory warning. The grouped renderer drops
      // the per-issue "(advisory — not blocking)" suffix; non-blocking is now
      // proven by the WARNING section (not an error), the `advisory` group label,
      // and the PASS verdict with a warning count (exit 0 already asserted above).
      // A second warning group (`rules-digest-stale`) is always present too —
      // this fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/
      // .clinerules digest artifacts, and the committed-digest staleness gate
      // flags that on every `yg check --approve` here.
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain("aspect 'no-flowwip'");
      expect(fill.stdout).toMatch(/Warnings \(\d+\)( in \d+ groups)?:/);
      expect(fill.stdout).toContain('yg check: PASS (2 warnings)');
      expect(fill.stdout).toContain('rules-digest-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF4: yg check renders the advisory flow-aspect violation as a non-blocking WARNING — exit 0, advisory', () => {
    const dir = deterministicFixture('cf4');
    try {
      writeTokenAspect(dir, 'no-flowwip', 'FLOWWIP', 'advisory');
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments', '  - no-flowwip'],
      );

      appendFileSync(paymentsFile(dir), '\n// FLOWWIP marker\n');
      // Record every verdict (the advisory refusal among them) in the lock.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory warning does NOT fail check
      expect(check.stdout).toContain('PASS');
      expect(check.stdout).toContain('warning');
      // The warning names the participant, the advisory aspect, and is marked advisory.
      expect(check.stdout).toContain('advisory');
      expect(check.stdout).toContain('services/payments');
      expect(check.stdout).toContain('no-flowwip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF5: CONTRAST — an ENFORCED flow-aspect violation BLOCKS yg check (exit 1, rendered as enforced error)', () => {
    const dir = deterministicFixture('cf5');
    try {
      // Flow-only delivery of the enforced `no-todo-comments` (removed from type default).
      dropNoTodoFromServiceDefault(dir);
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      // Establish a clean baseline on both flow participants.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Violate the enforced flow aspect on payments. The refused enforced
      // verdict is recorded in the lock even though the fill exits 1.
      appendFileSync(paymentsFile(dir), '\n// TODO: fix\n');
      expect(run(['check', '--approve'], dir).status).toBe(1);

      const check = run(['check'], dir);
      expect(check.status).toBe(1); // enforced violation BLOCKS check
      expect(check.stdout).toContain('FAIL');
      // Rendered as an enforced error naming the participant and the flow aspect.
      expect(check.stdout).toContain('enforced');
      expect(check.stdout).toContain('services/payments');
      expect(check.stdout).toContain('no-todo-comments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 3. DRAFT flow aspect — skipped on every participant.
  // =========================================================================

  it('CF6: a DRAFT flow aspect is skipped at fill — its token violation is ignored and the fill exits 0', () => {
    const dir = deterministicFixture('cf6');
    try {
      // Make the flow's `no-todo-comments` the sole source AND draft. A draft
      // aspect is dormant: the reviewer never runs it and it gets no fill pair.
      dropNoTodoFromServiceDefault(dir);
      writeFileSync(
        path.join(aspectDir(dir, 'no-todo-comments'), 'yg-aspect.yaml'),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments — track work in the issue tracker, not the code.',
          'reviewer:',
          '  type: deterministic',
          'status: draft',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      // context shows the aspect as draft (dormant), not enforced.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-todo-comments [draft]');
      expect(ctx.stdout).not.toContain(EFFECTIVE_TODO);

      // A TODO on a participant must NOT be flagged — the draft aspect is skipped.
      appendFileSync(ordersFile(dir), '\n// TODO: fix\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // The draft aspect produces NO fill pair at all (it is never run).
      expect(fill.stdout).not.toContain('no-todo-comments on node:services/orders');
      expect(fill.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF7: a DRAFT flow aspect produces no unverified pair and no block — yg check stays green', () => {
    const dir = deterministicFixture('cf7');
    try {
      dropNoTodoFromServiceDefault(dir);
      writeFileSync(
        path.join(aspectDir(dir, 'no-todo-comments'), 'yg-aspect.yaml'),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments — track work in the issue tracker, not the code.',
          'reviewer:',
          '  type: deterministic',
          'status: draft',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      expect(run(['check', '--approve'], dir).status).toBe(0);

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      // Draft flow aspect never becomes active → no unverified finding for it.
      expect(check.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 4. FLOW-SET CASCADE — changing the flow's effective ASPECT SET or
  //    PARTICIPANT SET makes the new effective pair UNVERIFIED (NOT a silent
  //    no-op). The old `aspect-newly-active` finding is now `unverified`.
  // =========================================================================

  it('CF8: adding an aspect to a flow `aspects:` list makes it unverified on every participant (blocking error, exit 1)', () => {
    const dir = deterministicFixture('cf8');
    try {
      // Pre-create the new aspect definition so the ONLY mutation under test is
      // its addition to the flow's aspects: list (not a brand-new aspect file).
      // The fixture sources satisfy it (no FLOWGUARD token), so a re-fill is
      // clean — the block is purely the missing baseline verdict.
      writeTokenAspect(dir, 'no-flowguard', 'FLOWGUARD', 'enforced');

      // Clean baseline for both participants — WITHOUT the new aspect on the flow.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // THE MUTATION: add `no-flowguard` to the flow's aspects: list.
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments', '  - no-flowguard'],
      );

      // Contract: the new flow aspect is now an effective aspect on each
      // participant with no recorded verdict → unverified on each.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('unverified');
      expect(check.stdout).toContain('no-flowguard');
      // Both participants are named in the unverified findings.
      expect(check.stdout).toContain('services/orders');
      expect(check.stdout).toContain('services/payments');

      // Sanity: context confirms the new aspect reaches a participant via the flow.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.stdout).toContain('no-flowguard');
      expect(ctx.stdout).toContain("flow 'order-processing'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF9: a fill clears the flow-aspect-add cascade — yg check returns to green', () => {
    const dir = deterministicFixture('cf9');
    try {
      writeTokenAspect(dir, 'no-flowguard', 'FLOWGUARD', 'enforced');
      expect(run(['check', '--approve'], dir).status).toBe(0);

      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments', '  - no-flowguard'],
      );
      // The cascade is present before clearing.
      expect(run(['check'], dir).status).toBe(1);

      // A repo-wide fill records the missing verdict on each participant.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] lines) go to STDERR; final report to STDOUT.

      // Cascade cleared: check is green and the unverified finding is gone.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('PASS');
      expect(cleared.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF10: adding a participant to a flow `nodes:` list makes the flow aspect unverified on the new participant only (exit 1)', () => {
    const dir = deterministicFixture('cf10');
    try {
      // Flow-only delivery of `no-todo-comments` so flow membership is the sole
      // gate: a node NOT in the flow does not get it.
      dropNoTodoFromServiceDefault(dir);
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      // A third service node that is NOT a flow participant (so it lacks the flow aspect).
      const invNode = path.join(dir, '.yggdrasil', 'model', 'services', 'inventory');
      mkdirSync(invNode, { recursive: true });
      writeFileSync(
        path.join(invNode, 'yg-node.yaml'),
        [
          'name: InventoryService',
          'description: Tracks stock levels for catalog items.',
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
          '// Inventory service — tracks stock levels for catalog items.',
          '',
          'export function setStock(sku, quantity) {',
          '  return { sku, quantity };',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Clean baseline for all three. inventory has NO no-todo-comments yet.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const before = run(['context', '--node', 'services/inventory'], dir);
      expect(before.stdout).not.toContain('no-todo-comments');
      expect(run(['check'], dir).status).toBe(0);

      // THE MUTATION: add services/inventory as a flow participant.
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments', '  - services/inventory'],
        ['  - no-todo-comments'],
      );

      // Contract: the flow aspect now reaches inventory with no recorded verdict.
      const after = run(['context', '--node', 'services/inventory'], dir);
      expect(after.stdout).toContain('no-todo-comments');
      expect(after.stdout).toContain("flow 'order-processing'");

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('unverified');
      // The newly-added participant is the one that drifted (it gained the aspect).
      expect(check.stdout).toContain('services/inventory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CF11: a fill clears the participant-add cascade — yg check returns to green', () => {
    const dir = deterministicFixture('cf11');
    try {
      dropNoTodoFromServiceDefault(dir);
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      const invNode = path.join(dir, '.yggdrasil', 'model', 'services', 'inventory');
      mkdirSync(invNode, { recursive: true });
      writeFileSync(
        path.join(invNode, 'yg-node.yaml'),
        [
          'name: InventoryService',
          'description: Tracks stock levels for catalog items.',
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
          '// Inventory service — tracks stock levels for catalog items.',
          '',
          'export function setStock(sku, quantity) {',
          '  return { sku, quantity };',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Add inventory to the flow → cascade.
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments', '  - services/inventory'],
        ['  - no-todo-comments'],
      );
      expect(run(['check'], dir).status).toBe(1);

      // A repo-wide fill records the flow aspect's verdict on the new participant.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.

      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('PASS');
      expect(cleared.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
