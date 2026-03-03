import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FULL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const BROKEN_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-broken-relation');

async function withFixtureCopy<T>(fixture: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-build-pipeline-'));
  await cp(fixture, root, { recursive: true });
  return fn(root);
}

describe('build-context pipeline integration', () => {
  it('build-context --node writes context to stdout for valid node', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'build-context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('<context-package ');
      expect(result.stdout).toContain('node-name="OrderService"');
      expect(result.stdout).toContain('<global>');
    });
  });

  it('build-context --node is deterministic', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const first = spawnSync(
        'node',
        [BIN_PATH, 'build-context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(first.status).toBe(0);

      const second = spawnSync(
        'node',
        [BIN_PATH, 'build-context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(second.status).toBe(0);

      const stripVariableParts = (content: string) =>
        content
          .replace(/token-count="\d+"/, 'token-count="X"')
          .replace(/Budget status: \w+/, 'Budget status: X');

      expect(stripVariableParts(second.stdout)).toBe(stripVariableParts(first.stdout));
    });
  });

  it('build-context fails on broken relation with structural error message', async () => {
    await withFixtureCopy(BROKEN_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'build-context', '--node', 'orders/broken-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('build-context blocked by');
    });
  });
});
