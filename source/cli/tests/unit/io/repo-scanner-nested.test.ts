import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  excludeNestedGraphSubtrees,
  walkRepoFiles,
  findNestedProjectRoots,
  resetNestedProjectRootsCache,
} from '../../../src/io/repo-scanner.js';

describe('excludeNestedGraphSubtrees', () => {
  it('drops a subtree that has its own nested .yggdrasil', () => {
    const out = excludeNestedGraphSubtrees([
      'src/a.ts',
      'apps/.yggdrasil/yg-config.yaml',
      'apps/web/index.ts',
      'apps/web/util.ts',
    ]);
    expect(out).toEqual(['src/a.ts']);
  });
  it('does NOT treat the top-level .yggdrasil as a nested root', () => {
    const out = excludeNestedGraphSubtrees(['.yggdrasil/model/x/yg-node.yaml', 'src/a.ts']);
    expect(out.sort()).toEqual(['.yggdrasil/model/x/yg-node.yaml', 'src/a.ts']);
  });
  it('returns the input unchanged when no nested graphs exist', () => {
    const input = ['src/a.ts', 'lib/b.ts'];
    expect(excludeNestedGraphSubtrees(input)).toEqual(input);
  });
});

describe('walkRepoFiles nested-graph integration', () => {
  it('drops a real nested .yggdrasil subtree from the walk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-walk-nested-'));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      await mkdir(path.join(root, 'apps/web'), { recursive: true });
      await writeFile(path.join(root, 'apps/web/main.ts'), '');
      await mkdir(path.join(root, 'apps/.yggdrasil'), { recursive: true });
      await writeFile(path.join(root, 'apps/.yggdrasil/yg-config.yaml'), '');
      const files = await walkRepoFiles(root);
      expect(files).toContain('src/a.ts');
      expect(files.every((f) => !f.startsWith('apps/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// findNestedProjectRoots — an EMPTY `.yggdrasil/` directory (no file anywhere
// inside it, at any depth) draws no boundary, exactly like the top-level
// project's own empty scaffolding would not make it a "nested project" of
// itself. Only a `.yggdrasil/` that carries at least one real file is a
// separate project's graph. Pinned directly against the boundary-detection
// primitive so a regression here cannot hide behind whatever candidate list a
// particular caller's own filter happens to produce.
// ---------------------------------------------------------------------------
describe('findNestedProjectRoots — an empty .yggdrasil/ draws no boundary', () => {
  it('a completely empty .yggdrasil/ directory is absorbed, not treated as a nested project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-nested-empty-ygg-'));
    resetNestedProjectRootsCache();
    try {
      await mkdir(path.join(root, 'services'), { recursive: true });
      await writeFile(path.join(root, 'services/alpha.py'), 'def alpha(): return 1\n');
      await mkdir(path.join(root, 'services/vendorlib/.yggdrasil'), { recursive: true }); // empty — no file inside
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');

      const roots = await findNestedProjectRoots(root);
      expect(roots.has('services/vendorlib')).toBe(false);

      const files = await walkRepoFiles(root);
      expect(files.sort()).toEqual([
        'services/alpha.py',
        'services/vendorlib/other.py',
      ]);
    } finally {
      resetNestedProjectRootsCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a .yggdrasil/ containing only an empty subdirectory (still no file anywhere inside) is likewise absorbed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-nested-empty-ygg-subdir-'));
    resetNestedProjectRootsCache();
    try {
      await mkdir(path.join(root, 'services'), { recursive: true });
      await writeFile(path.join(root, 'services/alpha.py'), 'def alpha(): return 1\n');
      await mkdir(path.join(root, 'services/vendorlib/.yggdrasil/model'), { recursive: true }); // still empty

      const roots = await findNestedProjectRoots(root);
      expect(roots.has('services/vendorlib')).toBe(false);
    } finally {
      resetNestedProjectRootsCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('control: a .yggdrasil/ with a real file DOES draw the boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-nested-nonempty-ygg-'));
    resetNestedProjectRootsCache();
    try {
      await mkdir(path.join(root, 'services'), { recursive: true });
      await writeFile(path.join(root, 'services/alpha.py'), 'def alpha(): return 1\n');
      await mkdir(path.join(root, 'services/vendorlib/.yggdrasil'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/.yggdrasil/yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');

      const roots = await findNestedProjectRoots(root);
      expect(roots.has('services/vendorlib')).toBe(true);
    } finally {
      resetNestedProjectRootsCache();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// findNestedProjectRoots — the `.git` marker follows the SAME "must carry
// real content" rule `.yggdrasil` already follows (directoryHasAnyFile), in
// both of `.git`'s two forms:
//   - a `.git` DIRECTORY draws the boundary only when it contains at least
//     one file anywhere inside it — an EMPTY `.git/` directory is not a real
//     checkout (a real `git init` always populates it: HEAD, config, ...).
//   - a `.git` FILE draws the boundary only when its content actually parses
//     as the `gitdir: <path>` pointer git itself requires to recognize a
//     gitfile as a repository — git rejects anything else as an "invalid
//     gitfile format", so an empty or garbage `.git` file is not a real
//     submodule/worktree pointer.
// Without this, a stray file or directory literally named `.git` (unrelated
// to a real checkout) would silently drop a whole subtree from both the
// coverage walk and every enforcement surface — the same over-correction
// shape as an empty `.yggdrasil/` drawing a boundary it should not.
// ---------------------------------------------------------------------------
describe('findNestedProjectRoots — the .git marker requires real content, like .yggdrasil does', () => {
  async function scenario(
    plant: (root: string) => Promise<void>,
  ): Promise<Set<string>> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-nested-git-marker-'));
    resetNestedProjectRootsCache();
    try {
      await mkdir(path.join(root, 'services'), { recursive: true });
      await writeFile(path.join(root, 'services/alpha.py'), 'def alpha(): return 1\n');
      await plant(root);
      return await findNestedProjectRoots(root);
    } finally {
      resetNestedProjectRootsCache();
      await rm(root, { recursive: true, force: true });
    }
  }

  it('an EMPTY .git/ directory (no file anywhere inside) does not draw the boundary', async () => {
    const roots = await scenario(async (root) => {
      await mkdir(path.join(root, 'services/vendorlib/.git'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');
    });
    expect(roots.has('services/vendorlib')).toBe(false);
  });

  it('a .git FILE with GARBAGE content (not a gitdir: pointer) does not draw the boundary', async () => {
    const roots = await scenario(async (root) => {
      await mkdir(path.join(root, 'services/vendorlib'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/.git'), 'hello world, not a gitdir\n');
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');
    });
    expect(roots.has('services/vendorlib')).toBe(false);
  });

  it('a completely EMPTY .git FILE does not draw the boundary', async () => {
    const roots = await scenario(async (root) => {
      await mkdir(path.join(root, 'services/vendorlib'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/.git'), '');
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');
    });
    expect(roots.has('services/vendorlib')).toBe(false);
  });

  it('control: a .git directory with a real file (a real `git init` checkout) DOES draw the boundary', async () => {
    const roots = await scenario(async (root) => {
      await mkdir(path.join(root, 'services/vendorlib/.git'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/.git/HEAD'), 'ref: refs/heads/main\n');
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');
    });
    expect(roots.has('services/vendorlib')).toBe(true);
  });

  it('control: a .git FILE with a real `gitdir:` pointer (submodule/worktree) DOES draw the boundary', async () => {
    const roots = await scenario(async (root) => {
      await mkdir(path.join(root, 'services/vendorlib'), { recursive: true });
      await writeFile(path.join(root, 'services/vendorlib/.git'), 'gitdir: ../../.git/modules/vendorlib\n');
      await writeFile(path.join(root, 'services/vendorlib/other.py'), 'def other(): return 1\n');
    });
    expect(roots.has('services/vendorlib')).toBe(true);
  });
});
