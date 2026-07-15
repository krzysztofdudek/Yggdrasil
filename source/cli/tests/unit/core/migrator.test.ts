import { describe, it, expect, afterEach } from 'vitest';
import { detectVersion, updateConfigVersion } from '../../../src/core/migrator.js';
import type { Migration } from '../../../src/core/migrator.js';
import { runVersionUpgrade } from '../../../src/core/migrator-runner.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('detectVersion', () => {
  it('reads version from yg-config.yaml', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    await writeFile(path.join(dir, 'yg-config.yaml'), 'version: "3.0.0"\nname: "test"\n');
    expect(await detectVersion(dir)).toBe('3.0.0');
  });

  it('returns null when no config exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    expect(await detectVersion(dir)).toBeNull();
  });

  it('returns null when version field missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    await writeFile(path.join(dir, 'yg-config.yaml'), 'name: "test"\n');
    expect(await detectVersion(dir)).toBeNull();
  });
});

describe('updateConfigVersion', () => {
  it('updates existing version field', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    const configPath = path.join(dir, 'yg-config.yaml');
    await writeFile(configPath, 'version: "3.0.0"\nquality:\n  max_direct_relations: 10\n');
    await updateConfigVersion(dir, '4.0.0');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('version: "4.0.0"');
    expect(content).toContain('quality:');
  });

  it('prepends version when field is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    const configPath = path.join(dir, 'yg-config.yaml');
    await writeFile(configPath, 'quality:\n  max_direct_relations: 10\n');
    await updateConfigVersion(dir, '4.0.0');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('version: "4.0.0"');
    expect(content).toContain('quality:');
  });
});

describe('runVersionUpgrade', () => {
  it('does not bump version when a migration returns bumpVersion: false', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig-')); dirsToCleanup.push(dir);
    const configPath = path.join(dir, 'yg-config.yaml');
    await writeFile(configPath, 'version: "4.0.0"\nquality:\n  max_direct_relations: 10\n');

    const migrations: Migration[] = [
      {
        to: '5.0.0',
        description: 'skipped bump',
        run: async () => ({ actions: ['did something'], warnings: [], bumpVersion: false }),
      },
    ];

    const result = await runVersionUpgrade({
      yggRoot: dir,
      migrations,
    });

    expect(result.migrationActions).toContain('did something');
    // Version must NOT have been bumped (bumpVersion: false)
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('version: "4.0.0"');
    expect(content).not.toContain('5.0.0');
  });
});
