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
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, detLockPath } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// Harness — REUSED verbatim from cli-deterministic-lifecycle.test.ts /
// cli-ports.test.ts / cli-ports-extended.test.ts: the spawnSync run(args, cwd)
// wrapper, BIN_PATH resolution, the distExists guard with describe.skipIf, and
// copyFixture(label) built on mkdtempSync + cpSync. Every scenario builds its
// own graph from a fresh temp copy of the committed sample-project-ports fixture
// and tears it down in a finally. Fully hermetic: ZERO committed fixtures
// mutated, no network, no clock, no randomness, no hardcoded ports. Every aspect
// used here is reviewer.type: deterministic with a pure synchronous check.mjs —
// `yg check --approve` makes NO LLM call and needs NO reviewer endpoint, so nothing
// depends on Ollama or any live service.
// ---------------------------------------------------------------------------

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  // Some errors print to stdout, some to stderr — assert on the combined stream.
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project-ports fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portinh-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Absolute path to a file inside the copied fixture. */
const at = (dir: string, rel: string) => path.join(dir, ...rel.split('/'));

/** Write a file inside the copied graph, creating parent dirs as needed. */
function writeFile(dir: string, rel: string, content: string): void {
  const abs = at(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// A pure, always-satisfied deterministic check — for port aspects that exist
// only to exercise channel-6 propagation, never to flag code.
const PASS_CHECK = `export function check(ctx) {\n  void ctx;\n  return [];\n}\n`;

// A pure deterministic check that flags any line containing a banned token.
// Used to PROVE a port-implied aspect is enforced (not decorative): a node
// whose source carries the token must be refused by approve.
function bannedTokenCheck(token: string): string {
  return `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(${JSON.stringify(token)})) {
        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${token} token found.`)} });
      }
    }
  }
  return violations;
}
`;
}

/** Write a deterministic aspect (yg-aspect.yaml + check.mjs) into the graph. */
function writeDetAspect(
  dir: string,
  id: string,
  status: 'draft' | 'advisory' | 'enforced',
  check: string,
  description = `Aspect ${id}.`,
  extraYaml = '',
): void {
  writeFile(
    dir,
    `.yggdrasil/aspects/${id}/yg-aspect.yaml`,
    `name: ${id}\ndescription: ${description}\nreviewer:\n  type: deterministic\nstatus: ${status}\n${extraYaml}`,
  );
  writeFile(dir, `.yggdrasil/aspects/${id}/check.mjs`, check);
}

const ordersSrc = (dir: string) => at(dir, 'src/services/orders.ts');

// ---------------------------------------------------------------------------
// PORTS — inheritance + transitive propagation edges NOT covered by cli-ports
// (basic propagation + four error codes), cli-ports-extended (multi-port /
// channel-6 status / when-on-port-attach-site / port cascade / description), or
// cli-ports-enforcement (channel-6 refusal / bare-relation non-propagation /
// relation-target-forbidden / when-over-consumes_port single clause). This
// suite pins:
//
//   A. CHILD CASCADE — a port aspect lands ONLY on the node declaring `consumes`;
//      it does NOT propagate down the hierarchy to that consumer's children
//      (channel 6 is not channel 2). The documented "children inherit parent
//      aspects" rule applies to a node's OWN/ancestor aspects, NOT to a sibling
//      channel-6 obligation. Pinned as ACTUAL behavior.
//   B. CHANNEL 6 -> CHANNEL 7 — a port-sourced aspect that `implies` another
//      aspect: the implied aspect becomes effective on the consumer, is
//      enforced, and is severed when the port consumption is removed.
//   C. TRANSITIVE / RELAY — A consumes B's port; C consumes A's relay port.
//      The obligation does NOT transit: C inherits only A's port aspect, never
//      B's (the obligation A consumed).
//   D. consumes_port `when` with any_of / all_of COMBINATORS over multiple ports
//      (cli-ports-enforcement scenario 4 covers only a single consumes_port).
//   E. SELF-TARGETING port consumer — a relation whose target is the node
//      itself, declaring `consumes` on the node's OWN port, is still a
//      structural-cycle (the port machinery does not exempt a self-cycle).
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — ports inheritance / transitive propagation / channel-6→7 / combinators', () => {
  // ── A. Child of a consumer does NOT inherit the port obligation ──

  // Architecture allows `consumer` to nest under `consumer`, and classifies a
  // second source file (detail*) as a consumer. The CHILD declares NO relation
  // of its own, so it has nothing on channel 6; the parent's channel-6 port
  // aspect is NOT in the parent's `aspects:` list, so channel 2 (ancestor) never
  // delivers it either. The port obligation therefore stays on the consumer
  // that declared `consumes` and never reaches its child.
  function setupChildGraph(dir: string): void {
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping of service units.'
    log_required: false
  provider:
    description: 'A service that exposes ports.'
    log_required: false
    when:
      path: "src/services/payments*"
    parents: [module]
  consumer:
    description: 'A consumer that consumes via a port and may nest children.'
    log_required: false
    when:
      any_of:
        - path: "src/services/orders*"
        - path: "src/services/detail*"
    parents: [module, consumer]
    relations:
      uses: [provider]
`,
    );
    writeFile(dir, 'src/services/detail.ts', 'export function detail(amount) {\n  return amount > 0;\n}\n');
    writeFile(
      dir,
      '.yggdrasil/model/services/orders/detail/yg-node.yaml',
      `name: OrdersDetail
description: A child of the orders consumer; owns a helper file but declares no relation of its own.
type: consumer
mapping:
  - src/services/detail.ts
`,
    );
  }

  it('A1: the port aspect is effective on the consumer that declares consumes, but NOT on its child', () => {
    const dir = copyFixture('a1-child');
    try {
      setupChildGraph(dir);

      // Parent consumer: the charge-port aspect is effective (channel 6).
      const parent = run(['context', '--node', 'services/orders'], dir);
      expect(parent.status).toBe(0);
      expect(parent.all).toContain('audit-required');
      expect(parent.all).toContain("port 'charge' on 'services/payments'");

      // Child consumer: it declares no relation, and the port aspect is NOT a
      // parent `aspects:` entry, so neither channel 6 nor channel 2 delivers it.
      const child = run(['context', '--node', 'services/orders/detail'], dir);
      expect(child.status).toBe(0);
      expect(child.all).not.toContain('audit-required');
      // The child therefore has no "Must satisfy" obligations at all.
      expect(child.all).not.toContain('Must satisfy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: the child (no effective aspect) contributes no ASPECT verdict pair — a repo-wide fill records no aspect verdict for it (only a relation verdict) and check passes', () => {
    const dir = copyFixture('a2-child-approve');
    try {
      setupChildGraph(dir);
      // The parent carries the enforced port aspect and contributes a pair; the
      // child has zero effective aspects and contributes none. One repo-wide
      // fill resolves the parent and never records a verdict for the child.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);

      // No ASPECT verdict pair is written for the aspect-less child (it has zero
      // effective aspects). Relations are computed live and never cached, so the
      // child has no aspect pair AND the lock carries no relation section at all.
      // The fill is deterministic-only, so the verdict file written is the
      // gitignored .yg-lock.deterministic.json; assert its raw content carries no
      // relation section.
      const raw = readFileSync(detLockPath(at(dir, '.yggdrasil')), 'utf-8');
      expect(raw).not.toContain('relation_verdicts'); // relations are live, not cached
      const lock = readLock(at(dir, '.yggdrasil'));
      const childAspectPairs = Object.values(lock.verdicts).filter((byUnit) =>
        Object.keys(byUnit).includes('node:services/orders/detail'),
      );
      expect(childAspectPairs).toEqual([]); // child contributes no ASPECT verdict pair

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── B. Channel 6 -> channel 7: a port aspect that IMPLIES another aspect ──

  // audit-required reaches the consumer via the charge port (channel 6) and
  // declares `implies: [diagnostic-logging]`. The implied aspect must become
  // effective on the consumer (its ONLY path in is the port-sourced implier),
  // be enforced, and be severed when the port consumption goes away.
  function setupPortImpliesGraph(dir: string): void {
    writeDetAspect(
      dir,
      'diagnostic-logging',
      'enforced',
      bannedTokenCheck('NOLOG'),
      'Source files must not contain the literal token NOLOG.',
    );
    // Re-author audit-required (the charge-port aspect) to imply diagnostic-logging.
    writeDetAspect(
      dir,
      'audit-required',
      'enforced',
      PASS_CHECK,
      'Consumers of the charge port must record an audit trail for every charge.',
      'implies:\n  - diagnostic-logging\n',
    );
  }

  it('B3: an aspect implied by a PORT aspect is effective on the consumer (channel 6 → channel 7)', () => {
    const dir = copyFixture('b3-port-implies');
    try {
      setupPortImpliesGraph(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // Both the port aspect and its implied aspect are effective.
      expect(all).toContain('Must satisfy (2 aspects)');
      // The port aspect arrives via channel 6 and advertises its implies edge.
      expect(all).toContain('audit-required');
      expect(all).toContain("port 'charge' on 'services/payments'");
      expect(all).toContain('Implies: diagnostic-logging');
      // The implied aspect arrives via channel 7, sourced to the port implier.
      expect(all).toContain('diagnostic-logging');
      expect(all).toContain("implied by 'audit-required'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: the port-implied aspect is ENFORCED — a violation of it refuses the fill while the implier stays satisfied', () => {
    const dir = copyFixture('b4-port-implies-enforce');
    try {
      setupPortImpliesGraph(dir);
      // Clean fill first.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // A NOLOG line violates ONLY the implied diagnostic-logging aspect.
      appendFileSync(ordersSrc(dir), '\n// NOLOG here\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Per-pair fill verdicts: the implier (channel 6) holds; the implied
      // aspect (channel 7) refuses — proving the implied aspect is enforced.
      expect(fill.stderr).toContain('[det] diagnostic-logging on node:services/orders — refused');
      // The grouped enforced refusal names the implied aspect in its header and
      // lists the consumer node it refuses on.
      expect(fill.stdout).toMatch(/enforced\s+1 pairs\s+1 nodes\s+aspect 'diagnostic-logging'/);
      expect(fill.stdout).toContain('- services/orders');

      // The recorded Violation[] detail (file + message) surfaces through the
      // diagnostic runner — yg check renders only the one-line headline.
      const at2 = run(['aspect-test', '--aspect', 'diagnostic-logging', '--node', 'services/orders'], dir);
      expect(at2.all).toContain('NOLOG token found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B5: removing the port consumption severs the whole chain — both the port aspect AND its implied aspect drop out', () => {
    const dir = copyFixture('b5-port-implies-sever');
    try {
      setupPortImpliesGraph(dir);
      // Wired: both aspects effective.
      const wired = run(['context', '--node', 'services/orders'], dir);
      expect(wired.all).toContain('audit-required');
      expect(wired.all).toContain('diagnostic-logging');

      // Sever the port: drop `consumes` on the consumer AND the port on the
      // provider (a bare relation to a port-LESS target keeps yg check valid).
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: No longer exposes a port.
type: provider
mapping:
  - src/services/payments.ts
`,
      );
      writeFile(
        dir,
        '.yggdrasil/model/services/orders/yg-node.yaml',
        `name: OrdersService
description: A bare relation that consumes no port.
type: consumer
relations:
  - target: services/payments
    type: uses
mapping:
  - src/services/orders.ts
`,
      );

      const severed = run(['context', '--node', 'services/orders'], dir);
      expect(severed.status).toBe(0);
      // The port aspect is gone, so its implied aspect has no path in either.
      expect(severed.all).not.toContain('audit-required');
      expect(severed.all).not.toContain('diagnostic-logging');
      expect(severed.all).not.toContain('implied by');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // B6: own-default status inheritance THROUGH a port-sourced implies edge.
  // The enforced charge-port aspect implies an advisory-default aspect with
  // status_inherit: own-default, so the implied aspect keeps its OWN advisory
  // default on the consumer instead of inheriting the implier's enforced status
  // (which the default 'strictest' mode would propagate). This is the one
  // channel-6→7 combination the other suites leave unpinned.
  function setupPortImpliesOwnDefaultGraph(dir: string): void {
    writeDetAspect(
      dir,
      'diag-advisory',
      'advisory',
      bannedTokenCheck('NOLOG'),
      'Source files should not contain the literal token NOLOG.',
    );
    writeDetAspect(
      dir,
      'audit-required',
      'enforced',
      PASS_CHECK,
      'Consumers of the charge port must record an audit trail for every charge.',
      'implies:\n  - id: diag-advisory\n    status_inherit: own-default\n',
    );
  }

  it('B6: a port aspect implying another with own-default status_inherit keeps the implied aspect at its OWN advisory default (violation warns, does not block)', () => {
    const dir = copyFixture('b6-port-implies-own-default');
    try {
      setupPortImpliesOwnDefaultGraph(dir);

      // Effective via channel 6 → channel 7, at its OWN advisory default — NOT
      // the implier's enforced status that 'strictest' would have propagated.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.all).toContain('diag-advisory [advisory]');

      // A NOLOG violation of the advisory implied aspect is a non-blocking
      // warning — the fill still exits 0. (Under 'strictest' it would inherit
      // enforced and BLOCK with exit 1.)
      appendFileSync(ordersSrc(dir), '\n// NOLOG here\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // The implied pair refuses but renders as a non-blocking advisory warning.
      // A second warning group (`rules-digest-stale`) is always present too —
      // this fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/
      // .clinerules digest artifacts, and the committed-digest staleness gate
      // flags that on every `yg check`/`yg check --approve` here.
      expect(fill.all).toContain('[det] diag-advisory on node:services/orders — refused');
      expect(fill.all).toContain('PASS (2 warnings)');
      expect(fill.all).toContain('advisory');
      expect(fill.all).toContain('diag-advisory');
      expect(fill.all).toContain('rules-digest-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── C. Transitive / relay: the obligation does NOT transit a consumer chain ──

  // Bottom provider exposes `charge` (aspect audit-required). The MIDDLE node
  // consumes charge AND exposes its own relay port (aspect relay-tracked). The
  // TOP node consumes the relay port. Channel 6 fires only on the node holding
  // the relation, so TOP inherits relay-tracked but NEVER audit-required — the
  // middle node's own port obligation does not flow onward to its consumers.
  function setupRelayChain(dir: string): void {
    writeDetAspect(dir, 'relay-tracked', 'enforced', PASS_CHECK, 'Consumers of the relay port must track relays.');
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping.'
    log_required: false
  provider:
    description: 'Bottom provider exposing the charge port.'
    log_required: false
    when:
      path: "src/services/payments*"
    parents: [module]
  middle:
    description: 'Consumes the charge port AND exposes a relay port.'
    log_required: false
    when:
      path: "src/services/orders*"
    parents: [module]
    relations:
      uses: [provider]
  top:
    description: 'Consumes the middle relay port.'
    log_required: false
    when:
      path: "src/services/top*"
    parents: [module]
    relations:
      uses: [middle]
`,
    );
    // Middle: consumes charge, exposes relay.
    writeFile(
      dir,
      '.yggdrasil/model/services/orders/yg-node.yaml',
      `name: OrdersService
description: Middle node consumes charge and exposes a relay port.
type: middle
ports:
  relay:
    description: Relay orders to upstream consumers.
    aspects:
      - relay-tracked
relations:
  - target: services/payments
    type: uses
    consumes: [charge]
mapping:
  - src/services/orders.ts
`,
    );
    // Top: consumes the middle relay port.
    writeFile(dir, 'src/services/top.ts', "import { placeOrder } from './orders.js';\nexport function topLevel(amount) {\n  return placeOrder(amount);\n}\n");
    writeFile(
      dir,
      '.yggdrasil/model/services/top/yg-node.yaml',
      `name: TopService
description: Top node consumes the middle relay port.
type: top
relations:
  - target: services/orders
    type: uses
    consumes: [relay]
mapping:
  - src/services/top.ts
`,
    );
  }

  it('C6: the middle node inherits ONLY the bottom port aspect it consumes (audit-required), not the relay aspect it exposes', () => {
    const dir = copyFixture('c6-relay-middle');
    try {
      setupRelayChain(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // Middle consumes the charge port → audit-required effective via channel 6.
      expect(all).toContain('audit-required');
      expect(all).toContain("port 'charge' on 'services/payments'");
      // A node does NOT inherit the aspects of a port it merely EXPOSES.
      expect(all).not.toContain('relay-tracked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7: the obligation does NOT transit — the top node inherits ONLY the relay aspect, never the bottom charge aspect', () => {
    const dir = copyFixture('c7-relay-top');
    try {
      setupRelayChain(dir);
      const { status, all } = run(['context', '--node', 'services/top'], dir);
      expect(status).toBe(0);
      // Top consumes the relay port → relay-tracked effective.
      expect(all).toContain('relay-tracked');
      expect(all).toContain("port 'relay' on 'services/orders'");
      // Channel 6 is non-transitive: audit-required (the obligation the MIDDLE
      // node consumed) does NOT flow onward to the top node.
      expect(all).not.toContain('audit-required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C8: the relay chain is self-consistent — every node fills clean and yg check passes', () => {
    const dir = copyFixture('c8-relay-approve');
    try {
      setupRelayChain(dir);
      // One repo-wide fill resolves both consumers: orders (charge port) and top
      // (relay port). Both port aspects fill clean.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── D. consumes_port `when` with any_of / all_of combinators ──

  // The provider exposes charge + refund. A consumer-type default aspect is
  // gated on a multi-port consumes_port predicate. cli-ports-enforcement
  // scenario 4 covers only a SINGLE consumes_port clause; this pins the boolean
  // COMBINATORS over two distinct ports.
  function setupCombinatorGraph(dir: string, combinator: 'any_of' | 'all_of'): void {
    writeDetAspect(dir, 'refund-logged', 'enforced', PASS_CHECK, 'Refund consumers must log refunds.');
    writeDetAspect(dir, 'multi-port-aspect', 'enforced', PASS_CHECK, 'Gated on a multi-port consumes predicate.');
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping.'
    log_required: false
  provider:
    description: 'Provider exposing charge and refund ports.'
    log_required: false
    when:
      path: "src/services/payments*"
    parents: [module]
  consumer:
    description: 'Consumer gated on a multi-port consumes predicate.'
    log_required: false
    when:
      path: "src/services/orders*"
    parents: [module]
    relations:
      uses: [provider]
    aspects:
      - id: multi-port-aspect
        when:
          ${combinator}:
            - relations: { uses: { consumes_port: charge } }
            - relations: { uses: { consumes_port: refund } }
`,
    );
    writeFile(
      dir,
      '.yggdrasil/model/services/payments/yg-node.yaml',
      `name: PaymentsService
description: Exposes charge and refund ports.
type: provider
ports:
  charge:
    description: Capture a payment.
    aspects:
      - audit-required
  refund:
    description: Refund a payment.
    aspects:
      - refund-logged
mapping:
  - src/services/payments.ts
`,
    );
  }

  /** Re-write the consumer's relation to consume the given port list. */
  function consumerConsumes(dir: string, ports: string[]): void {
    writeFile(
      dir,
      '.yggdrasil/model/services/orders/yg-node.yaml',
      `name: OrdersService
description: Consumes ${ports.join(' and ')}.
type: consumer
relations:
  - target: services/payments
    type: uses
    consumes: [${ports.join(', ')}]
mapping:
  - src/services/orders.ts
`,
    );
  }

  it('D9: an any_of over two consumes_port clauses INCLUDES the aspect when EITHER port is consumed', () => {
    const dir = copyFixture('d9-anyof');
    try {
      setupCombinatorGraph(dir, 'any_of');
      // Consume only refund → the refund clause of the any_of is TRUE.
      consumerConsumes(dir, ['refund']);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(all).toContain('multi-port-aspect');
      // The refund port aspect is also effective (this consumer consumes refund).
      expect(all).toContain('refund-logged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D10: an all_of over two consumes_port clauses EXCLUDES the aspect when only ONE port is consumed', () => {
    const dir = copyFixture('d10-allof-false');
    try {
      setupCombinatorGraph(dir, 'all_of');
      // Consume only charge → the all_of (needs BOTH charge AND refund) is FALSE.
      consumerConsumes(dir, ['charge']);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // The gated aspect is filtered out; only the charge port aspect remains.
      expect(all).not.toContain('multi-port-aspect');
      expect(all).toContain('audit-required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D11: the same all_of INCLUDES the aspect when BOTH ports are consumed', () => {
    const dir = copyFixture('d11-allof-true');
    try {
      setupCombinatorGraph(dir, 'all_of');
      // Consume BOTH charge and refund → the all_of is TRUE.
      consumerConsumes(dir, ['charge', 'refund']);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(all).toContain('multi-port-aspect');
      // Both port aspects are also effective alongside the gated default.
      expect(all).toContain('audit-required');
      expect(all).toContain('refund-logged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── E. Self-targeting relation that is a port consumer ──

  // A node declares a port AND a relation whose target is the node itself,
  // consuming that same port. cli-relations-extended S1 already pins a plain
  // structural self-relation; this pins that wrapping the self-relation in a
  // PORT CONTRACT (declared port + matching consumes) does NOT exempt it — the
  // cycle detector still rejects it as a structural-cycle, and context for the
  // node cannot even be assembled.
  function setupSelfConsumerGraph(dir: string): void {
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping.'
    log_required: false
  selfnode:
    description: 'A node that declares a port and consumes its own port.'
    log_required: false
    when:
      path: "src/services/payments*"
    parents: [module]
    relations:
      uses: [selfnode]
`,
    );
    // The fixture's orders consumer references payments; drop it so the only
    // node under test is the self-consumer (a clean, isolated graph).
    rmSync(at(dir, '.yggdrasil/model/services/orders'), { recursive: true, force: true });
    rmSync(at(dir, 'src/services/orders.ts'), { force: true });
    writeFile(
      dir,
      '.yggdrasil/model/services/payments/yg-node.yaml',
      `name: SelfNode
description: Declares a port and consumes that same port from itself.
type: selfnode
ports:
  loop:
    description: A port the node consumes from itself.
    aspects:
      - audit-required
relations:
  - target: services/payments
    type: uses
    consumes: [loop]
mapping:
  - src/services/payments.ts
`,
    );
  }

  it('E12: a self-targeting relation that consumes the node\'s OWN port is still a structural-cycle (exit 1)', () => {
    const dir = copyFixture('e12-self-check');
    try {
      setupSelfConsumerGraph(dir);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // The port contract does not exempt the self-loop from cycle detection.
      expect(all).toContain('structural-cycle');
      // The grouped block carries the shared cycle WHY and the break-the-cycle Fix.
      expect(all).toContain('Cycles prevent deterministic context assembly and cascade tracking.');
      expect(all).toContain('Break the cycle: extract a shared interface, invert a dependency, or merge nodes.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E13: context for the self-consumer is blocked by the cycle — the port aspect never resolves', () => {
    const dir = copyFixture('e13-self-ctx');
    try {
      setupSelfConsumerGraph(dir);
      const { status, all } = run(['context', '--node', 'services/payments'], dir);
      // build-context refuses to assemble while the structural cycle exists, so
      // the self-consumed port aspect is never surfaced as effective.
      expect(status).not.toBe(0);
      expect(all).toContain('structural-cycle');
      expect(all).toContain('services/payments -> services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
