import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectVersion, runMigrations, type Migration, type MigrationResult } from '../../../src/core/migrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrator', () => {
  describe('detectVersion', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(__dirname, '../../fixtures/tmp-migrator');
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('reads version from yg-config.yaml', async () => {
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        'version: "2.0.0"\nname: T\nnode_types:\n  m:\n    description: x\nartifacts:\n  r.md:\n    required: always\n    description: x\n',
      );
      const version = await detectVersion(tmpDir);
      expect(version).toBe('2.0.0');
    });

    it('returns 1.4.3 when yg-config.yaml has no version', async () => {
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        'name: T\nnode_types:\n  m:\n    description: x\nartifacts:\n  r.md:\n    required: always\n    description: x\n',
      );
      const version = await detectVersion(tmpDir);
      expect(version).toBe('1.4.3');
    });

    it('returns 1.4.3 when only config.yaml exists (old format)', async () => {
      await writeFile(path.join(tmpDir, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
      const version = await detectVersion(tmpDir);
      expect(version).toBe('1.4.3');
    });

    it('returns null when no config exists', async () => {
      const version = await detectVersion(tmpDir);
      expect(version).toBeNull();
    });
  });

  describe('runMigrations', () => {
    it('runs applicable migrations in order', async () => {
      const order: string[] = [];
      const migrations: Migration[] = [
        {
          to: '2.0.0',
          description: 'Migrate to 2.0.0',
          run: async () => { order.push('2.0.0'); return { actions: ['did 2.0'], warnings: [] }; },
        },
        {
          to: '3.0.0',
          description: 'Migrate to 3.0.0',
          run: async () => { order.push('3.0.0'); return { actions: ['did 3.0'], warnings: [] }; },
        },
      ];
      const results = await runMigrations('1.4.3', migrations, '');
      expect(order).toEqual(['2.0.0', '3.0.0']);
      expect(results).toHaveLength(2);
      expect(results[0].actions).toEqual(['did 2.0']);
      expect(results[1].actions).toEqual(['did 3.0']);
    });

    it('runs multiple migrations sequentially', async () => {
      const order: string[] = [];
      const migrations: Migration[] = [
        { to: '2.0.0', description: 'a', run: async () => { order.push('2.0.0'); return { actions: [], warnings: [] }; } },
        { to: '2.1.0', description: 'b', run: async () => { order.push('2.1.0'); return { actions: [], warnings: [] }; } },
      ];
      const results = await runMigrations('1.4.3', migrations, '');
      expect(order).toEqual(['2.0.0', '2.1.0']);
      expect(results).toHaveLength(2);
    });

    it('skips migrations below or equal to current version', async () => {
      const order: string[] = [];
      const migrations: Migration[] = [
        { to: '2.0.0', description: 'a', run: async () => { order.push('2.0.0'); return { actions: [], warnings: [] }; } },
        { to: '2.1.0', description: 'b', run: async () => { order.push('2.1.0'); return { actions: [], warnings: [] }; } },
      ];
      const results = await runMigrations('2.0.0', migrations, '');
      expect(order).toEqual(['2.1.0']);
      expect(results).toHaveLength(1);
    });

    it('returns empty when no migrations needed', async () => {
      const migrations: Migration[] = [
        { to: '2.0.0', description: 'a', run: async () => ({ actions: [], warnings: [] }) },
      ];
      const results = await runMigrations('2.0.0', migrations, '');
      expect(results).toHaveLength(0);
    });

    it('returns empty when currentVersion is not valid semver', async () => {
      const migrations: Migration[] = [
        { to: '2.0.0', description: 'a', run: async () => ({ actions: [], warnings: [] }) },
      ];
      const results = await runMigrations('not-a-version', migrations, '');
      expect(results).toHaveLength(0);
    });
  });
});
