import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
// Config copied verbatim from the ports fixture for the hand-authored minimal
// graphs below — `yg check` requires a parseable yg-config.yaml to be present.
const FIXTURE_CONFIG = path.join(PORTS_FIXTURE, '.yggdrasil', 'yg-config.yaml');

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
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  // Some errors print to stdout, some to stderr — assert on the combined stream.
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project-ports fixture into a fresh temp dir for mutation. */
function copyPortsFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-pe-${label}-`));
  cpSync(PORTS_FIXTURE, dir, { recursive: true });
  return dir;
}

const writeFile = (dir: string, rel: string, content: string): void => {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
};

/**
 * A deterministic check.mjs that flags EVERY file in ctx — used to turn an
 * otherwise-passing port aspect into one that rejects the consumer's source.
 * Pure and synchronous: no network, no clock, no randomness — fully hermetic.
 */
const ALWAYS_FLAG_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    violations.push({
      file: file.path,
      line: 1,
      column: 0,
      message: 'audit trail missing on charge consumer',
    });
  }
  return violations;
}
`;

/**
 * Bootstrap a minimal hand-authored graph in a fresh temp dir: a parseable
 * config copied from the ports fixture, plus an empty src/. Callers add
 * yg-architecture.yaml, nodes, and source files.
 */
function scaffoldMinimalGraph(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-pe-${label}-`));
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  cpSync(FIXTURE_CONFIG, path.join(dir, '.yggdrasil', 'yg-config.yaml'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// PORT channel-6 ENFORCEMENT + relation types + bare-relation non-propagation.
//
// The committed ports fixture's port aspect always passes, so it has never been
// proven that a port aspect reaching a consumer via `consumes` actually BLOCKS
// approve. This suite closes that security-critical gap. Hermetic: the single
// port aspect (and every hand-authored aspect) is deterministic — no LLM, no
// network, no clock, no randomness. All mutations happen on fresh temp copies.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — port channel-6 enforcement / relation types / bare-relation non-propagation', () => {
  // --- Scenario 1: the channel-6 security guarantee ---
  // A port aspect declared on the provider, inherited by the consumer through
  // `consumes`, must REJECT approve when the consumer's source violates it.

  it('1a: yg context lists the port aspect as effective on the consumer with a provider-derived origin', () => {
    const dir = copyPortsFixture('ctx');
    try {
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // The channel-6 aspect is effective on the consumer...
      expect(all).toContain('audit-required');
      expect(all).toContain('Must satisfy');
      // ...and its origin is the provider-side port (channel-6 provenance).
      expect(all).toContain("port 'charge' on 'services/payments'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1b: a violating port aspect REFUSES the consumer during fill (exit 1, aspect refused on the consumer)', () => {
    const dir = copyPortsFixture('block');
    try {
      // Make the port aspect's check.mjs flag the consumer's own source file.
      // The aspect reaches services/orders ONLY through the charge port (channel
      // 6) — it is not on the consumer node, its type, or any ancestor.
      writeFile(dir, '.yggdrasil/aspects/audit-required/check.mjs', ALWAYS_FLAG_CHECK);

      // Fill is repo-wide; the deterministic charge-port pair on the consumer is
      // the only one and it refuses, so `yg check --approve` exits 1 and the
      // enforced refusal names the consumer node + the port aspect.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('audit-required');
      expect(fill.all).toContain('refused');
      expect(fill.all).toContain('services/orders');

      // The recorded refusal renders on every subsequent read as an enforced
      // error attributed to the consumer node and the port-sourced aspect.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // The grouped enforced refusal names the port-sourced aspect in its header
      // and lists the consumer node it refuses on.
      expect(check.all).toMatch(/enforced\s+1 pairs\s+1 nodes\s+aspect 'audit-required'/);
      expect(check.all).toContain('- services/orders');

      // The violation is reported against the consumer's OWN source file —
      // proving the port contract enforces across the node boundary. The
      // per-file Violation[] detail surfaces through the diagnostic runner
      // (`yg check` renders only the one-line headline; aspect-test renders the
      // recorded violation lines verbatim).
      const at = run(['aspect-test', '--aspect', 'audit-required', '--node', 'services/orders'], dir);
      expect(at.all).toContain('src/services/orders.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1c: control — with the trivial (passing) port aspect, the same consumer fills clean (exit 0)', () => {
    const dir = copyPortsFixture('control');
    try {
      // No mutation of check.mjs: the committed aspect returns []. This isolates
      // 1b's refusal to the port aspect's verdict, not some unrelated drift.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // The consumer's charge-port pair fills clean (approved, no refusal).
      expect(fill.all).not.toContain('refused');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 2: bare relation does NOT propagate the port aspect ---
  // A consumer reaching a target via a plain `uses` relation (no `consumes`)
  // does NOT inherit that target's port aspect. A bare relation to a PORTED
  // target is legal on its own now (it enters through the implicit `default`
  // port) — this scenario isolates propagation regardless, with a SECOND,
  // port-LESS provider and a second consumer that uses it bare. The same
  // always-flagging check.mjs that refuses the charge consumer must NOT be
  // effective on — and must NOT refuse — this second, bare-relation consumer.

  function setupBareRelationGraph(dir: string): void {
    // Broaden the architecture so a second provider/consumer pair classifies.
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping of service units. Parent-only — no file mapping.'
    log_required: false

  provider:
    description: 'A service that exposes ports consumed by other services.'
    log_required: false
    when:
      any_of:
        - path: "src/services/payments*"
        - path: "src/services/ledger*"
    parents: [module]

  consumer:
    description: 'A service that consumes another service via a port.'
    log_required: false
    when:
      any_of:
        - path: "src/services/orders*"
        - path: "src/services/billing*"
    parents: [module]
    relations:
      uses: [provider]
`,
    );
    // A port-LESS provider — a legitimate bare-dependency target.
    writeFile(dir, 'src/services/ledger.ts', 'export function record(amount) {\n  return amount >= 0;\n}\n');
    writeFile(
      dir,
      '.yggdrasil/model/services/ledger/yg-node.yaml',
      `name: LedgerService
description: Records ledger entries. No ports — a bare dependency target.
type: provider
mapping:
  - src/services/ledger.ts
`,
    );
    // A second consumer that uses the port-less provider via a BARE relation.
    writeFile(
      dir,
      'src/services/billing.ts',
      "import { record } from './ledger.js';\nexport function bill(amount) {\n  return record(amount);\n}\n",
    );
    writeFile(
      dir,
      '.yggdrasil/model/services/billing/yg-node.yaml',
      `name: BillingService
description: Bills the customer via the ledger. Bare relation — no port consumed.
type: consumer
relations:
  - target: services/ledger
    type: uses
mapping:
  - src/services/billing.ts
`,
    );
  }

  it('2a: the port aspect is NOT effective on a bare-relation consumer (yg context omits it)', () => {
    const dir = copyPortsFixture('bare-ctx');
    try {
      setupBareRelationGraph(dir);
      const { status, all } = run(['context', '--node', 'services/billing'], dir);
      expect(status).toBe(0);
      // The charge port's aspect did not cross the bare relation.
      expect(all).not.toContain('audit-required');
      // The bare relation to the port-less provider is still shown as a plain
      // dependency — confirming the relation exists but carries no aspect.
      expect(all).toContain('services/ledger (uses)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2b: the same violating check does NOT refuse the bare-relation consumer (no pair, no refusal attributed to it)', () => {
    const dir = copyPortsFixture('bare-approve');
    try {
      setupBareRelationGraph(dir);
      // Make the charge-port aspect a hard rejecter — it would refuse the charge
      // consumer (Scenario 1b). The bare-relation consumer must be untouched.
      writeFile(dir, '.yggdrasil/aspects/audit-required/check.mjs', ALWAYS_FLAG_CHECK);

      // Repo-wide fill: the only refusing pair is the charge consumer
      // (services/orders). The bare-relation consumer contributes NO pair —
      // the port aspect never crossed the bare relation, so no refusal is ever
      // attributed to it.
      const fill = run(['check', '--approve'], dir);
      // The charge consumer refuses (proven in 1b); the bare consumer does not.
      const billingRefusal = fill.all
        .split('\n')
        .filter((l) => l.includes('services/billing') && l.includes('refused'));
      expect(billingRefusal.length).toBe(0);

      // Confirmed structurally: the bare-relation consumer has no effective
      // port aspect at all, so the always-flagging check is never run on it.
      const ctx = run(['context', '--node', 'services/billing'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.all).not.toContain('audit-required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 3: relation types extends / implements ---
  // A minimal hand-authored graph whose architecture declares an allowed-list
  // for `extends` and `implements`. A valid relation passes `yg check`; pointing
  // it at a type the architecture forbids yields `relation-target-forbidden`.

  function scaffoldExtendsImplementsGraph(): string {
    const dir = scaffoldMinimalGraph('rel');
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  base:
    description: 'A base class type that can be extended.'
    when:
      path: "src/base*"
  iface:
    description: 'An interface type that can be implemented.'
    when:
      path: "src/iface*"
  other:
    description: 'An unrelated type — not a valid extends/implements target.'
    when:
      path: "src/other*"
  derived:
    description: 'A type that extends a base and implements an interface.'
    when:
      path: "src/derived*"
    relations:
      extends: [base]
      implements: [iface]
`,
    );
    for (const n of ['base', 'iface', 'other'] as const) {
      writeFile(dir, `src/${n}.ts`, `export const ${n} = '${n}';\n`);
      writeFile(
        dir,
        `.yggdrasil/model/${n}/yg-node.yaml`,
        `name: ${n}\ndescription: The ${n} node.\ntype: ${n}\nmapping:\n  - src/${n}.ts\n`,
      );
    }
    writeFile(dir, 'src/derived.ts', "export const derived = 'derived';\n");
    return dir;
  }

  it('3a: valid extends/implements relations pass yg check (exit 0)', () => {
    const dir = scaffoldExtendsImplementsGraph();
    try {
      writeFile(
        dir,
        '.yggdrasil/model/derived/yg-node.yaml',
        `name: Derived
description: Extends Base and implements Iface.
type: derived
relations:
  - target: base
    type: extends
  - target: iface
    type: implements
mapping:
  - src/derived.ts
`,
      );
      // Seed per-node relation verdicts first (empty registry → approved); a plain check would
      // otherwise be exit 1 on the unverified relation verdicts every mapped node now carries.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3b: extends pointing at a forbidden target type fails check with relation-target-forbidden (exit 1)', () => {
    const dir = scaffoldExtendsImplementsGraph();
    try {
      // `derived` allows extends: [base], implements: [iface]. Pointing `extends`
      // at type `other` (not in the allowed list) is forbidden. The target is a
      // distinct node — no self-cycle — so the only error is the relation one.
      writeFile(
        dir,
        '.yggdrasil/model/derived/yg-node.yaml',
        `name: Derived
description: Extends Base and implements Iface.
type: derived
relations:
  - target: other
    type: extends
  - target: iface
    type: implements
mapping:
  - src/derived.ts
`,
      );
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      // The shared WHY enumerates the allowed targets; the declaring node is listed.
      expect(all).toContain("Allowed targets for 'extends' from type 'derived': [base]");
      expect(all).toContain('- derived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3c: implements pointing at a forbidden target type fails check with relation-target-forbidden (exit 1)', () => {
    const dir = scaffoldExtendsImplementsGraph();
    try {
      // `implements` allows only [iface]; pointing it at `other` is forbidden.
      writeFile(
        dir,
        '.yggdrasil/model/derived/yg-node.yaml',
        `name: Derived
description: Extends Base and implements Iface.
type: derived
relations:
  - target: base
    type: extends
  - target: other
    type: implements
mapping:
  - src/derived.ts
`,
      );
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      // The shared WHY enumerates the allowed targets; the declaring node is listed.
      expect(all).toContain("Allowed targets for 'implements' from type 'derived': [iface]");
      expect(all).toContain('- derived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 4: `when` over a relation predicate (consumes_port) ---
  // An aspect attached to the consumer type, gated on
  // `relations.uses.consumes_port: charge`, is effective on the consumer that
  // consumes the charge port (TRUE) and excluded from the bare-relation consumer
  // (FALSE) — deterministically, through `yg context`.

  function setupWhenOverRelationGraph(dir: string): void {
    setupBareRelationGraph(dir);
    // Re-author the architecture, this time adding the when-gated aspect default
    // on the consumer type.
    writeFile(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:
  module:
    description: 'Organizational grouping of service units. Parent-only — no file mapping.'
    log_required: false

  provider:
    description: 'A service that exposes ports consumed by other services.'
    log_required: false
    when:
      any_of:
        - path: "src/services/payments*"
        - path: "src/services/ledger*"
    parents: [module]

  consumer:
    description: 'A service that consumes another service via a port.'
    log_required: false
    when:
      any_of:
        - path: "src/services/orders*"
        - path: "src/services/billing*"
    parents: [module]
    relations:
      uses: [provider]
    aspects:
      - id: charge-correlation
        when:
          relations:
            uses:
              consumes_port: charge
`,
    );
    writeFile(
      dir,
      '.yggdrasil/aspects/charge-correlation/yg-aspect.yaml',
      `name: ChargeCorrelation
description: Consumers of the charge port must attach a correlation id.
reviewer:
  type: deterministic
status: enforced
`,
    );
    writeFile(dir, '.yggdrasil/aspects/charge-correlation/check.mjs', 'export function check(ctx) {\n  void ctx;\n  return [];\n}\n');
  }

  it('4a: a when over consumes_port=charge INCLUDES the aspect on the charge consumer (yg context)', () => {
    const dir = copyPortsFixture('when-true');
    try {
      setupWhenOverRelationGraph(dir);
      const { status, all } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // services/orders consumes the charge port → when is TRUE → aspect effective.
      expect(all).toContain('charge-correlation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4b: the same when EXCLUDES the aspect on a bare-relation consumer that consumes no port (yg context)', () => {
    const dir = copyPortsFixture('when-false');
    try {
      setupWhenOverRelationGraph(dir);
      const { status, all } = run(['context', '--node', 'services/billing'], dir);
      expect(status).toBe(0);
      // services/billing consumes no port → when is FALSE → aspect excluded.
      expect(all).not.toContain('charge-correlation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
