import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');

const distExists = existsSync(BIN_PATH);

// File inside the fixture's .yggdrasil that a scenario mutates.
const consumerNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const providerNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');

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
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project-ports fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portsonesided-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Strip the entire top-level `ports:` block out of a yg-node.yaml's text. */
function stripPortsBlock(yaml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of yaml.split('\n')) {
    if (line.startsWith('ports:')) {
      skipping = true; // begin dropping the ports block
      continue;
    }
    if (skipping) {
      // The ports block is indented; it ends at the next top-level key.
      if (line.length > 0 && !line.startsWith(' ')) {
        skipping = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Drop the `portNames:` line from a relation, leaving the relation bare. */
function stripPortNames(yaml: string): string {
  return yaml
    .split('\n')
    .filter((l) => !l.includes('portNames:'))
    .join('\n');
}

// ---------------------------------------------------------------------------
// D1c (6.0.0) removed the one-sided port mandate: a component with ports no
// longer forces every caller to declare something. Naming a port the target
// does not publish is still refused (port-undefined — unconditionally,
// including when the target publishes no ports at all); not naming one is
// not. cli-ports.test.ts already covers the happy-path channel-6 propagation
// and the surviving two error codes end-to-end; this suite isolates the
// SHAPE OF THE MANDATE ITSELF — what is now legal that used to be refused,
// and what is still refused despite the loosening. Hermetic: no LLM, no
// network — every scenario is a pure validation (architecture gate) decision,
// and none needs `check --approve` first (either nothing is left to verify,
// or the scenario fails before the verification layer is ever reached).
//
// Scenarios:
//   1. a bare relation to a ported target -> passes, no mention of consumes
//   2. naming a real port on a target with NO ports at all -> port-undefined
//   3. naming only `default` on a target with NO ports at all -> passes
//   4. ports.default with an undefined aspect -> port-missing-aspect
//   5. a bare `emits` relation to a ported target -> passes (the old mandate
//      covered event relations too; the loosening must show there as well)
//   6. small-scale replay of the graph's own pre-D1c shape: one ported
//      target, three relations naming no port -> passes
//   7. `yg check --json` on scenario 2's graph -> exactly one port-undefined
//      issue, none of the two retired codes
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — the one-sided port mandate is gone', () => {
  it('1: a bare relation to a ported target passes, and the output never mentions consumes', () => {
    const dir = copyFixture('bare-to-ported');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8');
      const stripped = stripPortNames(yaml);
      expect(stripped).not.toEqual(yaml); // guard: the mutation actually changed something
      writeFileSync(consumerNodeYaml(dir), stripped, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('consumes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2: naming a real port on a target with NO ports at all fails check with port-undefined (exit 1)", () => {
    const dir = copyFixture('no-ports-named-real');
    try {
      const yaml = readFileSync(providerNodeYaml(dir), 'utf-8');
      const mutated = stripPortsBlock(yaml);
      expect(mutated).not.toContain('ports:'); // guard: ports block is gone from the provider
      expect(mutated).toContain('type: provider'); // guard: rest of the provider node survived the strip
      writeFileSync(providerNodeYaml(dir), mutated, 'utf-8');
      // The consumer keeps its committed `portNames: [charge]` unchanged.

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-undefined');
      expect(stdout).toContain("port 'charge' not found");
      expect(stdout).toContain('Available ports: []');
      // The target has nothing to have typo'd against — next talks about
      // adding a port, not fixing a name.
      expect(stdout).toContain('Add a port definition to the target node');
      expect(stdout).not.toContain('port-missing-consumes');
      expect(stdout).not.toContain('consumes-without-ports');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: naming only default on a target with NO ports at all passes (exit 0)', () => {
    const dir = copyFixture('no-ports-named-default');
    try {
      const providerYaml = stripPortsBlock(readFileSync(providerNodeYaml(dir), 'utf-8'));
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');
      const consumerYaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace('portNames: [charge]', 'portNames: [default]');
      writeFileSync(consumerNodeYaml(dir), consumerYaml, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: ports.default carrying an undefined aspect fails check with port-missing-aspect naming default (exit 1)', () => {
    const dir = copyFixture('default-missing-aspect');
    try {
      // Re-key the provider's port from `charge` to the reserved `default`
      // name, pointed at an aspect id that does not exist. The consumer's
      // relation is BARE — no portNames at all — proving default's aspects
      // reach even a consumer that never wrote anything about ports.
      writeFileSync(
        providerNodeYaml(dir),
        `name: PaymentsService
description: Captures payments and exposes the default port to consumers.
type: provider
ports:
  default:
    description: Capture a payment from the user.
    aspects:
      - ghost-aspect
mapping:
  - src/services/payments.ts
`,
        'utf-8',
      );
      writeFileSync(consumerNodeYaml(dir), stripPortNames(readFileSync(consumerNodeYaml(dir), 'utf-8')), 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-missing-aspect');
      expect(stdout).toContain("Port 'default'");
      expect(stdout).toContain('ghost-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a bare emits relation to a ported target passes — the old mandate covered event relations too, and its removal must show there', () => {
    const dir = copyFixture('bare-emits');
    try {
      // Replace the consumer's `uses`/`portNames:[charge]` relation with a
      // bare `emits`, paired with a bare `listens` back on the provider so
      // event-unpaired does not mask the result. Neither relation names a
      // port, and the provider's `charge` port goes unreferenced by anyone.
      writeFileSync(
        consumerNodeYaml(dir),
        `name: OrdersService
description: Creates orders and emits OrderPlaced to payments.
type: consumer
relations:
  - target: services/payments
    type: emits
    event_name: OrderPlaced
mapping:
  - src/services/orders.ts
`,
        'utf-8',
      );
      writeFileSync(
        providerNodeYaml(dir),
        `name: PaymentsService
description: Captures payments and exposes the charge port to consumers.
type: provider
ports:
  charge:
    description: Capture a payment from the user.
    aspects:
      - audit-required
relations:
  - target: services/orders
    type: listens
    event_name: OrderPlaced
mapping:
  - src/services/payments.ts
`,
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6: small-scale replay of the graph's own pre-D1c shape — one ported target, three relations naming no port, passes (exit 0)", () => {
    const dir = copyFixture('three-bare-consumers');
    try {
      // The committed consumer becomes bare (no portNames). Two more sibling
      // consumers are added, each with its own bare relation to the same
      // ported target — reproducing, at small scale, the shape that used to
      // turn this graph red on every one of its 1334 unnamed relations.
      writeFileSync(consumerNodeYaml(dir), stripPortNames(readFileSync(consumerNodeYaml(dir), 'utf-8')), 'utf-8');

      for (const n of ['orders-2', 'orders-3']) {
        writeFileSync(path.join(dir, 'src', 'services', `${n}.ts`), `export const ${n.replace('-', '_')} = true;\n`, 'utf-8');
        mkdirSync(path.join(dir, '.yggdrasil', 'model', 'services', n), { recursive: true });
        writeFileSync(
          path.join(dir, '.yggdrasil', 'model', 'services', n, 'yg-node.yaml'),
          `name: ${n}
description: Another consumer of the payments service, relating without naming a port.
type: consumer
relations:
  - target: services/payments
    type: uses
mapping:
  - src/services/${n}.ts
`,
          'utf-8',
        );
      }

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: yg check --json on the no-ports-named-real scenario reports exactly one port-undefined issue and none of the retired codes', () => {
    const dir = copyFixture('json-port-undefined');
    try {
      const providerYaml = stripPortsBlock(readFileSync(providerNodeYaml(dir), 'utf-8'));
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');

      const { status, stdout } = run(['check', '--json'], dir);
      expect(status).toBe(1);
      const doc = JSON.parse(stdout) as { issues: Array<{ code: string }> };
      const relevant = doc.issues.filter((i) =>
        ['port-undefined', 'port-missing-consumes', 'consumes-without-ports'].includes(i.code),
      );
      expect(relevant).toHaveLength(1);
      expect(relevant[0].code).toBe('port-undefined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
