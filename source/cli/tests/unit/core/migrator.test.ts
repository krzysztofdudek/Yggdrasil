import { describe, it, expect } from 'vitest';
import { runMigrations, detectVersion, updateConfigVersion } from '../../../src/core/migrator.js';
import type { Migration, MigrationResult } from '../../../src/core/migrator.js';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('detectVersion', () => {
  it('reads version from yg-config.yaml', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    await writeFile(path.join(dir, 'yg-config.yaml'), 'version: "3.0.0"\nname: "test"\n');
    expect(await detectVersion(dir)).toBe('3.0.0');
  });

  it('returns null when no config exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    expect(await detectVersion(dir)).toBeNull();
  });

  it('returns null when version field missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    await writeFile(path.join(dir, 'yg-config.yaml'), 'name: "test"\n');
    expect(await detectVersion(dir)).toBeNull();
  });
});

describe('runMigrations', () => {
  it('runs applicable migrations in order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const order: string[] = [];
    const migrations: Migration[] = [
      { to: '5.0.0', description: 'future', run: async () => { order.push('5'); return { actions: ['5'], warnings: [] }; } },
      { to: '4.0.0', description: 'v4', run: async () => { order.push('4'); return { actions: ['4'], warnings: [] }; } },
    ];
    const results = await runMigrations('3.0.0', migrations, dir);
    expect(order).toEqual(['4', '5']);
    expect(results).toHaveLength(2);
  });

  it('skips migrations at or below current version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const migrations: Migration[] = [
      { to: '3.0.0', description: 'old', run: async () => ({ actions: ['old'], warnings: [] }) },
      { to: '4.0.0', description: 'current', run: async () => ({ actions: ['current'], warnings: [] }) },
    ];
    const results = await runMigrations('4.0.0', migrations, dir);
    expect(results).toHaveLength(0);
  });

  it('returns empty for invalid current version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const migrations: Migration[] = [
      { to: '4.0.0', description: 'v4', run: async () => ({ actions: ['4'], warnings: [] }) },
    ];
    const results = await runMigrations('not-a-version', migrations, dir);
    expect(results).toHaveLength(0);
  });

  it('skips migrations with invalid target version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const migrations: Migration[] = [
      { to: 'bad', description: 'invalid', run: async () => ({ actions: ['bad'], warnings: [] }) },
      { to: '4.0.0', description: 'v4', run: async () => ({ actions: ['4'], warnings: [] }) },
    ];
    const results = await runMigrations('3.0.0', migrations, dir);
    expect(results).toHaveLength(1);
    expect(results[0].actions).toEqual(['4']);
  });
});

describe('updateConfigVersion', () => {
  it('updates existing version field', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const configPath = path.join(dir, 'yg-config.yaml');
    await writeFile(configPath, 'version: "3.0.0"\nquality:\n  max_direct_relations: 10\n');
    await updateConfigVersion(dir, '4.0.0');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('version: "4.0.0"');
    expect(content).toContain('quality:');
  });

  it('prepends version when field is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-'));
    const configPath = path.join(dir, 'yg-config.yaml');
    await writeFile(configPath, 'quality:\n  max_direct_relations: 10\n');
    await updateConfigVersion(dir, '4.0.0');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('version: "4.0.0"');
    expect(content).toContain('quality:');
  });
});
