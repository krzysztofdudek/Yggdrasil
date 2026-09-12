// =============================================================================
// CLI E2E — a port's version and contract test are gone, and NOT tolerated.
//
// 6.0.0 removes a port's `version` and `test` fields outright: the built-in
// check that held a contract test to a recorded baseline is gone (port
// contracts move to Horde), and the maintainer's ruling was explicit —
// "version i test nie są akceptowane." Neither field is quietly ignored.
// Presence of either, at any value, refuses the whole graph; a lock still
// carrying the retired `ports` section is refused the same way, with the
// migration as the only path past it. These scenarios drive the whole
// contract through the public CLI against real on-disk fixtures — no
// reviewer, no key, nothing mocked.
//
//   1. a port declaring `version:`         → the graph refuses to load
//   2. a port declaring `test:`             → the graph refuses to load
//   3. either field, at ANY value           → still refused (presence alone)
//   4. cleaned of both fields               → loads, and the machine
//                                              documents carry no such keys
//   5. `--approve --only-deterministic` on a clean graph never writes a
//      `ports` section into the lock
//   6. a lock with a hand-written `ports` section → plain `yg check` refuses
//      with `unexpected key "ports"`, lock untouched
//   7. the same lock, `yg check` again (no code change) → same refusal again,
//      still untouched — no self-healing outside migration
//   8. an old schema version, with a stale `ports` section in the lock →
//      `yg check` refuses on the schema; `yg init --upgrade` strips the lock
//      section and lands the config at 6.0.0; `yg check` is then green
//   9. a config version newer than the CLI supports → still refused as a
//      version from the future (regression: the 6.0.0 bump did not break the
//      other side of the comparison)
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'port-contract');
const distExists = existsSync(BIN_PATH);

const PROVIDER_YAML = path.join('.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const CONFIG_YAML = path.join('.yggdrasil', 'yg-config.yaml');
const LOGS_LOCK = path.join('.yggdrasil', 'yg-lock.logs.json');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portfields-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Strip the `version:` and `test:` lines from the provider's charge port, in place. */
function stripPortFields(dir: string): void {
  const file = path.join(dir, PROVIDER_YAML);
  const before = readFileSync(file, 'utf-8');
  const after = before
    .split('\n')
    .filter((line) => !/^\s*(version|test):/.test(line))
    .join('\n');
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

describe.skipIf(!distExists)('CLI E2E — a port version and contract test are refused, not ignored', () => {
  it('1: a port declaring version: refuses the graph, naming the node, the port and the field', () => {
    const dir = copyFixture('version');
    try {
      const result = run(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('services/payments');
      expect(result.all).toContain('ports.charge.version');
      expect(result.all).toContain('removed in 6.0.0');
      expect(result.all).toContain('delete this field');
      // The retired codes never come back.
      expect(result.all).not.toContain('port-contract-changed');
      expect(result.all).not.toContain('port-contract-unrecorded');
      expect(result.all).not.toContain('port-test-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a port declaring test: refuses the graph, naming the node, the port and the field', () => {
    const dir = copyFixture('test');
    try {
      // Remove just the version line, keep test: alone — proves the two
      // fields are rejected independently, not only in combination.
      const file = path.join(dir, PROVIDER_YAML);
      const before = readFileSync(file, 'utf-8');
      writeFileSync(file, before.split('\n').filter((l) => !/^\s*version:/.test(l)).join('\n'));

      const result = run(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('services/payments');
      expect(result.all).toContain('ports.charge.test');
      expect(result.all).toContain('removed in 6.0.0');
      expect(result.all).toContain('delete this field');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: rejection does not depend on the value — a malformed version and a path outside the repo are refused exactly the same way', () => {
    const malformed = copyFixture('malformed-version');
    const outside = copyFixture('outside-path');
    try {
      const file1 = path.join(malformed, PROVIDER_YAML);
      writeFileSync(file1, readFileSync(file1, 'utf-8').replace('version: 1', "version: 'abc'"));
      const r1 = run(['check'], malformed);
      expect(r1.status).toBe(1);
      expect(r1.all).toContain('ports.charge.version');
      expect(r1.all).not.toContain('must be an integer of 1 or more');

      // Remove version: first so the test: field's own rejection is isolated
      // (version fires first when both are present, which is scenario 1's job).
      const file2 = path.join(outside, PROVIDER_YAML);
      const withoutVersion = readFileSync(file2, 'utf-8').split('\n').filter((l) => !/^\s*version:/.test(l)).join('\n');
      writeFileSync(file2, withoutVersion.replace('test: tests/contracts/charge.test.ts', 'test: ../outside-repo.ts'));
      const r2 = run(['check'], outside);
      expect(r2.status).toBe(1);
      expect(r2.all).toContain('ports.charge.test');
      // The old path-containment validator is gone along with the field —
      // this refuses on REMOVAL, never reaching a path check at all.
      expect(r2.all).not.toContain('must not escape');
    } finally {
      rmSync(malformed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('4: cleaned of both fields, the graph loads and the machine documents carry no version or test key at all', () => {
    const dir = copyFixture('cleaned');
    try {
      stripPortFields(dir);
      // The graph loads clean of any port-field rejection — separate from
      // whether every pair has been approved yet, which this scenario is not
      // about (a fresh fixture starts with unverified pairs, exit 1, until
      // `--approve`; that is ordinary and unrelated to ports).
      const check = run(['check'], dir);
      expect(check.all).not.toContain('ports.charge');
      expect(check.all).not.toContain('removed in 6.0.0');

      const nodeDoc = JSON.parse(run(['node', 'services/payments', '--json'], dir).stdout) as {
        ports: Record<string, Record<string, unknown>>;
      };
      expect(nodeDoc.ports.charge).not.toHaveProperty('version');
      expect(nodeDoc.ports.charge).not.toHaveProperty('test');

      const impactDoc = JSON.parse(run(['impact', '--node', 'services/payments', '--json'], dir).stdout) as {
        ports: Array<Record<string, unknown>>;
      };
      const charge = impactDoc.ports.find((p) => p.name === 'charge')!;
      expect(charge).not.toHaveProperty('version');
      expect(charge).not.toHaveProperty('test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: --approve --only-deterministic on a clean graph never writes a ports section into the lock', () => {
    const dir = copyFixture('no-ports-written');
    try {
      stripPortFields(dir);
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.all).toContain('yg check: PASS');
      // Nothing in this run has a reason to touch the committed logs file at
      // all (there is no closure under --only-deterministic, and the old
      // port-baseline writer that used to touch it is gone) — absent is the
      // expected outcome here, not a bug in the assertion.
      const logsPath = path.join(dir, LOGS_LOCK);
      expect(!existsSync(logsPath) || !readFileSync(logsPath, 'utf-8').includes('"ports"')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a lock with a hand-written ports section refuses a plain `yg check`, naming the file, lock untouched', () => {
    const dir = copyFixture('lock-ports-plain');
    try {
      stripPortFields(dir);
      const logsPath = path.join(dir, LOGS_LOCK);
      const before = JSON.stringify({
        version: 1,
        verdicts: {},
        nodes: { 'services/payments': { ports: { charge: { '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) } } } } },
      });
      writeFileSync(logsPath, before);

      const result = run(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('unexpected key "ports"');
      expect(result.all).toContain('yg-lock.logs.json');
      expect(readFileSync(logsPath, 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: the same refusal repeats on a second plain `yg check` — no self-healing outside migration', () => {
    const dir = copyFixture('lock-ports-repeat');
    try {
      stripPortFields(dir);
      const logsPath = path.join(dir, LOGS_LOCK);
      const before = JSON.stringify({
        version: 1,
        verdicts: {},
        nodes: { 'services/payments': { ports: { charge: { '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) } } } } },
      });
      writeFileSync(logsPath, before);

      const first = run(['check'], dir);
      expect(first.status).toBe(1);
      expect(first.all).toContain('unexpected key "ports"');

      // No code changed between runs — the refusal is not a one-time transition.
      const second = run(['check'], dir);
      expect(second.status).toBe(1);
      expect(second.all).toContain('unexpected key "ports"');
      expect(readFileSync(logsPath, 'utf-8')).toBe(before);

      // --approve doesn't self-heal it either.
      const approved = run(['check', '--approve', '--only-deterministic'], dir);
      expect(approved.status).toBe(1);
      expect(approved.all).toContain('unexpected key "ports"');
      expect(readFileSync(logsPath, 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: an old schema with a stale ports section in the lock is refused, then migrated clean by `yg init --upgrade`', () => {
    const dir = copyFixture('migrate');
    try {
      stripPortFields(dir);
      const logsPath = path.join(dir, LOGS_LOCK);
      writeFileSync(
        logsPath,
        JSON.stringify({
          version: 1,
          verdicts: {},
          nodes: { 'services/payments': { ports: { charge: { '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) } } } } },
        }),
      );

      const configPath = path.join(dir, CONFIG_YAML);
      writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace(/^version:\s*"?6\.0\.0"?/m, 'version: "5.2.0"'));

      // The schema gate fires before the lock is ever read — a stale `ports`
      // section behind an outdated config is not even reached yet.
      const before = run(['check'], dir);
      expect(before.status).toBe(1);
      expect(before.all).toContain('older than this CLI');
      expect(before.all).toContain('yg init --upgrade');

      const upgrade = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(upgrade.status).toBe(0);
      expect(readFileSync(configPath, 'utf-8')).toContain('6.0.0');
      expect(readFileSync(logsPath, 'utf-8')).not.toContain('"ports"');

      // The upgrade also installs agent-rules plumbing (AGENTS.md, CLAUDE.md,
      // .clinerules/yggdrasil.md, .gitattributes) at the project root — unrelated
      // to ports, and exactly what the upgrade's own output tells an adopter to
      // exclude so `yg check` does not report them as unmapped.
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf-8').replace(
          'quality:',
          'coverage:\n  excluded:\n    - AGENTS.md\n    - CLAUDE.md\n    - .clinerules/yggdrasil.md\n    - .gitattributes\n\nquality:',
        ),
      );

      const after = run(['check', '--approve', '--only-deterministic'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a config version newer than the CLI supports is still refused as a version from the future', () => {
    const dir = copyFixture('future');
    try {
      stripPortFields(dir);
      const configPath = path.join(dir, CONFIG_YAML);
      writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace(/^version:\s*"?6\.0\.0"?/m, 'version: "7.0.0"'));

      const result = run(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('newer than this CLI supports');
      expect(result.all).toContain('max: 6.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An unreadable lock file (e.g. chmod 000) is deliberately not covered by a
  // scenario here: verified empirically against the built binary,
  // `readOneLockFile` in `io/lock-store.ts` only special-cases ENOENT — any
  // other read failure (EACCES included) is rethrown raw and lands in the
  // CLI's generic "Unexpected error ... this is a bug" wrapper, not a clean
  // refusal naming the file. That gap is general to any lock file this CLI
  // reads, unrelated to ports specifically, so it is tracked separately
  // rather than asserted here or patched as an unrelated drive-by fix.
});
