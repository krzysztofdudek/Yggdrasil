import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-build-command-'));
  await cp(FIXTURE, root, { recursive: true });
  return fn(root);
}

describe('context command (unit-like CLI contract)', () => {
  it('requires --node or --file', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync('node', [BIN_PATH, 'context'], {
        cwd,
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/required option|--node/);
    });
  });

  it('context --node prints to stdout', async () => {
    await withFixtureCopy(async (cwd) => {
      const nodePath = 'orders/order-service';
      const result = spawnSync('node', [BIN_PATH, 'context', '--node', nodePath], {
        cwd,
        encoding: 'utf-8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Source files');
      expect(result.stdout).toContain('After modifying source files');
    });
  });

  it('context --node prints context package to stdout', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Source files');
      expect(result.stdout).toContain('After modifying source files');

      const buildDir = path.join(cwd, '.yggdrasil', '_build');
      const exists = await access(buildDir).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    });
  });

  it('context --node <bad> returns missing-node error', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync('node', [BIN_PATH, 'context', '--node', 'does/not/exist'], {
        cwd,
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node not found');
    });
  });

  it('context --file <unmapped> lists candidate nodes from same directory', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--file', 'src/orders/new-feature.ts'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no graph coverage');
      expect(result.stderr).toContain('Other files in the same directory are mapped to these nodes');
      expect(result.stderr).toContain('orders/order-service');
      expect(result.stderr).toContain('yg context --node');
    });
  });

  it('rejects --full flag', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service', '--full'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown option|--full/);
    });
  });

  it('context --file <unmapped-no-siblings> shows no candidates', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--file', 'src/totally-new/module.ts'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no graph coverage');
      expect(result.stderr).not.toContain('Other files in the same directory are mapped to these nodes');
    });
  });
});
