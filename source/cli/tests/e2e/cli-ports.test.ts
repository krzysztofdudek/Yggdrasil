import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');

const distExists = existsSync(BIN_PATH);

// Node paths within the fixture graph (relative to model/).
const CONSUMER = 'services/orders'; // type: consumer — relation `uses` provider, consumes [charge]
const PROVIDER = 'services/payments'; // type: provider — declares ports: { charge: { aspects: [audit-required] } }

// File inside the fixture's .yggdrasil that each scenario mutates.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ports-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Fill the verdict lock so every expected (aspect, unit) pair holds a valid
 * verdict and `yg check` is clean.
 *
 * The consumer's only effective aspect is the channel-6 port aspect
 * `audit-required`, whose reviewer is `deterministic` (a trivial check.mjs that
 * returns []). `yg check --approve` therefore fills it locally — NO LLM call,
 * NO network — fully hermetic and reproducible on any machine. Fill is
 * repo-wide; the provider node has no effective aspects and contributes no pair.
 */
function fillLock(dir: string): void {
  const { status, all } = run(['check', '--approve'], dir);
  if (status !== 0) {
    throw new Error(`fixture precondition failed: check --approve exited ${status}\n${all}`);
  }
}

// ---------------------------------------------------------------------------
// consumes/port channel-6 contract + the two port error codes, through the
// real binary. Hermetic: no LLM, no network — the single port aspect is
// deterministic, and every error scenario is a pure validation (architecture
// gate) failure that never reaches the reviewer.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — ports / consumes channel-6 contract', () => {
  it('1: clean fixture passes yg check (exit 0) once the lock is filled', () => {
    const dir = copyFixture('clean');
    try {
      // The consumer carries the deterministic port aspect; filling the lock
      // records its verdict with zero LLM cost. Provider has no pairs to fill.
      fillLock(dir);
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: yg context on the consumer shows the port aspect as effective with a port/provider origin', () => {
    const dir = copyFixture('context');
    try {
      // `yg context` is read-only and never triggers drift, so no approve is
      // needed here. It must surface the channel-6 port aspect on the consumer.
      const { status, stdout } = run(['context', '--node', CONSUMER], dir);
      expect(status).toBe(0);
      // The port aspect is an effective aspect the consumer must satisfy...
      expect(stdout).toContain('audit-required');
      // ...and its origin is the provider-side port (channel 6 provenance).
      expect(stdout).toContain(`port 'charge' on '${PROVIDER}'`);
      // The relation also records the consumed port name.
      expect(stdout).toContain('consumes: charge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // RETIRED by D1c (6.0.0): removing the port declaration used to fail check
  // with port-missing-consumes. It no longer does — the relation normalizes
  // to the implicit 'default' port, and naming only 'default' is not an
  // error, so this now asserts the opposite of what it used to.
  it('3: removing consumes (provider keeps ports) no longer fails check — default is exempt (exit 0)', () => {
    const dir = copyFixture('missing-consumes');
    try {
      // Drop the `portNames: [charge]` line from the consumer's relation. The
      // provider still declares ports, but naming none now means 'default'.
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8');
      const stripped = yaml
        .split('\n')
        .filter((l) => !l.includes('portNames:'))
        .join('\n');
      expect(stripped).not.toEqual(yaml); // guard: the mutation actually changed something
      writeFileSync(consumerNodeYaml(dir), stripped, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('port-missing-consumes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: consuming a non-existent port fails check with port-undefined (exit 1)', () => {
    const dir = copyFixture('undefined-port');
    try {
      // Point the consumes at a port name the provider does not declare.
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8');
      const mutated = yaml.replace('portNames: [charge]', 'portNames: [nonexistent]');
      expect(mutated).not.toEqual(yaml);
      writeFileSync(consumerNodeYaml(dir), mutated, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-undefined');
      // The shared WHY echoes the provider's real (available) ports; the
      // consumer carrying the bad consumes is listed in the group node list.
      expect(stdout).toContain('Available ports: [charge]');
      expect(stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a port aspect referencing an undefined aspect id fails check with port-missing-aspect (exit 1)', () => {
    const dir = copyFixture('missing-aspect');
    try {
      // Repoint the provider's port aspect at an aspect id that does not exist
      // under aspects/. The consumer consumes this port, so the broken contract
      // surfaces on the consumer as port-missing-aspect.
      const yaml = readFileSync(providerNodeYaml(dir), 'utf-8');
      const mutated = yaml.replace('- audit-required', '- ghost-aspect');
      expect(mutated).not.toEqual(yaml);
      writeFileSync(providerNodeYaml(dir), mutated, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-missing-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: naming a real port on a relation whose target has NO ports fails check with port-undefined (exit 1)', () => {
    const dir = copyFixture('port-undefined-no-ports');
    try {
      // Strip the entire `ports:` block from the provider while the consumer
      // keeps `portNames: [charge]`. The target now declares no ports at all —
      // naming a real (non-default) port against it is still port-undefined,
      // the same code as naming one the target merely lacks. There is no
      // separate consumes-without-ports code any more.
      const yaml = readFileSync(providerNodeYaml(dir), 'utf-8');
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
      const mutated = out.join('\n');
      expect(mutated).not.toContain('ports:'); // guard: ports block is gone from the provider
      expect(mutated).toContain('type: provider'); // guard: rest of the provider node survived the strip
      writeFileSync(providerNodeYaml(dir), mutated, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('port-undefined');
      expect(stdout).toContain("port 'charge' not found");
      expect(stdout).toContain('Available ports: []');
      expect(stdout).not.toContain('consumes-without-ports');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
