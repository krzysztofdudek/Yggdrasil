// ============================================================================
// CLI E2E — the default port (D1c: every relation enters through a named
// port; `default` exists implicitly on every node, declared or not).
//
// Numbered scenarios (task 002):
//   1.  a relation with no portNames, to a node declaring port `charge`
//       -> yg check exit 0 (the former port-missing-consumes no longer exists)
//   2.  a relation `portNames: [default]`, to a node with NO port at all
//       -> exit 0, no port-undefined
//   3.  a node declares `ports.default` with an aspect; an undeclared relation
//       -> the aspect is effective on the consumer, `yg context` prints it,
//          `yg check --approve --only-deterministic` fills it, `yg check` is 0
//   4.  a node declares `ports.default` AND `ports.charge`; a relation naming
//       both -> the consumer gets BOTH aspect sets, `yg context` lists both
//   5.  the same pair, a relation naming only `[charge]` -> the consumer gets
//       ONLY the charge aspect; the default aspect is not effective
//   6.  `portNames: []` -> exit 1, output contains `port-names-empty` and the
//       source node's path
//   7.  `consumes: [charge]` (the alias) -> identical `yg node --json` output
//       to `portNames: [charge]`, compared byte for byte
//   8.  `consumes` and `portNames` together -> exit 1, output names both keys
//   9.  a literally-named `default` port declared WITH a description -> exit
//       0, but a one-time reserved-name notice appears; a second `yg check`
//       prints it again (the notice is stateless by design)
//   10. `yg node --json` and `yg impact --node --json` on a graph with an
//       undeclared relation -> schema is still yg-node/1 / yg-impact/1, and
//       the `consumes` / `ports` lists name `default`
//   11. `ports.default` with no description -> exit 0; `ports.charge` with no
//       description -> exit 1, mentioning `ports.charge.description`
//   12. a port name with a space and one with unicode, in both `portNames`
//       and `ports` -> exit 0, `yg node` prints both
//   13. regression: a node path with `..` in `mapping` is still rejected —
//       relation normalization must not weaken path validation
//
// Zero LLM, zero network: the fixture's only aspect (audit-required) is
// `reviewer: { type: deterministic }`, and every new aspect this file writes
// at runtime is the same trivial always-pass shape.
// ============================================================================

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

const CONSUMER = 'services/orders';
const PROVIDER = 'services/payments';

const consumerNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const providerNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project-ports fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portdefault-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Write a second trivial deterministic aspect (always passes, never reads content). */
function writeTrivialAspect(dir: string, id: string, description: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: ${description}\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    `export function check(ctx) {\n  void ctx;\n  return [];\n}\n`,
    'utf-8',
  );
}

describe.skipIf(!distExists)('CLI E2E — the default port', () => {
  it('1: a relation without portNames to a node declaring port charge -> yg check exit 0', () => {
    const dir = copyFixture('bare-to-ported');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(/\n\s*portNames: \[charge\]/, '');
      expect(yaml).not.toContain('portNames:'); // guard: the mutation actually removed it
      writeFileSync(consumerNodeYaml(dir), yaml, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('port-missing-consumes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: portNames: [default] to a node with NO port at all -> exit 0, no port-undefined', () => {
    const dir = copyFixture('default-to-portless');
    try {
      const consumerYaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace('portNames: [charge]', 'portNames: [default]');
      writeFileSync(consumerNodeYaml(dir), consumerYaml, 'utf-8');
      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8')
        .split('\n')
        .filter((l) => l === 'type: provider' || l.startsWith('name:') || l.startsWith('description:') || l.startsWith('mapping:') || l.startsWith('  - '))
        .join('\n');
      expect(providerYaml).not.toContain('ports:');
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('port-undefined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: ports.default with an aspect, consumed by an undeclared relation -> effective, printed, fillable, clean', () => {
    const dir = copyFixture('default-aspect');
    try {
      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8').replace('charge:', 'default:');
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');
      const consumerYaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(/\n\s*portNames: \[charge\]/, '');
      writeFileSync(consumerNodeYaml(dir), consumerYaml, 'utf-8');

      const ctx = run(['context', '--node', CONSUMER], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.all).toContain('audit-required');
      expect(ctx.all).toContain(`port 'default' on '${PROVIDER}'`);

      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(0);

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: ports.default AND ports.charge, a relation naming both -> the consumer gets BOTH aspect sets', () => {
    const dir = copyFixture('both-ports');
    try {
      writeTrivialAspect(dir, 'default-tag', 'Marks every unnamed entry point for testing.');
      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8').replace(
        'ports:\n  charge:',
        'ports:\n  default:\n    description: Every entry point.\n    aspects:\n      - default-tag\n  charge:',
      );
      expect(providerYaml).toContain('default-tag');
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');
      const consumerYaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace('portNames: [charge]', 'portNames: [default, charge]');
      writeFileSync(consumerNodeYaml(dir), consumerYaml, 'utf-8');

      const ctx = run(['context', '--node', CONSUMER], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.all).toContain('audit-required');
      expect(ctx.all).toContain('default-tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: the same pair, a relation naming only [charge] -> ONLY the charge aspect is effective', () => {
    const dir = copyFixture('charge-only-of-both');
    try {
      writeTrivialAspect(dir, 'default-tag', 'Marks every unnamed entry point for testing.');
      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8').replace(
        'ports:\n  charge:',
        'ports:\n  default:\n    description: Every entry point.\n    aspects:\n      - default-tag\n  charge:',
      );
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');
      // Consumer's relation already reads `portNames: [charge]` — unchanged: it
      // names charge only, so `default`'s aspect must not reach it.

      const ctx = run(['context', '--node', CONSUMER], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.all).toContain('audit-required');
      expect(ctx.all).not.toContain('default-tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: portNames: [] -> exit 1, output contains port-names-empty and the source node path', () => {
    const dir = copyFixture('empty-list');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace('portNames: [charge]', 'portNames: []');
      writeFileSync(consumerNodeYaml(dir), yaml, 'utf-8');

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('port-names-empty');
      expect(all).toContain(CONSUMER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: consumes: [charge] (the alias) renders identical yg node --json output to portNames: [charge], byte for byte', () => {
    const portNamesDir = copyFixture('alias-portnames');
    const consumesDir = copyFixture('alias-consumes');
    try {
      const yaml = readFileSync(consumerNodeYaml(consumesDir), 'utf-8').replace('portNames: [charge]', 'consumes: [charge]');
      expect(yaml).toContain('consumes: [charge]');
      writeFileSync(consumerNodeYaml(consumesDir), yaml, 'utf-8');

      const a = run(['node', CONSUMER, '--json'], portNamesDir);
      const b = run(['node', CONSUMER, '--json'], consumesDir);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(b.stdout).toEqual(a.stdout);
    } finally {
      rmSync(portNamesDir, { recursive: true, force: true });
      rmSync(consumesDir, { recursive: true, force: true });
    }
  });

  it('8: consumes and portNames together -> exit 1, output names both keys', () => {
    const dir = copyFixture('both-keys');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(
        'portNames: [charge]',
        'portNames: [charge]\n    consumes: [charge]',
      );
      writeFileSync(consumerNodeYaml(dir), yaml, 'utf-8');

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('portNames');
      expect(all).toContain('consumes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a literal `default` port declared with a description -> exit 0 with a one-time notice, printed again on a second run', () => {
    const dir = copyFixture('reserved-name');
    try {
      // Fill the pre-existing charge pair first, so the reserved-name notice is
      // the ONLY thing standing between this graph and a bare "PASS".
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);

      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8').replace(
        'ports:\n  charge:',
        'ports:\n  default:\n    description: Explicit default, predating the reservation.\n    aspects: []\n  charge:',
      );
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');

      const first = run(['check'], dir);
      expect(first.status).toBe(0);
      expect(first.all).toContain("'default' is a reserved port name");

      const second = run(['check'], dir);
      expect(second.status).toBe(0);
      // Stateless by design — printed again, not suppressed as "already seen".
      expect(second.all).toContain("'default' is a reserved port name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10: yg node --json and yg impact --node --json on an undeclared relation -> yg-node/1 / yg-impact/1, naming default', () => {
    const dir = copyFixture('json-default');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(/\n\s*portNames: \[charge\]/, '');
      writeFileSync(consumerNodeYaml(dir), yaml, 'utf-8');

      const nodeJson = run(['node', CONSUMER, '--json'], dir);
      expect(nodeJson.status).toBe(0);
      const nodeDoc = JSON.parse(nodeJson.stdout);
      expect(nodeDoc.schema).toBe('yg-node/1');
      expect(nodeDoc.relations).toEqual([{ target: PROVIDER, type: 'uses', consumes: ['default'] }]);

      const impactJson = run(['impact', '--node', PROVIDER, '--json'], dir);
      expect(impactJson.status).toBe(0);
      const impactDoc = JSON.parse(impactJson.stdout);
      expect(impactDoc.schema).toBe('yg-impact/1');
      const dependent = impactDoc.dependents.find((d: { node: string }) => d.node === CONSUMER);
      expect(dependent.relations).toEqual([{ type: 'uses', ports: ['default'] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: ports.default with no description -> exit 0; ports.charge with no description -> exit 1 naming ports.charge.description', () => {
    const okDir = copyFixture('default-no-description-ok');
    try {
      const providerYaml = readFileSync(providerNodeYaml(okDir), 'utf-8').replace(
        'ports:\n  charge:',
        'ports:\n  default:\n    aspects: []\n  charge:',
      );
      writeFileSync(providerNodeYaml(okDir), providerYaml, 'utf-8');
      const fill = run(['check', '--approve'], okDir);
      expect(fill.status).toBe(0);
      const ok = run(['check'], okDir);
      expect(ok.status).toBe(0);
    } finally {
      rmSync(okDir, { recursive: true, force: true });
    }

    const failDir = copyFixture('charge-no-description-fail');
    try {
      const providerYaml = readFileSync(providerNodeYaml(failDir), 'utf-8')
        .split('\n')
        .filter((l) => !l.includes('description: Capture a payment'))
        .join('\n');
      expect(providerYaml).not.toContain('description: Capture a payment');
      writeFileSync(providerNodeYaml(failDir), providerYaml, 'utf-8');

      const { status, all } = run(['check'], failDir);
      expect(status).toBe(1);
      expect(all).toContain('ports.charge.description');
    } finally {
      rmSync(failDir, { recursive: true, force: true });
    }
  });

  it('12: a port name with a space and one with unicode, in portNames and ports -> exit 0, yg node prints both', () => {
    const dir = copyFixture('unicode-space');
    try {
      const providerYaml = readFileSync(providerNodeYaml(dir), 'utf-8').replace(
        'ports:\n  charge:',
        'ports:\n  "with space":\n    description: A port named with a space.\n    aspects: []\n  "unikodowy-łańcuch":\n    description: A port named with unicode.\n    aspects: []\n  charge:',
      );
      writeFileSync(providerNodeYaml(dir), providerYaml, 'utf-8');
      const consumerYaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(
        'portNames: [charge]',
        'portNames: [charge, "with space", "unikodowy-łańcuch"]',
      );
      writeFileSync(consumerNodeYaml(dir), consumerYaml, 'utf-8');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);

      const node = run(['node', PROVIDER], dir);
      expect(node.status).toBe(0);
      expect(node.stdout).toContain('with space');
      expect(node.stdout).toContain('unikodowy-łańcuch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("13: regression — a node path with '..' in mapping is still rejected (normalization must not weaken path validation)", () => {
    const dir = copyFixture('mapping-escape');
    try {
      const yaml = readFileSync(consumerNodeYaml(dir), 'utf-8').replace(
        'mapping:\n  - src/services/orders.ts',
        'mapping:\n  - ../escape.ts',
      );
      expect(yaml).toContain('../escape.ts');
      writeFileSync(consumerNodeYaml(dir), yaml, 'utf-8');

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('must not escape it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
