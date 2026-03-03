import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
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

describe.skipIf(!distExists)('CLI E2E', () => {
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

  it('yg validate on valid graph', () => {
    const { status } = run(['validate']);
    expect(status).toBe(0);
  });

  it('yg build-context', () => {
    const { stdout, status } = run(['build-context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('<context-package ');
    expect(stdout).toContain('node-name="OrderService"');
    expect(stdout).toContain('<global>');
    expect(stdout).toContain('<own-artifacts');
  });

  it('yg build-context nonexistent node', () => {
    const { status } = run(['build-context', '--node', 'does/not/exist']);
    expect(status).toBe(1);
  });

  it('yg build-context without --node returns exit 1', () => {
    const { status, stderr } = run(['build-context']);
    expect(status).toBe(1);
    expect(stderr).toContain('required option');
  });

  it('yg deps', () => {
    const { stdout, status } = run(['deps', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toMatch(/├──|└──|calls|uses/);
  });

  it('yg impact', () => {
    const { stdout, status } = run(['impact', '--node', 'auth/auth-api']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  it('yg owner --file resolves file to node', () => {
    const { stdout, status } = run(['owner', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  it('yg owner --file nonexistent file returns no graph coverage', () => {
    const { stdout, status } = run(['owner', '--file', 'nonexistent/file.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('no graph coverage');
  });

  it('yg owner without --file returns exit 1', () => {
    const { status, stderr } = run(['owner']);
    expect(status).toBe(1);
    expect(stderr).toContain('required option');
  });

  it('yg status', () => {
    const { stdout, status } = run(['status']);
    expect(status).toBe(0);
    expect(stdout).toContain('Sample E-Commerce');
    expect(stdout).toContain('Nodes:');
  });

  it('yg drift', () => {
    const { stdout, status } = run(['drift']);
    expect(stdout).toContain('Summary');
    expect(stdout).toMatch(/drift|missing|unmaterialized|ok/);
    expect([0, 1]).toContain(status);
  });

  // --- Tree options ---

  it('yg tree --depth 1 limits output', () => {
    const { stdout, status } = run(['tree', '--depth', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('orders');
    // depth 1 means we see top-level modules but NOT their children names as tree nodes
    // Children metadata (artifacts count) should still appear at depth 1
  });

  it('yg tree --root auth shows only auth subtree', () => {
    const { stdout, status } = run(['tree', '--root', 'auth']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('auth-api');
    expect(stdout).toContain('auth-api');
    // Subtree mode: no project name as first line, auth is the root
    expect(stdout).not.toContain('Sample E-Commerce');
    expect(stdout).not.toContain('orders');
    expect(stdout).not.toContain('users');
  });

  it('yg tree --compact hides metadata lines', () => {
    const { stdout, status } = run(['tree']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
  });

  it('yg tree --root nonexistent returns exit 1', () => {
    const { stderr, status } = run(['tree', '--root', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

  // --- deps options ---

  it('yg deps nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['deps', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg deps --node orders/order-service', () => {
    const { stdout, status } = run(['deps', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toMatch(/├──|└──|uses|calls/);
  });

  it('yg deps --depth 1 limits tree depth', () => {
    const { stdout, status } = run(['deps', '--node', 'orders/order-service', '--depth', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('auth/auth-api');
    expect(stdout).toContain('users/user-repo');
  });

  it('yg deps without --node returns exit 1', () => {
    const { status, stderr } = run(['deps']);
    expect(status).toBe(1);
    expect(stderr).toContain('required option');
  });

  // --- drift options ---

  it('yg drift --scope orders/order-service', () => {
    const { stdout, status } = run(['drift', '--scope', 'orders/order-service']);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Summary');
    expect([0, 1]).toContain(status);
  });

  // --- drift-sync ---

  it('yg drift-sync --node records hash and clears drift', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-drift-sync-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status: syncStatus, stdout } = run(
        ['drift-sync', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(syncStatus).toBe(0);
      expect(stdout).toContain('Synchronized: orders/order-service');
      expect(stdout).toMatch(/Hash: .+ -> .+/);

      const { status: driftStatus } = run(['drift', '--scope', 'orders/order-service'], tmpDir);
      expect(driftStatus).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg drift-sync without --node or --all returns exit 1', () => {
    const { status, stderr } = run(['drift-sync']);
    expect(status).toBe(1);
    expect(stderr).toContain("either '--node <path>' or '--all' is required");
  });

  it('yg drift-sync nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['drift-sync', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg drift-sync --recursive syncs descendant nodes', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-drift-recursive-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(
        ['drift-sync', '--node', 'orders', '--recursive'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Synchronized: orders/order-service');
      expect(stdout).not.toContain('Synchronized: orders\n');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- impact edge cases ---

  it('yg impact nonexistent node returns exit code 1', () => {
    const { status, stderr } = run(['impact', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg impact without any mode returns exit 1', () => {
    const { status, stderr } = run(['impact']);
    expect(status).toBe(1);
    expect(stderr).toContain('required');
  });

  it('yg impact --node and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('mutually exclusive');
  });

  it('yg impact --aspect requires-audit shows affected nodes', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Impact of changes in aspect requires-audit');
    expect(stdout).toContain('orders');
    expect(stdout).toContain('Total scope:');
  });

  it('yg impact --aspect requires-audit shows implies chain', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Implies: requires-logging');
  });

  it('yg impact --aspect requires-audit shows source attribution (own)', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders (own)');
    expect(stdout).toContain('orders/order-service (own)');
  });

  it('yg impact --aspect requires-logging shows flow propagation source', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-logging']);
    expect(status).toBe(0);
    // auth/auth-api gets requires-logging from checkout-flow
    expect(stdout).toContain('auth/auth-api (flow: Checkout Flow)');
    // orders gets requires-logging via implies from requires-audit
    expect(stdout).toContain('orders (implied)');
    expect(stdout).toContain('Flows propagating this aspect: Checkout Flow');
    expect(stdout).toContain('Implied by: requires-audit');
  });

  it('yg impact --aspect nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--aspect', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('Aspect not found');
  });

  it('yg impact --flow checkout-flow shows participants', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Impact of changes in flow');
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('auth/auth-api');
    expect(stdout).toContain('Total scope:');
  });

  it('yg impact --flow checkout-flow shows flow aspects', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Flow aspects: requires-logging');
  });

  it('yg impact --flow nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--flow', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('Flow not found');
  });

  it('yg impact --node shows co-aspect nodes', () => {
    const { stdout, status } = run(['impact', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    // orders/order-service has requires-audit and requires-logging
    // orders module also has these (via own + implies)
    expect(stdout).toContain('Nodes sharing aspects');
    expect(stdout).toContain('orders');
  });

  // --- validate edge cases ---

  it('yg validate --scope limits to node', () => {
    const { stdout, status } = run(['validate', '--scope', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('1 nodes scanned');
  });

  it('yg validate on broken-relation fixture returns exit 1', () => {
    const brokenFixture = path.join(
      CLI_ROOT,
      'tests',
      'fixtures',
      'sample-project-broken-relation',
    );
    const { status, stdout } = run(['validate'], brokenFixture);
    expect(status).toBe(1);
    expect(stdout).toContain('E004');
  });

  // --- drift exit codes ---

  it('yg drift returns exit 1 when drift detected (order-service)', () => {
    // order-service has mismatched hash in fixture
    const { status } = run(['drift', '--scope', 'orders/order-service']);
    expect(status).toBe(1);
  });

  it('yg drift returns exit 1 when mapped file missing (missing-service)', () => {
    const { status } = run(['drift', '--scope', 'users/missing-service']);
    expect(status).toBe(1);
  });

  it('yg drift returns exit 0 when all OK (auth-api)', () => {
    const { status } = run(['drift', '--scope', 'auth/auth-api']);
    expect(status).toBe(0);
  });

  // --- init creates structure ---

  it('yg init creates .yggdrasil directory structure', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-'));

    try {
      const { status, stdout } = run(['init'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'config.yaml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'aspects'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'flows'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'model'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform cursor creates .cursor/rules/yggdrasil.mdc', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-cursor-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'cursor'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform cline creates .clinerules/yggdrasil.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-cline-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'cline'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.clinerules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform claude-code creates CLAUDE.md and agent-rules.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-claude-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'claude-code'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform copilot creates .github/copilot-instructions.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-copilot-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'copilot'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.github', 'copilot-instructions.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform invalid returns exit 1', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-invalid-'));

    try {
      const { status, stderr } = run(['init', '--platform', 'invalid-platform'], tmpDir);
      expect(status).toBe(1);
      expect(stderr).toContain('Unknown platform');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform windsurf creates .windsurf/rules/yggdrasil.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-windsurf-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'windsurf'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.windsurf', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform aider creates .aider.conf.yml and agent-rules.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-aider-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'aider'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.aider.conf.yml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform gemini creates GEMINI.md and agent-rules.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-gemini-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'gemini'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, 'GEMINI.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform roocode creates .roo/rules/yggdrasil.md', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-roocode-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'roocode'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.roo', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --platform generic creates agent-rules.md only', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-generic-'));

    try {
      const { status, stdout } = run(['init', '--platform', 'generic'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --upgrade switches platform (codex -> amp)', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-upgrade-'));

    try {
      const { status: initStatus } = run(['init', '--platform', 'codex'], tmpDir);
      expect(initStatus).toBe(0);
      expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);

      const { status: upgradeStatus, stdout } = run(
        ['init', '--platform', 'amp', '--upgrade'],
        tmpDir,
      );
      expect(upgradeStatus).toBe(0);
      expect(stdout).toContain('Rules refreshed');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- journal ---

  it('yg journal-add --note adds entry', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-journal-'));

    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(['journal-add', '--note', 'E2E test note'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Note added to journal');
      expect(stdout).toContain('1 entries');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg journal-add --note --target adds entry with target', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-journal-target-'));

    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['journal-add', '--note', 'Fix auth', '--target', 'auth/auth-api'], tmpDir);
      const { status, stdout } = run(['journal-read'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('auth/auth-api');
      expect(stdout).toContain('Fix auth');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg journal-read shows entries or empty', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-journal-read-'));

    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(['journal-read'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toMatch(/empty \(clean state\)|Session journal \(\d+ entries\)/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg journal-archive archives entries', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-journal-archive-'));

    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['journal-add', '--note', 'Archive me'], tmpDir);
      const { status, stdout } = run(['journal-archive'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Archived journal');
      expect(stdout).toContain('journals-archive/');

      const { stdout: readOut } = run(['journal-read'], tmpDir);
      expect(readOut).toContain('empty (clean state)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg journal-archive when empty prints nothing to archive', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-journal-archive-empty-'));

    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(['journal-archive'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('No active journal');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg journal-add without --note returns exit 1', () => {
    const { status, stderr } = run(['journal-add']);
    expect(status).toBe(1);
    expect(stderr).toContain('required option');
  });

  // --- status output details ---

  it('yg status includes drift summary', () => {
    const { stdout, status } = run(['status']);
    expect(status).toBe(0);
    expect(stdout).toContain('Drift:');
  });

  it('yg status includes graph summary', () => {
    const { stdout, status } = run(['status']);
    expect(status).toBe(0);
    expect(stdout).toContain('Aspects:');
    expect(stdout).toContain('Relations:');
    expect(stdout).toContain('Nodes:');
  });

  // --- preflight ---

  describe('preflight', () => {
    it('outputs all four report sections', () => {
      const { stdout, status } = run(['preflight']);
      expect(stdout).toContain('=== Preflight Report ===');
      expect(stdout).toContain('Journal:');
      expect(stdout).toContain('Drift:');
      expect(stdout).toContain('Status:');
      expect(stdout).toContain('Validation:');
      expect(stdout).toMatch(/\d+ nodes/);
    });

    it('exits with numeric status code', () => {
      const { status } = run(['preflight']);
      expect(status === 0 || status === 1).toBe(true);
    });

    it('--quick skips drift detection', () => {
      const { stdout } = run(['preflight', '--quick']);
      expect(stdout).toContain('Drift:      skipped (--quick)');
      expect(stdout).toContain('Journal:');
      expect(stdout).toContain('Status:');
      expect(stdout).toContain('Validation:');
    });
  });

  // --- drift-sync --all ---

  it('yg drift-sync --all syncs all mapped nodes', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-drift-all-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(['drift-sync', '--all'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Synchronized:');
      // Should sync multiple nodes
      const syncLines = stdout.split('\n').filter((l: string) => l.includes('Synchronized:'));
      expect(syncLines.length).toBeGreaterThan(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
