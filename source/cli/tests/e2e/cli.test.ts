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

  it('yg context', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('After modifying source files');
  });

  it('yg context nonexistent node', () => {
    const { status } = run(['context', '--node', 'does/not/exist']);
    expect(status).toBe(1);
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

      // After approving, check should not show source-drift for this node
      const { stdout: checkOut } = run(['check'], tmpDir);
      // The node was just approved — should not show drift for orders/order-service
      const driftLines = checkOut.split('\n').filter((l: string) =>
        l.includes('source-drift') && l.includes('orders/order-service'),
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

  it('yg impact --simulate is rejected (unknown option)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--simulate']);
    // Commander treats unknown options as errors
    expect(status).not.toBe(0);
    expect(stderr).toContain('simulate');
  });

  it('yg impact --method is rejected (unknown option)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--method', 'verify']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('method');
  });

  it('yg aspects output has no stability field', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('stability');
  });

  // --- platform installation (direct unit tests) ---

  it('installRulesForPlatform cursor creates .cursor/rules/yggdrasil.mdc', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-cursor-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'cursor');
      expect(existsSync(path.join(tmpDir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform cline creates .clinerules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-cline-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'cline');
      expect(existsSync(path.join(tmpDir, '.clinerules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform claude-code creates CLAUDE.md and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-claude-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'claude-code');
      expect(existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform copilot creates .github/copilot-instructions.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-copilot-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'copilot');
      expect(existsSync(path.join(tmpDir, '.github', 'copilot-instructions.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform windsurf creates .windsurf/rules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-windsurf-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'windsurf');
      expect(existsSync(path.join(tmpDir, '.windsurf', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform aider creates .aider.conf.yml and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-aider-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'aider');
      expect(existsSync(path.join(tmpDir, '.aider.conf.yml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform gemini creates GEMINI.md and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-gemini-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'gemini');
      expect(existsSync(path.join(tmpDir, 'GEMINI.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform roocode creates .roo/rules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-roocode-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'roocode');
      expect(existsSync(path.join(tmpDir, '.roo', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform codex creates AGENTS.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-codex-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'codex');
      expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform generic creates agent-rules.md only', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-generic-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'generic');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
