import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// Harness — REUSED verbatim from cli-deterministic-lifecycle.test.ts /
// cli-ports.test.ts: the spawnSync run(args, cwd) wrapper, BIN_PATH resolution,
// distExists guard with describe.skipIf, and a copyFixture(label) built on
// mkdtempSync + cpSync. Every scenario builds its own graph from a fresh temp
// copy of the committed sample-project-ports fixture and tears it down in a
// finally. Fully hermetic: ZERO new committed fixtures, no network, no clock,
// no randomness. Every aspect used here is reviewer.type: deterministic and
// ships a pure synchronous check.mjs — `yg check --approve` makes NO LLM call and needs
// NO reviewer endpoint, so nothing here depends on Ollama or any live service.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portx-${label}-`));
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

// A pure, synchronous deterministic check that is ALWAYS satisfied. Used for
// extra ports/aspects that exist only to exercise channel-6 propagation, never
// to flag code. No I/O, no clock, no randomness.
const PASS_CHECK = `export function check(ctx) {\n  void ctx;\n  return [];\n}\n`;

// A pure deterministic check that FLAGS every file in ctx — turns a port aspect
// into one that rejects the consumer's own source. Used to drive status-level
// outcomes (advisory warning vs enforced refusal) deterministically.
const ALWAYS_FLAG_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    violations.push({ file: file.path, line: 1, column: 0, message: 'audit trail missing' });
  }
  return violations;
}
`;

// Write a deterministic aspect (yg-aspect.yaml + check.mjs) into the graph.
function writeDetAspect(
  dir: string,
  id: string,
  status: 'draft' | 'advisory' | 'enforced',
  check: string,
  description = `Aspect ${id}.`,
): void {
  writeFile(
    dir,
    `.yggdrasil/aspects/${id}/yg-aspect.yaml`,
    `name: ${id}\ndescription: ${description}\nreviewer:\n  type: deterministic\nstatus: ${status}\n`,
  );
  writeFile(dir, `.yggdrasil/aspects/${id}/check.mjs`, check);
}

// ---------------------------------------------------------------------------
// PORTS — every remaining mechanic not covered by cli-ports (basic propagation
// + the four port error codes) or cli-ports-enforcement (channel-6 refusal,
// bare-relation non-propagation, relation-target-forbidden, when-over-relation):
//
//   - multiple ports on one provider; a consumer consuming a multi-port LIST
//   - one port carrying MULTIPLE aspects; selective consumption isolation
//   - channel-6 status: advisory port aspect -> warning; draft -> skipped;
//     port attach-site bump-up (advisory default -> enforced via port status)
//   - a `when` predicate ON the port-aspect attach site
//   - port-definition cascade: editing a port's aspect set / description drifts
//     consumers; re-approve clears it
//   - removing a still-consumed port -> port-undefined (the removal variant,
//     distinct from cli-ports test 4's bad consumes name)
//   - port description validation (blank / missing -> yaml-invalid parse error)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — ports extended: multi-port / channel-6 status / when / cascade / description', () => {
  // ── A. Multiple ports + multi-port consumes list ──

  // Provider declares two ports (charge, refund), each with its own
  // deterministic aspect. The consumer consumes BOTH in one relation
  // (consumes: [charge, refund]). Both port aspects must reach the consumer via
  // channel 6, each tagged with its own port origin.
  function setupTwoPortGraph(dir: string): void {
    writeDetAspect(dir, 'refund-logged', 'enforced', PASS_CHECK, 'Consumers of the refund port must log every refund.');
    writeFile(
      dir,
      '.yggdrasil/model/services/payments/yg-node.yaml',
      `name: PaymentsService
description: Captures payments and exposes the charge and refund ports.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - audit-required
  refund:
    description: Refund a previously captured payment.
    aspects:
      - refund-logged
mapping:
  - src/services/payments.ts
`,
    );
    writeFile(
      dir,
      '.yggdrasil/model/services/orders/yg-node.yaml',
      `name: OrdersService
description: Creates orders; charges and refunds via the payments ports.
type: consumer
relations:
  - target: services/payments
    type: uses
    consumes: [charge, refund]
mapping:
  - src/services/orders.ts
`,
    );
  }

  it('A1: consuming a multi-port LIST brings every consumed port\'s aspect to the consumer, each with its own port origin', () => {
    const dir = copyFixture('a1-multi-ctx');
    try {
      setupTwoPortGraph(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // Two distinct channel-6 aspects, one per consumed port.
      expect(all).toContain('Must satisfy (2 aspects)');
      expect(all).toContain('audit-required');
      expect(all).toContain('refund-logged');
      // Each names its own provider-side port origin (channel-6 provenance).
      expect(all).toContain("port 'charge' on 'services/payments'");
      expect(all).toContain("port 'refund' on 'services/payments'");
      // The relation echoes the full consumed-port list.
      expect(all).toContain('consumes: charge, refund');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a consumer of a multi-port list fills clean and yg check passes (both port aspects satisfied)', () => {
    const dir = copyFixture('a2-multi-approve');
    try {
      setupTwoPortGraph(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Both channel-6 port aspects fill clean on the consumer.
      // Fill-time progress ([det] lines) go to STDERR; final report to STDOUT.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── B. One port, multiple aspects + selective consumption ──

  // The charge port carries TWO aspects; the refund port carries one. The
  // consumer consumes ONLY charge. Both charge aspects must reach it; the
  // refund aspect must NOT (selective consumption isolates the unconsumed port).
  function setupOnePortTwoAspectsGraph(dir: string): void {
    writeDetAspect(dir, 'idempotency-key', 'enforced', PASS_CHECK, 'Charge consumers must send an idempotency key.');
    writeDetAspect(dir, 'refund-logged', 'enforced', PASS_CHECK, 'Refund consumers must log every refund.');
    writeFile(
      dir,
      '.yggdrasil/model/services/payments/yg-node.yaml',
      `name: PaymentsService
description: Captures payments and exposes the charge and refund ports.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - audit-required
      - idempotency-key
  refund:
    description: Refund a previously captured payment.
    aspects:
      - refund-logged
mapping:
  - src/services/payments.ts
`,
    );
    // Consumer consumes ONLY charge (the committed fixture already does this).
  }

  it('B3: one port carrying two aspects propagates BOTH to the consumer; the unconsumed port\'s aspect stays off', () => {
    const dir = copyFixture('b3-two-aspects');
    try {
      setupOnePortTwoAspectsGraph(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // Both charge-port aspects are effective...
      expect(all).toContain('Must satisfy (2 aspects)');
      expect(all).toContain('audit-required');
      expect(all).toContain('idempotency-key');
      // ...and the refund port (NOT consumed by this relation) contributes nothing.
      expect(all).not.toContain('refund-logged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: a provider may declare a port no consumer consumes — yg check passes (an unused port is not an error)', () => {
    const dir = copyFixture('b4-unused-port');
    try {
      setupOnePortTwoAspectsGraph(dir);
      // services/orders consumes only charge; the refund port is declared but
      // consumed by nobody. That is legal — only the inverse (consumes with no
      // matching port) is an error.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── C. Channel-6 aspect STATUS ──

  // C5–C6: an ADVISORY port aspect that the consumer violates. The aspect's OWN
  // default status is advisory (channel-6 effective status = max(aspect-default,
  // attach-site); setting it advisory only on the port attach site while the
  // aspect default is enforced is an aspect-status-downgrade error — proven
  // separately in cli-status-suppress). Advisory => approve exits 0 with an
  // informational line; yg check renders a non-blocking warning.

  it('C5: a violated ADVISORY port aspect does NOT block fill — it records an advisory refusal (exit 0)', () => {
    const dir = copyFixture('c5-advisory-approve');
    try {
      writeDetAspect(
        dir,
        'audit-required',
        'advisory',
        ALWAYS_FLAG_CHECK,
        'Consumers of the charge port must record an audit trail for every charge.',
      );
      const { status, stdout, stderr } = run(['check', '--approve'], dir);
      expect(status).toBe(0); // advisory refusal never blocks fill
      // The advisory pair fills with a refused verdict; the headline still PASSes
      // (with the refusal surfaced as a non-blocking warning).
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      // A second warning group (`rules-digest-stale`) is always present too —
      // this fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/
      // .clinerules digest artifacts, and the committed-digest staleness gate
      // flags that on every `yg check`/`yg check --approve` here.
      expect(stderr).toContain('[det] audit-required on node:services/orders — refused');
      expect(stdout).toContain('PASS (2 warnings)');
      expect(stdout).toContain('advisory');
      expect(stdout).toContain('audit-required');
      expect(stdout).toContain('rules-digest-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C6: the recorded advisory port-aspect violation renders as a non-blocking warning in yg check (exit 0)', () => {
    const dir = copyFixture('c6-advisory-check');
    try {
      writeDetAspect(
        dir,
        'audit-required',
        'advisory',
        ALWAYS_FLAG_CHECK,
        'Consumers of the charge port must record an audit trail for every charge.',
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0); // advisory warning does NOT fail check
      // Second warning group is `rules-digest-stale` — see the comment on C5.
      expect(stdout).toContain('PASS (2 warnings)');
      expect(stdout).toContain('advisory');
      expect(stdout).toContain('audit-required');
      expect(stdout).toContain('rules-digest-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7: a DRAFT port aspect is never evaluated — context marks it skipped and approve runs no reviewer', () => {
    const dir = copyFixture('c7-draft');
    try {
      // Draft default + an always-flagging check. The check must NEVER run, so
      // the violation it would raise is never surfaced.
      writeDetAspect(
        dir,
        'audit-required',
        'draft',
        ALWAYS_FLAG_CHECK,
        'Consumers of the charge port must record an audit trail for every charge.',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('audit-required [draft]');
      expect(ctx.stdout).toContain("port 'charge' on 'services/payments'");
      expect(ctx.stdout).toContain('(reviewer skipped; aspect is draft)');

      // The consumer's only effective aspect is draft, so it contributes NO
      // expected pair — fill has nothing to do and the always-flag check never
      // fires. (A draft aspect is excluded from the expected-pair set entirely.)
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress goes to STDERR; final report to STDOUT.
      expect(fill.stderr).toContain('Filling 0 unverified pairs across 0 nodes');
      expect(fill.stdout).not.toContain('refused');

      // yg check tallies the draft and passes — the draft port aspect is dormant.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      expect(check.stdout).toContain('draft');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C8: a port attach-site STATUS bumps an advisory-default aspect UP to enforced on the consumer (then a violation refuses approve)', () => {
    const dir = copyFixture('c8-bump');
    try {
      // Aspect default is advisory; the port declares status: enforced on the
      // attach site. Channel-6 effective status = max(advisory, enforced) =
      // enforced. A bump UP is allowed (only downgrades are validator errors).
      writeDetAspect(
        dir,
        'audit-required',
        'advisory',
        ALWAYS_FLAG_CHECK,
        'Consumers of the charge port must record an audit trail for every charge.',
      );
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - id: audit-required
        status: enforced
mapping:
  - src/services/payments.ts
`,
      );

      // The bump makes the effective status enforced on the consumer.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('audit-required [enforced]');
      expect(ctx.stdout).toContain("port 'charge' on 'services/payments'");

      // Enforced + violating => the fill REFUSES and BLOCKS (unlike advisory C5):
      // exit 1, the pair fills refused, and the enforced refusal renders.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR; grouped report to STDOUT.
      expect(fill.stderr).toContain('[det] audit-required on node:services/orders — refused');
      // The grouped enforced refusal names the aspect in its header and lists
      // the consumer node it refuses on.
      expect(fill.stdout).toMatch(/enforced\s+1 pairs\s+1 nodes\s+aspect 'audit-required'/);
      expect(fill.stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── D. `when` ON the port-aspect attach site ──

  // The port aspect carries `when: { node: { type: consumer } }`. The predicate
  // is evaluated against the CONSUMER node receiving the aspect. Two consumer
  // node types both consume the charge port: the aspect reaches the matching
  // type (when TRUE) and is excluded from the non-matching type (when FALSE).
  // (cli-ports-enforcement scenario 4 gates a CONSUMER-TYPE-default aspect on a
  // relation predicate; cli-conditional-when W3/W8 gate a NODE-OWN aspect on
  // node.has_port. A `when` placed directly on a PORT aspect entry is neither.)
  function setupWhenOnPortGraph(dir: string): void {
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
    description: 'A consumer that consumes via a port.'
    log_required: false
    when:
      path: "src/services/orders*"
    parents: [module]
    relations:
      uses: [provider]

  audited-consumer:
    description: 'A second consumer kind that also consumes via a port.'
    log_required: false
    when:
      path: "src/services/audited*"
    parents: [module]
    relations:
      uses: [provider]
`,
    );
    // Port aspect gated on the consuming node's type.
    writeFile(
      dir,
      '.yggdrasil/model/services/payments/yg-node.yaml',
      `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - id: audit-required
        when:
          node:
            type: consumer
mapping:
  - src/services/payments.ts
`,
    );
    // Second consumer (audited-consumer type) that ALSO consumes charge.
    writeFile(
      dir,
      'src/services/audited.ts',
      "import { charge } from './payments.js';\nexport function auditedCharge(amount) {\n  return charge(amount);\n}\n",
    );
    writeFile(
      dir,
      '.yggdrasil/model/services/audited/yg-node.yaml',
      `name: AuditedService
description: A second consumer kind that also consumes the charge port.
type: audited-consumer
relations:
  - target: services/payments
    type: uses
    consumes: [charge]
mapping:
  - src/services/audited.ts
`,
    );
  }

  it('D9: a when on the port-aspect entry INCLUDES the aspect on the matching consumer type (node.type=consumer TRUE)', () => {
    const dir = copyFixture('d9-when-true');
    try {
      setupWhenOnPortGraph(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // services/orders is type `consumer` → when TRUE → port aspect effective.
      expect(all).toContain('audit-required');
      expect(all).toContain("port 'charge' on 'services/payments'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D10: the same when EXCLUDES the aspect on a different consumer type that consumes the same port (node.type FALSE)', () => {
    const dir = copyFixture('d10-when-false');
    try {
      setupWhenOnPortGraph(dir);
      const { status, all } = run(['context', '--node', 'services/audited'], dir);
      expect(status).toBe(0);
      // services/audited is type `audited-consumer` → when FALSE → aspect filtered
      // out even though it consumes the same charge port.
      expect(all).not.toContain('audit-required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D11: with the when-filtered port aspect, the excluded consumer needs no approval and yg check passes', () => {
    const dir = copyFixture('d11-when-check');
    try {
      setupWhenOnPortGraph(dir);
      // services/orders carries the aspect (when TRUE) and contributes a pair;
      // services/audited has no effective non-draft aspect (when FALSE) so it
      // contributes none. A single repo-wide fill resolves everything and check
      // is clean.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── E. Port-definition CASCADE ──

  it('E12: adding an aspect to a port\'s set leaves the consumer unverified for the new aspect; a fill clears it', () => {
    const dir = copyFixture('e12-cascade-aspect-set');
    try {
      writeDetAspect(dir, 'refund-logged', 'enforced', PASS_CHECK, 'Consumers must log refunds.');

      // Fill against the original single-aspect charge port; check is clean.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Edit the port's ASPECT SET on the provider — add a second required aspect
      // to the charge port the consumer already consumes.
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - audit-required
      - refund-logged
mapping:
  - src/services/payments.ts
`,
      );

      // The new port aspect is now effective on the consumer via channel 6, but
      // no verdict exists for that (aspect, node) pair yet — the expected-pair
      // set grew, so the consumer reports `unverified` for refund-logged.
      // (The verdict-lock model replaces the old `cascade`/`aspect-newly-active`
      // drift vocabulary: a newly-active aspect surfaces as `unverified` for the
      // pair that has no recorded verdict. audit-required's own verdict stays
      // valid — its inputs did not change.)
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('unverified');
      expect(drifted.stdout).toContain('services/orders');
      expect(drifted.stdout).toContain('refund-logged');

      // Re-filling verifies the newly-active port aspect and clears it.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.

      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E13: a port DESCRIPTION-only edit does NOT invalidate the consumer\'s verdict (input-precise hashing — only the aspect SET matters)', () => {
    // CONVERTED behavior (verdict-lock model). The old assertion was that a
    // port description-only edit cascades drift onto the consumer "because the
    // port definition is hashed whole". That whole-yaml tracking is GONE: the
    // frozen pair-hash contract excludes node/port descriptions ("prompt
    // garnish, not a judgment input") and recomputes port applicability live
    // through the expected-pair set rather than by hashing the provider yaml.
    // A description reword therefore changes neither the consumer's verdict
    // hash nor its expected-pair set — the verdict stays valid. This pins the
    // surviving, now-correct behavior (the complementary E12 still proves that
    // an aspect-SET change DOES re-verify). It is the direct counterpart to the
    // removed cascade-by-description surface, not a weakened version of it.
    const dir = copyFixture('e13-cascade-desc');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Reword ONLY the charge port's description — aspect set unchanged.
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: Capture a payment from the user — reworded contract text.
    aspects:
      - audit-required
mapping:
  - src/services/payments.ts
`,
      );

      // The consumer's audit-required verdict is unaffected — its inputs (the
      // consumer's source + the aspect's check.mjs + the consumed aspect SET)
      // are identical. No fill is needed; check stays clean.
      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.stdout).toContain('PASS');
      expect(after.stdout).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── F. Removing a still-consumed port -> port-undefined ──

  it('F14: removing a port that is still consumed surfaces port-undefined on the consumer, listing the remaining ports', () => {
    const dir = copyFixture('f14-remove-port');
    try {
      // Provider keeps a DIFFERENT port (refund) but drops the consumed `charge`.
      // Because the provider STILL declares ports, this is port-undefined (not
      // consumes-without-ports, which fires only when the provider has NO ports).
      // The committed consumer still declares consumes: [charge].
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes a refund port.
type: provider
ports:
  refund:
    description: Refund a previously captured payment.
    aspects:
      - audit-required
mapping:
  - src/services/payments.ts
`,
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-undefined');
      // The shared WHY echoes the surviving available port; the consumer is listed.
      expect(stdout).toContain('Available ports: [refund]');
      expect(stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G. Port description validation (schema requires a non-empty string) ──

  it('G15: a blank port description is a parse error (yaml-invalid) — the schema requires a non-empty string', () => {
    const dir = copyFixture('g15-blank-desc');
    try {
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: ""
    aspects:
      - audit-required
mapping:
  - src/services/payments.ts
`,
      );

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('yaml-invalid');
      expect(all).toContain('ports.charge.description must be a non-empty string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G16: an omitted port description is the same parse error (yaml-invalid) — description is required, not optional', () => {
    const dir = copyFixture('g16-missing-desc');
    try {
      writeFile(
        dir,
        '.yggdrasil/model/services/payments/yg-node.yaml',
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    aspects:
      - audit-required
mapping:
  - src/services/payments.ts
`,
      );

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('yaml-invalid');
      expect(all).toContain('ports.charge.description must be a non-empty string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
