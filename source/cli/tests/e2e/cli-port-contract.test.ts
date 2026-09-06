// =============================================================================
// CLI E2E — a port's contract: its version, its test, and the rule between them.
//
// A port is a contract. Naming the test that IS the contract makes it
// executable; recording what that test contained at a contract version is what
// makes it hold. These scenarios drive the whole rule through the public CLI
// against a real on-disk fixture — no reviewer, no key, nothing mocked.
//
//   1. unrecorded            → blocking, and the free run is the named fix
//   2. recorded by the FREE run → green, and the record lands in the committed lock
//   3. the test changes       → blocking, naming port, file, version, both exits
//   4. the version rises      → green again after the free run
//   5. back to the old version → still bound to the contract that version named
//   6. an unreadable test path → blocking, nothing baselined
//   7. a version that is not a whole number → the component refuses to load
//   8. a port declaring neither → nothing to hold, and nothing reported
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'port-contract');
const PLAIN_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
const distExists = existsSync(BIN_PATH);

const PROVIDER_YAML = path.join('.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const CONTRACT_TEST = path.join('tests', 'contracts', 'charge.test.ts');
const LOGS_LOCK = path.join('.yggdrasil', 'yg-lock.logs.json');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portcontract-${label}-`));
  cpSync(source, dir, { recursive: true });
  return dir;
}

/** Rewrite the provider's declared contract version in place. */
function setVersion(dir: string, from: number, to: number): void {
  const file = path.join(dir, PROVIDER_YAML);
  const before = readFileSync(file, 'utf-8');
  const after = before.replace(`version: ${from}`, `version: ${to}`);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

describe.skipIf(!distExists)('CLI E2E — port contract version and test', () => {
  it('1+2: an unrecorded contract blocks, and the free keyless run records it', () => {
    const dir = copyFixture(FIXTURE, 'record');
    try {
      const before = run(['check'], dir);
      expect(before.status).toBe(1);
      expect(before.all).toContain('port-contract-unrecorded');
      expect(before.all).toContain("No contract baseline is recorded for port 'charge' on services/payments (version 1).");
      expect(before.all).toContain('yg check --approve --only-deterministic');

      // The FREE run is what records it — no reviewer is configured that this
      // fixture could reach, and none is needed.
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.all).toContain('yg check: PASS');
      expect(fill.all).not.toContain('port-contract');

      // ...and the record is COMMITTED state, not the throwaway cache.
      const logs = JSON.parse(readFileSync(path.join(dir, LOGS_LOCK), 'utf-8')) as {
        nodes: Record<string, { ports?: Record<string, Record<string, { test: string; hash: string }>> }>;
      };
      const record = logs.nodes['services/payments'].ports!.charge['1'];
      expect(record.test).toBe('tests/contracts/charge.test.ts');
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3+4+5: the test cannot change at an unchanged version, a raised version records afresh, and the old version keeps its own contract', () => {
    const dir = copyFixture(FIXTURE, 'cycle');
    try {
      expect(run(['check', '--approve', '--only-deterministic'], dir).all).toContain('yg check: PASS');

      // (3) The contract test moves under an unchanged version.
      appendFileSync(path.join(dir, CONTRACT_TEST), '\n// a tightened promise\n');
      const changed = run(['check'], dir);
      expect(changed.status).toBe(1);
      expect(changed.all).toContain('port-contract-changed');
      expect(changed.all).toContain("The contract test behind port 'charge' on services/payments (version 1)");
      expect(changed.all).toContain('tests/contracts/charge.test.ts has changed since version 1 was recorded');
      // Both exits, named.
      expect(changed.all).toContain('raise ports.charge.version');
      expect(changed.all).toContain('to 2');
      expect(changed.all).toContain('yg log add --node services/payments');
      expect(changed.all).toContain('If it did not, restore tests/contracts/charge.test.ts.');
      // A recording run does NOT re-baseline it away.
      expect(run(['check', '--approve', '--only-deterministic'], dir).all).toContain('port-contract-changed');

      // (4) Saying the contract moved is what clears it.
      setVersion(dir, 1, 2);
      expect(run(['check', '--approve', '--only-deterministic'], dir).all).toContain('yg check: PASS');

      // (5) Going back to version 1 goes back to the contract version 1 named —
      // the old record was kept, not overwritten.
      setVersion(dir, 2, 1);
      const backAtOne = run(['check'], dir);
      expect(backAtOne.all).toContain('port-contract-changed');
      const restored = readFileSync(path.join(dir, CONTRACT_TEST), 'utf-8').replace('\n// a tightened promise\n', '');
      writeFileSync(path.join(dir, CONTRACT_TEST), restored);
      const green = run(['check', '--approve', '--only-deterministic'], dir);
      expect(green.all).not.toContain('port-contract');
      expect(green.all).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a contract test that cannot be read blocks, and baselines nothing', () => {
    const dir = copyFixture(FIXTURE, 'missing');
    try {
      rmSync(path.join(dir, CONTRACT_TEST));
      const result = run(['check', '--approve', '--only-deterministic'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('port-test-missing');
      expect(result.all).toContain('cannot be read: tests/contracts/charge.test.ts');
      expect(result.all).toContain(`ports.charge.test in .yggdrasil/model/services/payments/yg-node.yaml`);
      // Fail closed: an unreadable contract is never recorded as one.
      const logsPath = path.join(dir, LOGS_LOCK);
      if (existsSync(logsPath)) {
        expect(readFileSync(logsPath, 'utf-8')).not.toContain('"charge"');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a version that is not a whole number is refused, not ignored', () => {
    const dir = copyFixture(FIXTURE, 'badversion');
    try {
      const file = path.join(dir, PROVIDER_YAML);
      writeFileSync(file, readFileSync(file, 'utf-8').replace('version: 1', 'version: 1.5'));
      const result = run(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('yaml-invalid');
      expect(result.all).toContain('ports.charge.version must be an integer of 1 or more');
      expect(result.all).toContain('a contract version is a whole number that only ever rises');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a port declaring neither a version nor a test is untouched by any of this', () => {
    const dir = copyFixture(PLAIN_FIXTURE, 'plain');
    try {
      const result = run(['check', '--approve', '--only-deterministic'], dir);
      expect(result.all).not.toContain('port-contract');
      expect(result.all).not.toContain('port-test-missing');
      // The machine document reports what the port DECLARED — nothing.
      const doc = JSON.parse(run(['node', 'services/payments', '--json'], dir).stdout) as {
        ports: Record<string, { version: number | null; test: string | null }>;
      };
      expect(doc.ports.charge.version).toBeNull();
      expect(doc.ports.charge.test).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a declared version and test reach both machine documents as the port declared them', () => {
    const dir = copyFixture(FIXTURE, 'documents');
    try {
      const nodeDoc = JSON.parse(run(['node', 'services/payments', '--json'], dir).stdout) as {
        ports: Record<string, { version: number | null; test: string | null }>;
      };
      expect(nodeDoc.ports.charge.version).toBe(1);
      expect(nodeDoc.ports.charge.test).toBe('tests/contracts/charge.test.ts');

      const impactDoc = JSON.parse(run(['impact', '--node', 'services/payments', '--json'], dir).stdout) as {
        ports: Array<{ name: string; version: number | null; test: string | null }>;
      };
      const port = impactDoc.ports.find((p) => p.name === 'charge');
      expect(port).toEqual({
        name: 'charge',
        version: 1,
        test: 'tests/contracts/charge.test.ts',
        consumers: expect.any(Array),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
