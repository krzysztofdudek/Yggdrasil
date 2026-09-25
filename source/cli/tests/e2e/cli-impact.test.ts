import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
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

describe.skipIf(!distExists)('CLI E2E — impact', () => {
  it('yg impact', () => {
    const { stdout, status } = run(['impact', '--node', 'auth/auth-api']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  // --- impact edge cases ---

  it('yg impact nonexistent node returns exit code 1', () => {
    const { status, stderr } = run(['impact', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain("error[node-not-found]: node 'does/not/exist' is not in the graph");
  });

  it('yg impact without any mode returns exit 1', () => {
    const { status, stderr } = run(['impact']);
    expect(status).toBe(1);
    expect(stderr).toContain('No target specified');
  });

  it('yg impact --node and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
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
    expect(stderr).toContain("error[aspect-not-found]: rule 'nonexistent' is not in the graph");
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
    const { stdout, status } = run(['impact', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    // file->node resolution flows through stdout (informational)
    expect(stdout).toContain('src/orders/order.service.ts -> orders/order-service');
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

  // --- impact extended ---

  it('yg impact --type service shows nodes of that type', () => {
    const { stdout, status } = run(['impact', '--type', 'service']);
    expect(status).toBe(0);
    expect(stdout).toContain('Type: service');
    expect(stdout).toContain('auth/auth-api');
    expect(stdout).toContain('orders/order-service');
  });

  it('yg impact --type nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--type', 'nonexistent-type-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found in architecture');
  });

  it('yg impact --node and --file together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--node', 'orders/order-service', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('mutually exclusive');
  });

  it('yg impact --flow and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--flow', 'checkout-flow', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg impact --file nonexistent path returns exit 1', () => {
    const { status, stderr } = run(['impact', '--file', 'src/does-not-exist.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('not mapped');
  });

  it('yg impact --node lists event-connected nodes (emits/listens)', () => {
    // orders/order-service emits `order.created`; users/user-repo listens to it.
    // The event relation is a distinct blast-radius channel from structural deps.
    const { stdout, status } = run(['impact', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('Event-connected:');
    expect(stdout).toContain('users/user-repo');
    expect(stdout).toContain('order.created');
  });

});
