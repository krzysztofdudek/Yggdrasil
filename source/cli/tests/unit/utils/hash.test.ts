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

    it('returns empty hash for ignored file when projectRoot provided', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-hash-ignored-file');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'ignored.txt\n', 'utf-8');
      const ignoredPath = path.join(tmpDir, 'ignored.txt');
      await writeFile(ignoredPath, 'secret', 'utf-8');

      const hash = await hashPath(ignoredPath, { projectRoot: tmpDir });
      expect(hash).toBe(hashString(''));
      expect(hash).not.toBe(hashString('secret'));

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
  });
});
