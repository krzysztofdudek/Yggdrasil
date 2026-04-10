import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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

  it('yg check exits with code 0 or 1 and shows Result:', () => {
    const { status, stdout } = run(['check']);
    expect([0, 1]).toContain(status);
    expect(stdout).toContain('Result:');
  });

  it('yg build-context', () => {
    const { stdout, status } = run(['build-context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('Token budget:');
  });

  it('yg build-context nonexistent node', () => {
    const { status } = run(['build-context', '--node', 'does/not/exist']);
    expect(status).toBe(1);
  });

  it('yg build-context without --node or --file returns exit 1', () => {
    const { status, stderr } = run(['build-context']);
    expect(status).toBe(1);
    expect(stderr).toContain("'--node <path>' or '--file <path>' is required");
  });

  it('yg context --node works (renamed from build-context)', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('Token budget:');
  });

  it('yg build-context still works as alias', () => {
    const { stdout, status } = run(['build-context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
  });

  it('yg deps returns non-zero (command removed)', () => {
    const { status } = run(['deps', '--node', 'orders/order-service']);
    expect(status).not.toBe(0);
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

  // --- approve ---

  it('yg approve --node records hash and clears drift', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-approve-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status: approveStatus, stdout } = run(
        ['approve', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(approveStatus).toBe(0);
      expect(stdout).toMatch(/Approved: orders\/order-service/);
      expect(stdout).toMatch(/Hash:/);

      // After approving, check should not show E020 for this node
      const { stdout: checkOut } = run(['check'], tmpDir);
      // The node was just approved — should not show drift for orders/order-service
      const driftLines = checkOut.split('\n').filter((l: string) =>
        l.includes('E020') && l.includes('orders/order-service'),
      );
      expect(driftLines.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg approve without --node returns exit 1', () => {
    const { status, stderr } = run(['approve']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/required option|--node/);
  });

  it('yg approve nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['approve', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain("does not exist");
  });

  // --- drift-sync (backward-compatible alias) ---

  it('yg drift-sync --node records hash via alias', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-drift-sync-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status: syncStatus, stdout } = run(
        ['drift-sync', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(syncStatus).toBe(0);
      expect(stdout).toMatch(/Approved: orders\/order-service/);
      expect(stdout).toMatch(/Hash:/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg drift-sync without --node returns exit 1', () => {
    const { status, stderr } = run(['drift-sync']);
    expect(status).toBe(1);
    expect(stderr).toContain('--node <path> is required');
  });

  it('yg drift-sync --all returns exit 1 with removal message', () => {
    const { status, stderr } = run(['drift-sync', '--all']);
    expect(status).toBe(1);
    expect(stderr).toContain('--all has been removed');
  });

  it('yg drift-sync --recursive --node x returns exit 1 with removal message', () => {
    const { status, stderr } = run(['drift-sync', '--recursive', '--node', 'orders/order-service']);
    expect(status).toBe(1);
    expect(stderr).toContain('--recursive has been removed');
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

  it('yg impact --aspect requires-audit shows directly affected nodes', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Impact of changes in aspect requires-audit');
    expect(stdout).toContain('Directly affected');
    expect(stdout).toContain('orders');
    expect(stdout).toContain('Blast radius:');
  });

  it('yg impact --aspect requires-audit shows indirectly affected structural dependents', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected (structural dependents)');
    expect(stdout).toContain('checkout/controller');
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
    // orders/order-service gets requires-logging from checkout-flow
    expect(stdout).toContain('orders/order-service (flow: Checkout Flow)');
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
    expect(stdout).toContain('Blast radius:');
  });

  it('yg impact --flow checkout-flow shows flow aspects', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Flow aspects: requires-logging');
  });

  it('yg impact --flow checkout-flow shows indirectly affected structural dependents', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected (structural dependents)');
    expect(stdout).toContain('checkout/controller');
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

  it('yg impact --node shows indirect dependents of descendants', () => {
    const { stdout, status } = run(['impact', '--node', 'orders']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected');
    expect(stdout).toContain('checkout/controller');
  });

  it('yg impact --file resolves owner and shows impact', () => {
    const { stdout, status, stderr } = run(['impact', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stderr).toContain('orders/order-service');
    expect(stdout).toContain('Impact of changes in orders/order-service');
  });

  it('yg impact --simulate is rejected (option removed)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--simulate']);
    // Commander treats unknown options as errors
    expect(status).not.toBe(0);
    expect(stderr).toContain('simulate');
  });

  it('yg impact --method is rejected (option removed)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--method', 'verify']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('method');
  });

  it('yg aspects output has no stability field', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('stability');
  });

  // --- init creates structure ---

  it('yg init creates .yggdrasil directory structure', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-'));

    try {
      const { status, stdout } = run(['init'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'yg-config.yaml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'yg-architecture.yaml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'aspects'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'flows'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'model'))).toBe(true);
      expect(stdout).toContain('yg-architecture.yaml');
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

  it('yg init creates yg-architecture.yaml with node types', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-arch-'));

    try {
      const { status } = run(['init'], tmpDir);
      expect(status).toBe(0);
      const architecturePath = path.join(tmpDir, '.yggdrasil', 'yg-architecture.yaml');
      expect(existsSync(architecturePath)).toBe(true);

      const architectureContent = readFileSync(architecturePath, 'utf-8');
      const architecture = parseYaml(architectureContent) as Record<string, unknown>;

      expect(architecture.node_types).toBeDefined();
      expect(architecture.node_types).toHaveProperty('module');
      expect(architecture.node_types).toHaveProperty('service');
      expect(architecture.node_types).toHaveProperty('library');
      expect(architecture.node_types).toHaveProperty('infrastructure');
      expect(architecture.node_types).toHaveProperty('data');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --upgrade creates missing yg-architecture.yaml', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-arch-upgrade-'));

    try {
      // Initial init creates architecture file
      const { status: initStatus } = run(['init', '--platform', 'generic'], tmpDir);
      expect(initStatus).toBe(0);

      // Remove the architecture file to simulate old project
      const architecturePath = path.join(tmpDir, '.yggdrasil', 'yg-architecture.yaml');
      rmSync(architecturePath);
      expect(existsSync(architecturePath)).toBe(false);

      // Run upgrade, should create the missing architecture file
      const { status: upgradeStatus } = run(['init', '--upgrade', '--platform', 'generic'], tmpDir);
      expect(upgradeStatus).toBe(0);

      // Verify architecture file was created
      expect(existsSync(architecturePath)).toBe(true);
      const architectureContent = readFileSync(architecturePath, 'utf-8');
      const architecture = parseYaml(architectureContent) as Record<string, unknown>;
      expect(architecture.node_types).toBeDefined();
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

  // --- select ---

  it('yg select returns structured text with matching nodes', () => {
    const { stdout, status } = run(['select', 'order lifecycle']);
    expect(status).toBe(0);
    expect(stdout).toContain('Nodes:');
    expect(stdout).toContain('Aspects:');
    expect(stdout).toContain('Flows:');
    expect(stdout).toContain('orders/order-service');
  });

  it('yg select with no matches returns (none) sections', () => {
    const { stdout, status } = run(['select', 'quantum blockchain singularity']);
    expect(status).toBe(0);
    expect(stdout).toContain('Nodes:');
    expect(stdout).toContain('(none)');
  });

  it('yg select --limit caps results', () => {
    const { stdout, status } = run(['select', 'order', '--limit', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('Nodes:');
    // With limit 1, only one node line should appear (indented with 2 spaces, containing a path)
    const nodeLines = stdout.split('\n').filter((l: string) => l.match(/^ {2}\S+\/\S+/));
    expect(nodeLines.length).toBeLessThanOrEqual(1);
  });

  it('yg select requires query argument', () => {
    const { status, stderr } = run(['select']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/required argument|query/);
  });

});
