import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectIssue, expectNext, parseJson } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string) {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-reldef-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const ordersNode = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const ordersSrc = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

/** Full architecture with a `service` type carrying the given relations block.
 *  `relationsBlock` must be the 4-space-indented `relations:` block (or ''). */
function archWith(relationsBlock: string): string {
  return `node_types:
  module:
    description: 'Organizational grouping.'
    log_required: false
  service:
    description: 'A service unit under src/services/.'
    log_required: false
    when:
      path: "src/services/**"
    parents: [module]
${relationsBlock}`;
}
/** Orders node declaring exactly one relation (target,type), no own aspects. */
function writeOrders(dir: string, target: string, relType: string): void {
  writeFileSync(
    ordersNode(dir),
    `name: OrdersService
description: Creates and retrieves customer orders.
type: service
mapping:
  - src/services/orders.ts
relations:
  - target: ${target}
    type: ${relType}
`,
    'utf-8',
  );
}
/** Orders node with NO relations (for the undeclared-dependency suggestion). */
function writeOrdersNoRel(dir: string): void {
  writeFileSync(
    ordersNode(dir),
    `name: OrdersService
description: Creates and retrieves customer orders.
type: service
mapping:
  - src/services/orders.ts
`,
    'utf-8',
  );
}
/** Make orders.ts statically import payments.ts (a resolvable cross-node dep). */
function addPaymentsImport(dir: string): void {
  const src = readFileSync(ordersSrc(dir), 'utf-8');
  writeFileSync(ordersSrc(dir), `import { charge } from './payments';\nvoid charge;\n${src}`, 'utf-8');
}
/** Build a service relations block from inner lines (already 6-space indented). */
const rel = (...lines: string[]) => `    relations:\n${lines.map((l) => `      ${l}`).join('\n')}\n`;

function setup(label: string, relationsBlock: string, target: string, relType: string) {
  const dir = copyFixture(label);
  writeFileSync(archPath(dir), archWith(relationsBlock), 'utf-8');
  writeOrders(dir, target, relType);
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — architecture relation default policy', () => {
  // --- default: deny ---
  it('C1: default:deny rejects an unlisted relation type to any target', () => {
    const dir = setup('c1', rel('default: deny'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      expect(all).toMatch(/denies relation 'calls' by default/);
      expect(all).not.toContain('unknown relation type'); // default key is reserved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: default:deny + calls:[*] allows calls to a same-type target', () => {
    const dir = setup('c2', rel('default: deny', "calls: ['*']"), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: default:deny + calls:[*] allows calls to a cross-type (module) target', () => {
    const dir = setup('c3', rel('default: deny', "calls: ['*']"), 'services', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- explicit lists ---
  it('C4: empty list calls:[] denies that relation type', () => {
    const dir = setup('c4', rel('calls: []'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      expect(all).toMatch(/Allowed targets for 'calls' from type 'service': \[\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5: wildcard calls:[*] allows any target', () => {
    const dir = setup('c5', rel("calls: ['*']"), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C6: non-empty list allows a listed same-type target (regression)', () => {
    const dir = setup('c6', rel('calls: [service]'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7: non-empty list rejects a forbidden cross-type target (regression)', () => {
    const dir = setup('c7', rel('calls: [service]'), 'services', 'calls');
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      expect(all).toMatch(/Allowed targets for 'calls' from type 'service': \[service\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- default omitted / explicit allow ---
  it('C8: omitted default leaves an unlisted relation type unconstrained', () => {
    const dir = setup('c8', rel('uses: [service]'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C9: explicit default:allow with calls:[] still denies calls', () => {
    const dir = setup('c9', rel('default: allow', 'calls: []'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-target-forbidden');
      expect(all).toMatch(/Allowed targets for 'calls' from type 'service': \[\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C10: explicit default:allow leaves an unlisted relation type unconstrained', () => {
    const dir = setup('c10', rel('default: allow'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- parser error path ---
  it('C11: an invalid default value is a blocking parse error', () => {
    const dir = setup('c11', rel('default: maybe'), 'services/payments', 'calls');
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toMatch(/relations\.default must be 'allow' or 'deny'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- conformance suggestion honors default + wildcard ---
  it('C12: undeclared-dependency suggestion lists only allowed types (deny + [*])', () => {
    const dir = copyFixture('c12');
    try {
      writeFileSync(archPath(dir), archWith(rel('default: deny', "calls: ['*']")), 'utf-8');
      writeOrdersNoRel(dir);
      addPaymentsImport(dir);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-undeclared-dependency');
      expect(all).toContain('type: calls');
      expect(all).not.toContain('type: uses');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C13: undeclared-dependency on a pure sink reports a dead-end', () => {
    const dir = copyFixture('c13');
    try {
      writeFileSync(archPath(dir), archWith(rel('default: deny')), 'utf-8');
      writeOrdersNoRel(dir);
      addPaymentsImport(dir);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('relation-undeclared-dependency');
      expect(all).toMatch(/no relation type is allowed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C13b: a dead-end refusal points its next step at the import to remove, not at yg-node.yaml', () => {
    const dir = copyFixture('c13b');
    try {
      writeFileSync(archPath(dir), archWith(rel('default: deny')), 'utf-8');
      writeOrdersNoRel(dir);
      addPaymentsImport(dir);
      const { status, stdout } = run(['check', '--json'], dir);
      expect(status).toBe(1);
      const doc = parseJson(stdout);
      expectIssue(doc, { code: 'relation-undeclared-dependency', node: 'services/orders' });
      expectNext(doc, { command: null, file: 'src/services/orders.ts', node: 'services/orders' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // yg-check/1 says structurally whether a dependency can be declared at all,
  // so a consumer (Horde) never reads it out of the `next` sentence.
  it('C13c: --json names, per edge, the relations that could be declared — none on a dead end, the allowed ones otherwise', () => {
    const edgesOf = (dir: string) => {
      const doc = parseJson(run(['check', '--json'], dir).stdout);
      return expectIssue(doc, { code: 'relation-undeclared-dependency', node: 'services/orders' }).edges as Array<{ target: string; allowedRelations?: string[] }>;
    };
    const dead = copyFixture('c13c-dead');
    const open = copyFixture('c13c-open');
    try {
      writeFileSync(archPath(dead), archWith(rel('default: deny')), 'utf-8');
      writeOrdersNoRel(dead);
      addPaymentsImport(dead);
      const deadEdges = edgesOf(dead);
      expect(deadEdges.length).toBeGreaterThan(0);
      for (const e of deadEdges) expect(e.allowedRelations, JSON.stringify(e)).toEqual([]);

      writeFileSync(archPath(open), archWith(rel('default: deny', "calls: ['*']")), 'utf-8');
      writeOrdersNoRel(open);
      addPaymentsImport(open);
      for (const e of edgesOf(open)) expect(e.allowedRelations, JSON.stringify(e)).toEqual(['calls']);
    } finally {
      rmSync(dead, { recursive: true, force: true });
      rmSync(open, { recursive: true, force: true });
    }
  });
});
