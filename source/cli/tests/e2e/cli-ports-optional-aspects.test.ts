// =============================================================================
// CLI E2E — a port may declare no rules.
//
// Until now a port's `aspects:` key was load-bearing in a way nothing in its
// name suggested: an ABSENT key was not "no requirement", it was a crash that
// dropped the whole node — and with it, silently, its entire subtree — out of
// the graph. Every scenario below drives the real binary against a temp copy
// of sample-project-ports to prove the boundary that replaces it: an absent
// key and an explicit `aspects: []` are the exact same thing, while a PRESENT
// but malformed value is still a refusal naming the node, the port and the
// field.
//
//   1. absent aspects  → yg check passes; yg node prints "(none)"
//   2. yg context      → nothing to carry over on the consumer side
//   3. scalar aspects  → yg check fails, naming the node and the field
//   4. scalar + a third referencing node → the parse error reports ONCE
//   5. aspects: []     → byte-identical to the key being absent
//   6. unicode/space port names, no aspects → both survive --json and check
//   7. --json contract → aspects is [], never null, never missing
//   8. unreadable file → a named refusal, never an uncaught exception
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');

const distExists = existsSync(BIN_PATH);

// Node paths within the fixture graph (relative to model/).
const PROVIDER = 'services/payments'; // type: provider — declares ports: { charge: { aspects: [audit-required] } }
const CONSUMER = 'services/orders'; // type: consumer — relation `uses` provider, consumes [charge]

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
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project-ports fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portaspects-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Drop the `aspects:` key from the provider's `charge` port entirely. */
function withoutAspects(yaml: string): string {
  const mutated = yaml.replace('\n    aspects:\n      - audit-required', '');
  if (mutated === yaml) throw new Error('fixture shape changed — aspects block not found');
  return mutated;
}

/** Replace the provider's `charge` port aspects list with an explicit `[]`. */
function withEmptyAspectsArray(yaml: string): string {
  const mutated = yaml.replace('\n    aspects:\n      - audit-required', '\n    aspects: []');
  if (mutated === yaml) throw new Error('fixture shape changed — aspects block not found');
  return mutated;
}

/** Turn the provider's `charge` port aspects list into an invalid scalar. */
function withScalarAspects(yaml: string): string {
  const mutated = yaml.replace('aspects:\n      - audit-required', 'aspects: audit-required');
  if (mutated === yaml) throw new Error('fixture shape changed — aspects block not found');
  return mutated;
}

/** Add two more ports to the provider, named with unicode and a space, both without aspects. */
function withExtraPorts(yaml: string): string {
  const stripped = withoutAspects(yaml);
  const mutated = stripped.replace(
    '    description: Capture a payment from the user.\n',
    '    description: Capture a payment from the user.\n' +
      '  "płatność":\n' +
      '    description: "Zwrot środków w PLN"\n' +
      '  "bulk write":\n' +
      '    description: "Batch settlement write"\n',
  );
  if (mutated === stripped) throw new Error('fixture shape changed — description line not found');
  return mutated;
}

/** A third node, sibling to provider/consumer, whose relation targets the (possibly broken) provider. */
function addThirdReferencingNode(dir: string): void {
  const invoicingDir = path.join(dir, '.yggdrasil', 'model', 'services', 'invoicing');
  mkdirSync(invoicingDir, { recursive: true });
  writeFileSync(
    path.join(invoicingDir, 'yg-node.yaml'),
    'name: InvoicingService\ntype: consumer\nrelations:\n  - target: services/payments\n    type: uses\n',
    'utf-8',
  );
}

describe.skipIf(!distExists)('CLI E2E — a port without aspects', () => {
  it('1: a port without aspects loads — yg check passes and yg node prints consumers must satisfy: (none)', () => {
    const dir = copyFixture('absent');
    try {
      writeFileSync(providerNodeYaml(dir), withoutAspects(readFileSync(providerNodeYaml(dir), 'utf-8')), 'utf-8');

      const checked = run(['check'], dir);
      expect(checked.status).toBe(0);

      const node = run(['node', PROVIDER], dir);
      expect(node.status).toBe(0);
      expect(node.stdout).toContain('charge — Capture a payment from the user.');
      expect(node.stdout).toContain('consumers must satisfy: (none)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: yg context on the consumer carries over nothing — no port-derived aspect to show', () => {
    const dir = copyFixture('context');
    try {
      writeFileSync(providerNodeYaml(dir), withoutAspects(readFileSync(providerNodeYaml(dir), 'utf-8')), 'utf-8');

      const { status, stdout } = run(['context', '--node', CONSUMER], dir);
      expect(status).toBe(0);
      // No effective aspects at all on the consumer — the port that used to
      // source one now declares none.
      expect(stdout).not.toContain('audit-required');
      // The relation and its consumed port are still shown; only the
      // aspect requirement is gone.
      expect(stdout).toContain(`${PROVIDER} (uses)`);
      expect(stdout).toContain('consumes: charge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: a scalar ports.<name>.aspects fails check, naming the node and the field', () => {
    const dir = copyFixture('scalar');
    try {
      const yaml = readFileSync(providerNodeYaml(dir), 'utf-8');
      const mutated = withScalarAspects(yaml);
      expect(mutated).not.toEqual(yaml);
      writeFileSync(providerNodeYaml(dir), mutated, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain(PROVIDER);
      expect(stdout).toContain('ports.charge.aspects');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: the same scalar, plus a third node targeting the broken provider — the parse error is reported exactly once', () => {
    const dir = copyFixture('scalar-cascade');
    try {
      const yaml = readFileSync(providerNodeYaml(dir), 'utf-8');
      const mutated = withScalarAspects(yaml);
      expect(mutated).not.toEqual(yaml);
      writeFileSync(providerNodeYaml(dir), mutated, 'utf-8');
      addThirdReferencingNode(dir);

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // Exactly one parse-error entry for the provider — not duplicated per
      // referencing relation. Other errors from the now-missing target
      // (relation-broken on both orders and invoicing) are the KNOWN cascade
      // and are deliberately not asserted on here.
      const occurrences = stdout.split('yg-node.yaml parse error in services/payments.').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: an explicit empty aspects list is byte-identical to the key being absent', () => {
    const dirAbsent = copyFixture('empty-absent');
    const dirExplicit = copyFixture('empty-explicit');
    try {
      writeFileSync(providerNodeYaml(dirAbsent), withoutAspects(readFileSync(providerNodeYaml(dirAbsent), 'utf-8')), 'utf-8');
      writeFileSync(providerNodeYaml(dirExplicit), withEmptyAspectsArray(readFileSync(providerNodeYaml(dirExplicit), 'utf-8')), 'utf-8');

      const textAbsent = run(['node', PROVIDER], dirAbsent);
      const textExplicit = run(['node', PROVIDER], dirExplicit);
      expect(textAbsent.stdout).toBe(textExplicit.stdout);

      const jsonAbsent = run(['node', PROVIDER, '--json'], dirAbsent);
      const jsonExplicit = run(['node', PROVIDER, '--json'], dirExplicit);
      expect(jsonAbsent.stdout).toBe(jsonExplicit.stdout);
    } finally {
      rmSync(dirAbsent, { recursive: true, force: true });
      rmSync(dirExplicit, { recursive: true, force: true });
    }
  });

  it('6: a port named with unicode and one with a space, both without aspects, both survive --json and check', () => {
    const dir = copyFixture('unicode-names');
    try {
      writeFileSync(providerNodeYaml(dir), withExtraPorts(readFileSync(providerNodeYaml(dir), 'utf-8')), 'utf-8');

      const checked = run(['check'], dir);
      expect(checked.status).toBe(0);

      const { stdout } = run(['node', PROVIDER, '--json'], dir);
      const doc = JSON.parse(stdout) as { ports: Record<string, unknown> };
      expect(Object.keys(doc.ports).sort()).toEqual(['bulk write', 'charge', 'płatność'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: yg node --json on a port without aspects reports aspects: [] — never null, never missing', () => {
    const dir = copyFixture('json-contract');
    try {
      writeFileSync(providerNodeYaml(dir), withoutAspects(readFileSync(providerNodeYaml(dir), 'utf-8')), 'utf-8');

      const { status, stdout } = run(['node', PROVIDER, '--json'], dir);
      expect(status).toBe(0);
      const doc = JSON.parse(stdout) as { ports: Record<string, { aspects: unknown }> };
      expect(doc.ports.charge.aspects).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    '8: an unreadable yg-node.yaml is refused by name, never an uncaught exception',
    () => {
      const dir = copyFixture('unreadable');
      try {
        chmodSync(providerNodeYaml(dir), 0o000);

        const { status, stdout } = run(['check'], dir);
        // A controlled refusal through the same structured report every other
        // parse error uses — an uncaught exception would never reach this
        // renderer at all.
        expect(status).toBe(1);
        expect(stdout).toContain('yaml-invalid');
        expect(stdout).toContain(PROVIDER);
      } finally {
        chmodSync(providerNodeYaml(dir), 0o644);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
