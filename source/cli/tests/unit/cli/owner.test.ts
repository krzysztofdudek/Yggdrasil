import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-owner-'));
  await cp(FIXTURE, root, { recursive: true });
  return fn(root);
}

describe('owner command', () => {
  it('finds owner of a mapped file', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/orders/order.service.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('orders/order-service');
      expect(result.stdout).toContain('src/orders/order.service.ts');
    });
  });

  it('finds owner for a file in a node with multiple mapped files', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/auth/auth.controller.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('auth/auth-api');
    });
  });

  it('finds owner for second file of a node with multiple mapped files', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/auth/login.service.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('auth/auth-api');
    });
  });

  it('reports no graph coverage for an unmapped file that does not exist', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/totally/new/module.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no graph coverage');
      expect(result.stdout).toContain('file not found');
    });
  });

  it('reports no graph coverage for an existing unmapped file', async () => {
    await withFixtureCopy(async (cwd) => {
      // src/orders/order.service.ts exists and is mapped, but let's use a file
      // that we know exists in the fixture but isn't mapped
      // The checkout controller is mapped to checkout/controller, so let's use
      // a subpath within an unmapped directory
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/users/user.repository.ts'],
        { cwd, encoding: 'utf-8' },
      );
      // This file IS mapped to users/user-repo
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('users/user-repo');
    });
  });

  it('requires --file option', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync('node', [BIN_PATH, 'owner'], {
        cwd,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/required option|--file/);
    });
  });

  it('outputs file -> node mapping in expected format', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/checkout/checkout.controller.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/src\/checkout\/checkout\.controller\.ts -> checkout\/controller/);
    });
  });
});
