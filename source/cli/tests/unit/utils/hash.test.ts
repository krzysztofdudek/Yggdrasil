import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashFile,
  hashPath,
  hashString,
  hashForMapping,
  perFileHashes,
  hashTrackedFiles,
} from '../../../src/utils/hash.js';
import type { TrackedFile } from '../../../src/core/context-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('hash', () => {
  describe('hashString', () => {
    it('returns deterministic sha256 hash (hex)', () => {
      const h1 = hashString('hello');
      const h2 = hashString('hello');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('different content produces different hash', () => {
      const h1 = hashString('hello');
      const h2 = hashString('world');
      expect(h1).not.toBe(h2);
    });
  });

  describe('hashFile', () => {
    it('returns hash of file content', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash');
      await mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, 'test.txt');
      await writeFile(filePath, 'test content', 'utf-8');

      const hash = await hashFile(filePath);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toBe(hashString('test content'));

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('hashPath', () => {
    it('returns file hash for file paths', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-path-file');
      await mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, 'file.txt');
      await writeFile(filePath, 'path content', 'utf-8');

      const pathHash = await hashPath(filePath);
      const fileHash = await hashFile(filePath);
      expect(pathHash).toBe(fileHash);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns deterministic hash for directory content', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-path-dir');
      const nestedDir = path.join(tmpDir, 'nested');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'a.txt'), 'A', 'utf-8');
      await writeFile(path.join(nestedDir, 'b.txt'), 'B', 'utf-8');

      const firstHash = await hashPath(tmpDir);
      const secondHash = await hashPath(tmpDir);
      expect(firstHash).toBe(secondHash);

      await writeFile(path.join(nestedDir, 'b.txt'), 'B changed', 'utf-8');
      const changedHash = await hashPath(tmpDir);
      expect(changedHash).not.toBe(firstHash);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('hashes project root directory when it matches projectRoot', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-root');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), '*.log\n', 'utf-8');
      await writeFile(path.join(tmpDir, 'app.ts'), 'content', 'utf-8');

      const hash = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).not.toBe(hashString(''));

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('hashes gitignored file when directly mapped (gitignore only applies to directory scans)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-ignored-file');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'ignored.txt\n', 'utf-8');
      const ignoredPath = path.join(tmpDir, 'ignored.txt');
      await writeFile(ignoredPath, 'secret', 'utf-8');

      const hash = await hashPath(ignoredPath, { projectRoot: tmpDir });
      // Mapped files are always hashed regardless of gitignore
      expect(hash).not.toBe(hashString(''));
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('handles missing .gitignore when projectRoot provided', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-no-gitignore');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'app.ts'), 'content', 'utf-8');

      const hash = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws for unsupported path type (e.g. FIFO)', async () => {
      if (process.platform === 'win32') return;
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-fifo');
      await mkdir(tmpDir, { recursive: true });
      const fifoPath = path.join(tmpDir, 'fifo');
      const { execSync } = await import('node:child_process');
      execSync(`mkfifo "${fifoPath}"`, { stdio: 'pipe' });

      await expect(hashPath(fifoPath)).rejects.toThrow('Unsupported mapping path type');

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('skips non-file non-directory entries (e.g. symlink) in directory', async () => {
      if (process.platform === 'win32') return;
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-symlink');
      const subDir = path.join(tmpDir, 'sub');
      await mkdir(subDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'a.txt'), 'A', 'utf-8');
      await writeFile(path.join(subDir, 'b.txt'), 'B', 'utf-8');
      const { symlink } = await import('node:fs/promises');
      await symlink(path.join(subDir, 'b.txt'), path.join(tmpDir, 'link.txt'));

      const hash = await hashPath(tmpDir);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('isIgnoredPath with build/ excludes build directory contents', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-dir-slash');
      const buildDir = path.join(tmpDir, 'build');
      await mkdir(buildDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'build/\n', 'utf-8');
      await writeFile(path.join(buildDir, 'out.js'), 'x', 'utf-8');
      await writeFile(path.join(tmpDir, 'keep.ts'), 'y', 'utf-8');

      const firstHash = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(path.join(buildDir, 'out.js'), 'x modified', 'utf-8');
      const secondHash = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(secondHash).toBe(firstHash);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('isIgnoredPath with dist/ excludes dist dir via relativePath+slash branch', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-dist-ignored');
      const distDir = path.join(tmpDir, 'dist');
      const srcDir = path.join(tmpDir, 'src');
      await mkdir(distDir, { recursive: true });
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'dist/\n', 'utf-8');
      await writeFile(path.join(distDir, 'bundle.js'), 'bundle', 'utf-8');
      await writeFile(path.join(srcDir, 'index.ts'), 'export {}', 'utf-8');

      const hash = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(path.join(distDir, 'bundle.js'), 'modified', 'utf-8');
      const hashAfter = await hashPath(tmpDir, { projectRoot: tmpDir });
      expect(hashAfter).toBe(hash);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('excludes .gitignore paths while hashing directories', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-path-gitignore');
      const srcDir = path.join(tmpDir, 'src');
      const ignoredDir = path.join(srcDir, 'node_modules');
      await mkdir(ignoredDir, { recursive: true });

      await writeFile(path.join(tmpDir, '.gitignore'), 'src/node_modules/\n', 'utf-8');
      await writeFile(path.join(srcDir, 'app.ts'), 'console.log("v1")', 'utf-8');
      await writeFile(path.join(ignoredDir, 'ignored.js'), 'module.exports = 1', 'utf-8');

      const firstHash = await hashPath(srcDir, { projectRoot: tmpDir });

      await writeFile(path.join(ignoredDir, 'ignored.js'), 'module.exports = 2', 'utf-8');
      const secondHash = await hashPath(srcDir, { projectRoot: tmpDir });

      expect(secondHash).toBe(firstHash);

      await writeFile(path.join(srcDir, 'app.ts'), 'console.log("v2")', 'utf-8');
      const thirdHash = await hashPath(srcDir, { projectRoot: tmpDir });

      expect(thirdHash).not.toBe(firstHash);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('hashForMapping', () => {
    it('returns hash for file mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-mapping');
      await mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, 'src', 'app.ts');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'const x = 1;', 'utf-8');

      const hash = await hashForMapping(tmpDir, { paths: ['src/app.ts'] });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      // Aggregate hash: sha256("src/app.ts:" + fileHash)
      const fileHash = hashString('const x = 1;');
      expect(hash).toBe(hashString(`src/app.ts:${fileHash}`));

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns hash for directory mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-mapping-dir');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'a.ts'), 'A', 'utf-8');
      await writeFile(path.join(tmpDir, 'b.ts'), 'B', 'utf-8');

      const hash = await hashForMapping(path.dirname(tmpDir), {
        paths: [path.basename(tmpDir)],
      });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('hashForMapping handles mixed files and directories', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-mixed');
      const subDir = path.join(tmpDir, 'subdir');
      await mkdir(subDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'file.ts'), 'file content', 'utf-8');
      await writeFile(path.join(subDir, 'nested.ts'), 'nested content', 'utf-8');

      // Map both a file and a directory
      const hash = await hashForMapping(tmpDir, {
        paths: ['file.ts', 'subdir'],
      });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns hash for files mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-mapping-files');
      const srcDir = path.join(tmpDir, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, 'a.ts'), 'A', 'utf-8');
      await writeFile(path.join(srcDir, 'b.ts'), 'B', 'utf-8');

      const hash = await hashForMapping(tmpDir, {
        paths: ['src/a.ts', 'src/b.ts'],
      });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws for invalid mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-invalid');
      await mkdir(tmpDir, { recursive: true });

      await expect(hashForMapping(tmpDir, { paths: [] })).rejects.toThrow();

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when mapping has no paths property', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-no-paths');
      await mkdir(tmpDir, { recursive: true });

      await expect(hashForMapping(tmpDir, {})).rejects.toThrow('Invalid mapping for hash: no paths');

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('perFileHashes', () => {
    it('returns per-file hashes for files mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-perfile');
      const srcDir = path.join(tmpDir, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, 'a.ts'), 'A', 'utf-8');
      await writeFile(path.join(srcDir, 'b.ts'), 'B', 'utf-8');

      const result = await perFileHashes(tmpDir, {
        paths: ['src/a.ts', 'src/b.ts'],
      });
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result[0].hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array for empty files mapping', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-perfile-empty');
      await mkdir(tmpDir, { recursive: true });

      const result = await perFileHashes(tmpDir, { paths: [] });
      expect(result).toEqual([]);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when mapping has no paths property', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-perfile-no-paths');
      await mkdir(tmpDir, { recursive: true });

      const result = await perFileHashes(tmpDir, {});
      expect(result).toEqual([]);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns per-file hashes when mapping a directory', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-perfile-dir');
      const srcDir = path.join(tmpDir, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, 'a.ts'), 'A', 'utf-8');
      await writeFile(path.join(srcDir, 'b.ts'), 'B', 'utf-8');

      // Pass just the directory name, not individual files
      const result = await perFileHashes(tmpDir, {
        paths: ['src'],
      });
      expect(result.length).toBeGreaterThan(0);
      // Files within the directory should be returned
      const paths = result.map((r) => r.path);
      expect(paths.some((p) => p.includes('a.ts'))).toBe(true);
      expect(paths.some((p) => p.includes('b.ts'))).toBe(true);
      expect(result[0].hash).toMatch(/^[a-f0-9]{64}$/);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('hashTrackedFiles', () => {
    it('hashes a single file', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-single');
      await mkdir(tmpDir, { recursive: true });
      try {
        const relPath = 'single.txt';
        await writeFile(path.join(tmpDir, relPath), 'hello world', 'utf-8');

        const trackedFiles: TrackedFile[] = [{ path: relPath, category: 'source' }];
        const { canonicalHash, fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles);

        const expectedFileHash = hashString('hello world');
        expect(fileHashes).toEqual({ [relPath]: expectedFileHash });

        // Canonical hash is sha256 of "path:hash"
        expect(canonicalHash).toBe(hashString(`${relPath}:${expectedFileHash}`));
        expect(canonicalHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('hashes multiple files with deterministic ordering', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-ordering');
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(path.join(tmpDir, 'alpha.txt'), 'alpha content', 'utf-8');
        await writeFile(path.join(tmpDir, 'beta.txt'), 'beta content', 'utf-8');

        const trackedFilesAB: TrackedFile[] = [
          { path: 'alpha.txt', category: 'source' },
          { path: 'beta.txt', category: 'graph' },
        ];
        const trackedFilesBA: TrackedFile[] = [
          { path: 'beta.txt', category: 'graph' },
          { path: 'alpha.txt', category: 'source' },
        ];

        const resultAB = await hashTrackedFiles(tmpDir, trackedFilesAB);
        const resultBA = await hashTrackedFiles(tmpDir, trackedFilesBA);

        expect(resultAB.canonicalHash).toBe(resultBA.canonicalHash);
        expect(Object.keys(resultAB.fileHashes).sort()).toEqual(['alpha.txt', 'beta.txt']);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips missing files gracefully', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-missing');
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(path.join(tmpDir, 'present.txt'), 'exists', 'utf-8');

        const trackedFiles: TrackedFile[] = [
          { path: 'present.txt', category: 'source' },
          { path: 'does-not-exist.txt', category: 'graph' },
        ];

        // Should not throw even though one file is missing
        const result = await hashTrackedFiles(tmpDir, trackedFiles);

        expect(Object.keys(result.fileHashes)).not.toContain('does-not-exist.txt');
        expect(result.fileHashes).toHaveProperty('present.txt');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles empty TrackedFile list', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-empty');
      await mkdir(tmpDir, { recursive: true });
      try {
        const { canonicalHash, fileHashes } = await hashTrackedFiles(tmpDir, []);

        expect(fileHashes).toEqual({});
        // Canonical hash of empty input: hashString('') — deterministic
        expect(canonicalHash).toBe(hashString(''));
        expect(canonicalHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('excludes root-gitignored files when expanding directory tracked files', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-gitignore');
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src', 'node_modules', 'dep'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src', 'dist'), { recursive: true });
      try {
        // Root .gitignore ignoring node_modules/ and dist/
        await writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n', 'utf-8');
        await writeFile(path.join(tmpDir, 'src', 'app.ts'), 'console.log("app")', 'utf-8');
        await writeFile(
          path.join(tmpDir, 'src', 'node_modules', 'dep', 'index.js'),
          'module.exports = 1',
          'utf-8',
        );
        await writeFile(path.join(tmpDir, 'src', 'dist', 'bundle.js'), 'bundled', 'utf-8');

        const trackedFiles: TrackedFile[] = [{ path: 'src', category: 'source' }];
        const { fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles);

        // Only app.ts should be hashed — node_modules and dist must be excluded
        const hashedPaths = Object.keys(fileHashes);
        expect(hashedPaths).toContain('src/app.ts');
        expect(hashedPaths.some((p) => p.includes('node_modules'))).toBe(false);
        expect(hashedPaths.some((p) => p.includes('dist'))).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('excludes files matched by nested .gitignore in subdirectories', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-nested-gitignore');
      await mkdir(path.join(tmpDir, 'project', 'sub'), { recursive: true });
      try {
        // Root .gitignore — does NOT ignore *.db
        await writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');
        // Nested .gitignore in project/ — ignores *.db and *.log
        await writeFile(path.join(tmpDir, 'project', '.gitignore'), '*.db\n*.log\n', 'utf-8');

        await writeFile(path.join(tmpDir, 'project', 'app.ts'), 'code', 'utf-8');
        await writeFile(path.join(tmpDir, 'project', 'data.db'), 'sqlite data', 'utf-8');
        await writeFile(path.join(tmpDir, 'project', 'sub', 'test.db'), 'more db', 'utf-8');
        await writeFile(path.join(tmpDir, 'project', 'sub', 'debug.log'), 'log data', 'utf-8');
        await writeFile(path.join(tmpDir, 'project', 'sub', 'index.ts'), 'export {}', 'utf-8');

        const trackedFiles: TrackedFile[] = [{ path: 'project', category: 'source' }];
        const { fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles);

        const hashedPaths = Object.keys(fileHashes);
        // Only .ts files should remain — *.db and *.log must be excluded by nested .gitignore
        expect(hashedPaths).toContain('project/app.ts');
        expect(hashedPaths).toContain('project/sub/index.ts');
        expect(hashedPaths.some((p) => p.endsWith('.db'))).toBe(false);
        expect(hashedPaths.some((p) => p.endsWith('.log'))).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('hashPath — nested .gitignore', () => {
    it('respects nested .gitignore patterns in subdirectories', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hashpath-nested-gi');
      await mkdir(path.join(tmpDir, 'sub'), { recursive: true });
      try {
        // Root .gitignore — no *.dat pattern
        await writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');
        // Nested .gitignore in sub/ — ignores *.dat
        await writeFile(path.join(tmpDir, 'sub', '.gitignore'), '*.dat\n', 'utf-8');

        await writeFile(path.join(tmpDir, 'keep.ts'), 'keep', 'utf-8');
        await writeFile(path.join(tmpDir, 'sub', 'keep.ts'), 'keep2', 'utf-8');
        await writeFile(path.join(tmpDir, 'sub', 'ignored.dat'), 'binary data', 'utf-8');

        const hashBefore = await hashPath(tmpDir, { projectRoot: tmpDir });

        // Changing ignored.dat should NOT change the hash
        await writeFile(path.join(tmpDir, 'sub', 'ignored.dat'), 'changed binary', 'utf-8');
        const hashAfter = await hashPath(tmpDir, { projectRoot: tmpDir });

        expect(hashAfter).toBe(hashBefore);

        // Changing keep.ts SHOULD change the hash
        await writeFile(path.join(tmpDir, 'sub', 'keep.ts'), 'modified', 'utf-8');
        const hashModified = await hashPath(tmpDir, { projectRoot: tmpDir });

        expect(hashModified).not.toBe(hashBefore);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('hashTrackedFiles — synthetic hashes and exclusions', () => {
    it('uses synthetic hash when provided in TrackedFile', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-synthetic');
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(path.join(tmpDir, 'file.txt'), 'content', 'utf-8');

        const syntheticHash = 'abc123def456abc123def456abc123def456abc123def456abc123def456';
        const trackedFiles: TrackedFile[] = [
          { path: 'synthetic-entry', category: 'graph', syntheticHash },
        ];
        const { fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles);

        expect(fileHashes['synthetic-entry']).toBe(syntheticHash);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('excludes files matching excludePrefixes', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-exclude');
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(path.join(tmpDir, 'keep.ts'), 'keep', 'utf-8');
        await writeFile(path.join(tmpDir, 'exclude-me.ts'), 'excluded', 'utf-8');

        const trackedFiles: TrackedFile[] = [
          { path: 'keep.ts', category: 'source' },
          { path: 'exclude-me.ts', category: 'source' },
        ];
        const { fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles, undefined, [
          'exclude-me.ts',
        ]);

        expect(Object.keys(fileHashes)).toContain('keep.ts');
        expect(Object.keys(fileHashes)).not.toContain('exclude-me.ts');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('excludes files in directories matching excludePrefixes', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-exclude-dir');
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await mkdir(path.join(tmpDir, 'build'), { recursive: true });
      try {
        await writeFile(path.join(tmpDir, 'src', 'app.ts'), 'app', 'utf-8');
        await writeFile(path.join(tmpDir, 'build', 'bundle.js'), 'bundle', 'utf-8');

        const trackedFiles: TrackedFile[] = [
          { path: 'src', category: 'source' },
          { path: 'build', category: 'source' },
        ];
        const { fileHashes } = await hashTrackedFiles(tmpDir, trackedFiles, undefined, [
          'build',
        ]);

        expect(Object.keys(fileHashes)).toContain('src/app.ts');
        expect(Object.keys(fileHashes).some((p) => p.startsWith('build/'))).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('respects stored file data with matching mtimes (cache hit)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-cache-hit');
      await mkdir(tmpDir, { recursive: true });
      try {
        const filePath = path.join(tmpDir, 'cache.txt');
        await writeFile(filePath, 'cached content', 'utf-8');

        // First pass: compute hashes and mtimes
        const trackedFiles: TrackedFile[] = [{ path: 'cache.txt', category: 'source' }];
        const result1 = await hashTrackedFiles(tmpDir, trackedFiles);

        // Second pass: with stored file data (should reuse hash)
        const result2 = await hashTrackedFiles(tmpDir, trackedFiles, {
          hashes: result1.fileHashes,
          mtimes: result1.fileMtimes,
        });

        expect(result2.fileHashes).toEqual(result1.fileHashes);
        expect(result2.canonicalHash).toBe(result1.canonicalHash);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('recomputes hash when mtime changes despite stored data', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-cache-miss');
      await mkdir(tmpDir, { recursive: true });
      try {
        const filePath = path.join(tmpDir, 'changed.txt');
        await writeFile(filePath, 'original content', 'utf-8');

        const trackedFiles: TrackedFile[] = [{ path: 'changed.txt', category: 'source' }];
        const result1 = await hashTrackedFiles(tmpDir, trackedFiles);

        // Modify file and wait a bit to ensure mtime changes
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(filePath, 'new content', 'utf-8');

        // Pass old stored data — should detect mtime mismatch and recompute
        const result2 = await hashTrackedFiles(tmpDir, trackedFiles, {
          hashes: result1.fileHashes,
          mtimes: result1.fileMtimes,
        });

        expect(result2.fileHashes['changed.txt']).not.toBe(result1.fileHashes['changed.txt']);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles large batch of tracked files (>256)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-htf-large-batch');
      await mkdir(tmpDir, { recursive: true });
      try {
        const trackedFiles: TrackedFile[] = [];
        // Create 300 tracked files to test batching
        for (let i = 0; i < 300; i++) {
          const fileName = `file-${String(i).padStart(4, '0')}.txt`;
          await writeFile(path.join(tmpDir, fileName), `content ${i}`, 'utf-8');
          trackedFiles.push({ path: fileName, category: 'source' });
        }

        const { fileHashes, canonicalHash } = await hashTrackedFiles(tmpDir, trackedFiles);

        expect(Object.keys(fileHashes)).toHaveLength(300);
        expect(canonicalHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
