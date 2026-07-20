import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

describe('walkRepoFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rscan-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('walks all files when no gitignore', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub/c.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files.sort()).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
  });

  it('skips gitignored files', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(tmpDir, 'kept.ts'), '');
    writeFileSync(join(tmpDir, 'ignored.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('kept.ts');
    expect(files).not.toContain('ignored.ts');
  });

  it('skips .yggdrasil/ by default', async () => {
    mkdirSync(join(tmpDir, '.yggdrasil'));
    writeFileSync(join(tmpDir, '.yggdrasil/config.yaml'), '');
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('src.ts');
    expect(files.every((f) => !f.startsWith('.yggdrasil/'))).toBe(true);
  });

  it('skips the .git directory at any depth', async () => {
    mkdirSync(join(tmpDir, '.git'));
    writeFileSync(join(tmpDir, '.git/HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(tmpDir, 'sub'));
    mkdirSync(join(tmpDir, 'sub/.git'));
    writeFileSync(join(tmpDir, 'sub/.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toEqual(['src.ts']);
  });

  it('skips the .git pointer FILE (worktree / submodule form) at any depth', async () => {
    writeFileSync(join(tmpDir, '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub/.git'), 'gitdir: ../.git/modules/sub\n');
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toEqual(['src.ts']);
  });

  it('respects cascading gitignore', async () => {
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub/.gitignore'), 'local.ts\n');
    writeFileSync(join(tmpDir, 'sub/kept.ts'), '');
    writeFileSync(join(tmpDir, 'sub/local.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('sub/kept.ts');
    expect(files).not.toContain('sub/local.ts');
  });

  it('returns POSIX paths even on Windows (forward slashes)', async () => {
    mkdirSync(join(tmpDir, 'a'));
    mkdirSync(join(tmpDir, 'a', 'b'));
    writeFileSync(join(tmpDir, 'a', 'b', 'c.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('a/b/c.ts');
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
  });

  it('does not follow symlinks (skips link entirely)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const fs = await import('node:fs');
    fs.symlinkSync(join(tmpDir, 'a.ts'), join(tmpDir, 'b.ts'));
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('a.ts');
    expect(files).not.toContain('b.ts');
  });

  it('skips broken symlinks silently (no throw)', async () => {
    const fs = await import('node:fs');
    fs.symlinkSync(join(tmpDir, 'gone.ts'), join(tmpDir, 'broken.ts'));
    await expect(walkRepoFiles(tmpDir)).resolves.toBeInstanceOf(Array);
  });

  it('keeps a tracked FILE whose name collides with a directory-only pattern', async () => {
    // A directory-only pattern (`build/`) must NOT drop a same-named file.
    writeFileSync(join(tmpDir, '.gitignore'), 'build/\n');
    mkdirSync(join(tmpDir, 'scripts'));
    writeFileSync(join(tmpDir, 'scripts/build'), '#!/bin/sh\n');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('scripts/build');
  });

  it('still prunes a real directory matched by a directory-only pattern', async () => {
    // Regression guard: `build/` must still exclude an actual `build/` directory.
    writeFileSync(join(tmpDir, '.gitignore'), 'build/\n');
    mkdirSync(join(tmpDir, 'build'));
    writeFileSync(join(tmpDir, 'build/out.js'), '');
    writeFileSync(join(tmpDir, 'keep.ts'), '');
    const files = await walkRepoFiles(tmpDir);
    expect(files).toContain('keep.ts');
    expect(files).not.toContain('build/out.js');
  });
});
