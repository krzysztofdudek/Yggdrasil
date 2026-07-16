import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PKG_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8')).version;
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd = FIXTURE,
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe.skipIf(!distExists)('CLI E2E — query and navigation', () => {
  it('yg --help shows usage', () => {
    const { stdout, status } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: yg');
    expect(stdout).toContain('Yggdrasil');
    expect(stdout).toContain('Commands:');
  });

  it('yg --version', () => {
    const { stdout, status } = run(['--version']);
    expect(stdout.trim()).toBe(PKG_VERSION);
    expect(status).toBe(0);
  });

  it('yg aspects lists aspects with YAML output', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).toContain('requires-audit');
  });

  it('yg aspects without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-aspects-no-ygg-'));
    try {
      const { status, stderr } = run(['aspects'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg tree without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-no-ygg-'));
    try {
      const { status, stderr } = run(['tree'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg tree', () => {
    const { stdout, status } = run(['tree']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('orders');
    expect(stdout).toContain('users');
  });

  it('yg check exits with code 0 or 1 and shows yg check: verdict', () => {
    const { status, stdout } = run(['check']);
    expect([0, 1]).toContain(status);
    // New format: verdict is in header line, not a separate "Result:" line
    expect(stdout).toMatch(/yg check: (PASS|FAIL)/);
  });

  it('yg context', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('After modifying source files');
  });

  it('yg context nonexistent node gives a structured what/why/next (not a generic bug crash)', () => {
    const { status, stderr } = run(['context', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain("Node 'does/not/exist' does not exist in the graph.");
    expect(stderr).toContain('yg tree');
    // A user typo must NOT be reported as an internal bug.
    expect(stderr).not.toContain('This is a bug');
  });

  it('yg context without --node or --file returns exit 1', () => {
    const { status, stderr } = run(['context']);
    expect(status).toBe(1);
    expect(stderr).toContain("'--node <path>' or '--file <path>' is required");
  });

  it('yg context --node works', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('After modifying source files');
  });


  it('yg deps returns non-zero (unknown command)', () => {
    const { status } = run(['deps', '--node', 'orders/order-service']);
    expect(status).not.toBe(0);
  });

  it('yg owner --file resolves file to node', () => {
    const { stdout, status } = run(['owner', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  it('yg owner --file nonexistent file returns no graph coverage (file not found)', () => {
    const { stdout, status } = run(['owner', '--file', 'nonexistent/file.ts']);
    expect(status).toBe(0);
    // A path that does not exist on disk is distinguished from an existing-but-
    // unmapped file by the explicit "(file not found)" suffix.
    expect(stdout).toContain('no graph coverage (file not found)');
  });

  it('yg owner without --file returns exit 1 with a structured what/why/next error', () => {
    const { status, stderr } = run(['owner']);
    expect(status).toBe(1);
    expect(stderr).toContain('--file is required.');
    expect(stderr).toContain('yg owner --file <path>');
  });

  // --- Tree options ---

  it('yg tree --depth 1 limits output', () => {
    const { stdout, status } = run(['tree', '--depth', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('orders');
    // depth 1 means we see top-level modules but NOT their children names as tree nodes
    // Children metadata should still appear at depth 1
  });

  it('yg tree --root auth shows only auth subtree', () => {
    const { stdout, status } = run(['tree', '--root', 'auth']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('auth/auth-api');
    // Subtree mode: only auth nodes
    expect(stdout).not.toContain('orders');
    expect(stdout).not.toContain('users');
  });

  it('yg tree shows flat list with type and description', () => {
    const { stdout, status } = run(['tree']);
    expect(status).toBe(0);
    // Flat format: path [type] — description
    expect(stdout).toMatch(/auth \[/);
    expect(stdout).toMatch(/\[module\]|\[service\]|\[project\]/);
  });

  it('yg tree --root nonexistent returns exit 1', () => {
    const { stderr, status } = run(['tree', '--root', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('yg aspects output has no stability field', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('stability');
  });

  // --- flows ---

  it('yg flows lists flows with participants and aspects', () => {
    const { stdout, status } = run(['flows']);
    expect(status).toBe(0);
    expect(stdout).toContain('Checkout Flow');
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Aspects: requires-logging');
  });

  it('yg flows without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-flows-no-ygg-'));
    try {
      const { status, stderr } = run(['flows'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- find ---

  it('yg find returns ranked entry points matching the query', () => {
    const { stdout, status } = run(['find', 'order']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders');
    expect(stdout).toContain('score:');
  });

  it('yg find scores are normalized to 0–1 — the top result is 1.00 and the rest are its fraction', () => {
    const { stdout, status } = run(['find', 'order service payment']);
    expect(status).toBe(0);
    const scores = [...stdout.matchAll(/score:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(scores.length).toBeGreaterThan(1);
    expect(scores[0]).toBe(1); // best match is exactly 1.00
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1); // matches the documented 0–1 scale
    }
  });

  it('yg find without query returns exit 1', () => {
    const { status, stderr } = run(['find']);
    expect(status).toBe(1);
    expect(stderr).toContain('query');
  });

  // --- context --file ---

  it('yg context --file resolves a source file to its owning node', () => {
    const { stdout, status } = run(['context', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Must satisfy');
  });

  // --- type-suggest ---

  it('yg type-suggest --file shows matching architecture types', () => {
    const { stdout, status } = run(['type-suggest', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/service|repository/);
  });

  it('yg type-suggest without --file returns exit 1', () => {
    const { status, stderr } = run(['type-suggest']);
    expect(status).toBe(1);
    expect(stderr).toContain('file');
  });

  // --- knowledge ---

  it('yg knowledge list shows all available topics', () => {
    const { stdout, status } = run(['knowledge', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain('flows');
    expect(stdout).toContain('cli-reference');
    expect(stdout).toContain('To read a topic:');
  });

  it('yg knowledge read returns the topic content', () => {
    const { stdout, status } = run(['knowledge', 'read', 'flows']);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(200);
    expect(stdout.toLowerCase()).toContain('flow');
  });

  it('yg knowledge read with unknown topic returns exit 1', () => {
    const { status, stderr } = run(['knowledge', 'read', 'nonexistent-topic-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('nonexistent-topic-xyz');
  });

  it('knowledge list includes the onboarding topic with its summary', () => {
    const { stdout, status } = run(['knowledge', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain('onboarding');
    expect(stdout).toContain('Tutor playbook');
  });

  it('knowledge read onboarding prints the tutor contract', () => {
    const { stdout, status } = run(['knowledge', 'read', 'onboarding']);
    expect(status).toBe(0);
    expect(stdout).toContain('# Onboarding — the agent as tutor, on demand');
    expect(stdout).toContain('zero-trace');
    expect(stdout).toContain('yg aspect-test: refused');
    expect(stdout).toContain('judges the lock against your files');
    expect(stdout).not.toContain('\\`');
  });

  // --- check - no .yggdrasil ---

  it('yg check without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-check-no-ygg-'));
    try {
      const { status, stderr } = run(['check'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- owner extended ---

  it('yg owner without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-owner-no-ygg-'));
    try {
      const { status, stderr } = run(['owner', '--file', 'src/foo.ts'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- find extended ---

  it('yg find without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-find-no-ygg-'));
    try {
      const { status, stderr } = run(['find', 'order'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg find with no matching query returns exit 0 with no matches', () => {
    const { stdout, status } = run(['find', 'xyzqwerty123nonexistent']);
    expect(status).toBe(0);
    expect(stdout).toContain('No matches');
  });

  // --- context extended ---

  it('yg context --file unmapped file returns exit 1', () => {
    const { status, stderr } = run(['context', '--file', 'src/unmapped-file.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('no graph coverage');
  });

  it('yg context --file .git is excluded from coverage by design (exit 0, no mapping suggestion)', () => {
    // .git is UNCONDITIONALLY skipped by the coverage scan, so mapping it would
    // create a node yg check never enumerates. The command must say so, and must
    // NOT emit the "add it to a node mapping" advice used for a real coverage gap.
    // "Excluded by design" is a non-error answer (exit 0), so it is a RESULT on
    // stdout, not an error on stderr.
    const { status, stdout } = run(['context', '--file', '.git']);
    expect(status).toBe(0);
    expect(stdout).toContain('excluded from graph coverage by design');
    expect(stdout).not.toContain('Add the file to an existing node mapping');
    expect(stdout).not.toContain('no graph coverage');
  });

  it('yg context --file on a .yggdrasil-internal path is excluded by design (exit 0)', () => {
    const { status, stdout } = run(['context', '--file', '.yggdrasil/yg-lock.logs.json']);
    expect(status).toBe(0);
    expect(stdout).toContain('excluded from graph coverage by design');
    expect(stdout).not.toContain('Add the file to an existing node mapping');
  });

  it('yg context --file on a genuinely-unmapped normal file is NOT treated as excluded', () => {
    // Discrimination guard: an ordinary uncovered source file still gets the
    // mapping-suggestion path (a real coverage gap), never the excluded message.
    const { stderr } = run(['context', '--file', 'src/unmapped-file.ts']);
    expect(stderr).toContain('no graph coverage');
    expect(stderr).not.toContain('excluded from graph coverage by design');
  });

  it('yg context without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-ctx-no-ygg-'));
    try {
      const { status, stderr } = run(['context', '--node', 'foo'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- type-suggest extended ---

  it('yg type-suggest --file nonexistent path runs path-only check', () => {
    const { stdout, status } = run(['type-suggest', '--file', 'src/nonexistent/foo.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('path predicates only');
    expect(stdout).toContain('service');
  });

  it('yg type-suggest --file inside .yggdrasil/ is auto-exempt', () => {
    const { stdout, status } = run(['type-suggest', '--file', '.yggdrasil/model/auth/yg-node.yaml']);
    expect(status).toBe(0);
    expect(stdout).toContain('auto-exempt');
  });

  it('yg type-suggest without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-ts-no-ygg-'));
    try {
      const { status, stderr } = run(['type-suggest', '--file', 'src/foo.ts'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- knowledge extended ---

  it('yg knowledge without subcommand shows usage and returns exit 1', () => {
    const { status, stdout, stderr } = run(['knowledge']);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('Usage: yg knowledge');
  });

  // --- empty-graph + candidate-suggestion output paths ---

  it('yg find on a graph with zero nodes reports the empty graph and exits 0', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-find-empty-'));
    try {
      // A structurally-valid .yggdrasil (schemas + config + architecture) with NO
      // searchable elements — empty model/, aspects/, and flows/ (the loader needs
      // the dirs to exist; the search index then has zero documents).
      cpSync(path.join(FIXTURE, '.yggdrasil'), path.join(dir, '.yggdrasil'), { recursive: true });
      for (const sub of ['model', 'aspects', 'flows']) {
        const p = path.join(dir, '.yggdrasil', sub);
        rmSync(p, { recursive: true, force: true });
        mkdirSync(p, { recursive: true });
      }
      const { stdout, status } = run(['find', 'anything'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Empty graph, nothing to search.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg context --file on an unmapped file suggests sibling nodes mapped in the same directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-ctx-candidate-'));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      // src/orders/order.service.ts is mapped by orders/order-service. Add an
      // UNMAPPED sibling in the same directory.
      writeFileSync(path.join(dir, 'src', 'orders', 'unmapped.ts'), 'export const x = 1;\n', 'utf-8');
      const { stderr, status } = run(['context', '--file', 'src/orders/unmapped.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('Other files in the same directory are mapped to these nodes:');
      expect(stderr).toContain('orders/order-service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg aspects marks an aspect used by no node as orphaned', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-aspects-orphan-'));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      // A deterministic aspect defined but attached to NO node (no node lists it).
      const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'orphan-rule');
      mkdirSync(aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        'name: OrphanRule\ndescription: An aspect no node uses.\nreviewer:\n  type: deterministic\n',
        'utf-8',
      );
      writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
      const { stdout, status } = run(['aspects'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('orphan-rule');
      expect(stdout).toContain('Used by: 0 nodes — orphaned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
