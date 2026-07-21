import { describe, it, expect } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findYggRoot,
  normalizeMappingPaths,
  normalizeProjectRelativePath,
  toGraphPath,
} from '../../../src/io/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('paths', () => {
  describe('findYggRoot', () => {
    it('returns .yggdrasil path when it exists', async () => {
      const yggRoot = await findYggRoot(FIXTURE_PROJECT);
      expect(yggRoot).toContain('.yggdrasil');
      expect(yggRoot.endsWith('.yggdrasil')).toBe(true);
    });

    it('throws when .yggdrasil directory does not exist', async () => {
      await expect(findYggRoot('/nonexistent/path')).rejects.toThrow(
        'No .yggdrasil/ directory found',
      );
    });

    it('searches upward when .yggdrasil is in parent directory', async () => {
      const subdir = path.join(FIXTURE_PROJECT, 'src', 'modules');
      const yggRoot = await findYggRoot(subdir);
      expect(yggRoot).toContain('.yggdrasil');
      expect(yggRoot.endsWith('.yggdrasil')).toBe(true);
    });

    it('throws when .yggdrasil exists but is a file', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-ygg-file');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.yggdrasil'), 'not a directory', 'utf-8');
      try {
        await expect(findYggRoot(tmpDir)).rejects.toThrow(/\.yggdrasil.*not a directory/);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('normalizeMappingPaths', () => {
    it('returns empty array when mapping is undefined', () => {
      expect(normalizeMappingPaths(undefined)).toEqual([]);
    });

    it('returns single path for flat string array', () => {
      expect(normalizeMappingPaths(['src/module.ts'])).toEqual(['src/module.ts']);
    });

    it('returns paths for multiple elements', () => {
      expect(normalizeMappingPaths(['src/a.ts', 'src/b.ts'])).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
    });

    it('returns all paths from flat array', () => {
      expect(
        normalizeMappingPaths(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']),
      ).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    });

    it('returns empty for empty array', () => {
      expect(normalizeMappingPaths([])).toEqual([]);
    });

    it('strips a leading ./ from each entry', () => {
      expect(normalizeMappingPaths(['./src/a.ts', 'src/b.ts'])).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
    });

    it('skips a non-string entry within an otherwise-valid mapping array', () => {
      // Malformed YAML like `mapping:\n  - foo.ts\n  - 123` — a stray non-string
      // element must be skipped rather than crash the normalizer.
      expect(normalizeMappingPaths(['src/a.ts', 123 as unknown as string, 'src/b.ts'])).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
    });

    it('drops an entry that normalizes to an empty string (a blank mapping line)', () => {
      expect(normalizeMappingPaths(['src/a.ts', '', '   ', 'src/b.ts'])).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
    });

    it('returns empty array when mapping is not an array (malformed YAML: a bare string instead of a list)', () => {
      // A user who writes `mapping: foo.ts` instead of `mapping:\n  - foo.ts`
      // hands the loader a bare string at runtime, defeating the static
      // `string[]` type. The guard must fail closed to an empty mapping rather
      // than iterate the string's characters as if it were an array of paths.
      expect(normalizeMappingPaths('foo.ts' as unknown as string[])).toEqual([]);
      expect(normalizeMappingPaths({ path: 'foo.ts' } as unknown as string[])).toEqual([]);
    });
  });

  describe('toGraphPath', () => {
    it('converts absolute path to graph path', () => {
      const yggRoot = path.join(FIXTURE_PROJECT, '.yggdrasil');
      const modelDir = path.join(yggRoot, 'model');
      const absPath = path.join(modelDir, 'orders', 'order-service');
      expect(toGraphPath(absPath, modelDir)).toBe('orders/order-service');
    });

    it('handles single segment', () => {
      const yggRoot = '/proj/.yggdrasil';
      const absPath = '/proj/.yggdrasil/auth';
      expect(toGraphPath(absPath, yggRoot)).toBe('auth');
    });

    it('handles deeply nested paths', () => {
      const yggRoot = '/proj/.yggdrasil';
      const absPath = '/proj/.yggdrasil/a/b/c/d';
      expect(toGraphPath(absPath, yggRoot)).toBe('a/b/c/d');
    });
  });

  describe('normalizeProjectRelativePath', () => {
    it('normalizes relative file paths to POSIX project-relative format', () => {
      const projectRoot = '/workspace/project';
      const result = normalizeProjectRelativePath(projectRoot, 'src\\core\\validator.ts');
      expect(result).toBe('src/core/validator.ts');
    });

    it('throws when path points outside project root', () => {
      const projectRoot = '/workspace/project';
      expect(() => normalizeProjectRelativePath(projectRoot, '../secrets.txt')).toThrow(
        'outside project root',
      );
    });

    it('throws for empty input', () => {
      const projectRoot = '/workspace/project';
      expect(() => normalizeProjectRelativePath(projectRoot, '   ')).toThrow(
        'Path cannot be empty',
      );
    });
  });

  describe('getPackageRoot', () => {
    it('returns a string path', async () => {
      const { getPackageRoot } = await import('../../../src/io/paths.js');
      const root = getPackageRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });
});
