import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadRootGitignoreStack,
  isIgnoredByStack,
  excludeNestedGraphSubtrees,
  walkRepoFiles,
  type GitignoreEntry,
} from '../../../src/io/repo-scanner.js';

// ===========================================================================
// Branch-coverage bounty: src/io/repo-scanner.ts — gitignore stack + walk.
//
// Every branch of the four exported functions is exercised here against REAL
// temp trees (mkdtemp under os.tmpdir()), cleaned in a finally. No random
// data, no wall-clock reads inside assertions. The repo's own files are never
// touched.
//
//   loadRootGitignoreStack  — root .gitignore present (try) / absent (catch)
//   isIgnoredByStack        — ignored / not / negation / rel==='' / rel '..'
//                             / nested stack precedence (OR-of-stack)
//   collectFiles (via walk) — local .gitignore present/absent, .git skip,
//                             top-level .yggdrasil skip, a nested `.yggdrasil`
//                             or `.git` boundary pruned proactively before the
//                             walk ever descends into it, ignored dir/file skip
//   excludeNestedGraphSubtrees — idx>0 add / idx===0 (top-level) skip /
//                             idx===-1 (no match) skip / size===0 early-return
//                             / p===root drop / startsWith(root+'/') drop / keep
//   walkRepoFiles           — full integration
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** Create a fresh temp tree root and return its absolute path. */
async function freshRoot(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `yg-gi-${label}-`));
}

/** Build an ignore stack entry from raw .gitignore content rooted at `dir`. */
async function entryFor(dir: string, content: string): Promise<GitignoreEntry> {
  // We obtain the entry via loadRootGitignoreStack so the Ignore instance is
  // built exactly the way production code builds it.
  await writeFile(path.join(dir, '.gitignore'), content, 'utf-8');
  const stack = await loadRootGitignoreStack(dir);
  // present-branch always yields exactly one entry
  return stack[0];
}

// ---------------------------------------------------------------------------
// loadRootGitignoreStack
// ---------------------------------------------------------------------------
describe('loadRootGitignoreStack', () => {
  it('TRY branch: a readable root .gitignore yields a single-entry stack rooted at projectRoot', async () => {
    const root = await freshRoot('load-present');
    try {
      await writeFile(path.join(root, '.gitignore'), '*.log\nbuild/\n', 'utf-8');
      const stack = await loadRootGitignoreStack(root);
      expect(stack).toHaveLength(1);
      expect(stack[0].dir).toBe(root);
      // The Ignore instance carries the parsed patterns.
      expect(stack[0].ig.ignores('app.log')).toBe(true);
      expect(stack[0].ig.ignores('app.ts')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CATCH branch: an absent root .gitignore yields an empty stack', async () => {
    const root = await freshRoot('load-absent');
    try {
      // No .gitignore written → readFile rejects → catch → [].
      const stack = await loadRootGitignoreStack(root);
      expect(stack).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CATCH branch: a projectRoot that does not exist also yields an empty stack', async () => {
    const stack = await loadRootGitignoreStack(
      path.join(tmpdir(), 'yg-gi-definitely-missing-dir-xyz', 'nope'),
    );
    expect(stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isIgnoredByStack
// ---------------------------------------------------------------------------
describe('isIgnoredByStack', () => {
  it('empty stack: no entries → loop body never runs → returns false', async () => {
    const root = await freshRoot('iibs-empty');
    try {
      expect(isIgnoredByStack(path.join(root, 'anything.log'), [])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('IGNORES branch: a path matched by the entry pattern returns true', async () => {
    const root = await freshRoot('iibs-hit');
    try {
      const e = await entryFor(root, '*.log\n');
      expect(isIgnoredByStack(path.join(root, 'app.log'), [e])).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NOT-IGNORED branch: a path not matched falls through the loop and returns false', async () => {
    const root = await freshRoot('iibs-miss');
    try {
      const e = await entryFor(root, '*.log\n');
      expect(isIgnoredByStack(path.join(root, 'app.ts'), [e])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NEGATION: a file re-included by a later !pattern is NOT ignored', async () => {
    const root = await freshRoot('iibs-neg');
    try {
      const e = await entryFor(root, '*.log\n!keep.log\n');
      expect(isIgnoredByStack(path.join(root, 'a.log'), [e])).toBe(true);
      expect(isIgnoredByStack(path.join(root, 'keep.log'), [e])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rel==='' branch: when absPath equals entry.dir, that entry is skipped (continue)", async () => {
    const root = await freshRoot('iibs-self');
    try {
      // An entry that ignores EVERYTHING ('*'). Querying the dir itself yields
      // rel === '' → continue → the only entry is skipped → false.
      const e = await entryFor(root, '*\n');
      expect(isIgnoredByStack(root, [e])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rel '..' branch: a path OUTSIDE entry.dir is skipped (continue), not ignored", async () => {
    const root = await freshRoot('iibs-outside');
    try {
      const sub = path.join(root, 'sub');
      await mkdir(sub, { recursive: true });
      // Entry rooted at sub, ignoring everything. A sibling path one level up
      // produces a relative path starting with '..' → continue → false.
      const e = await entryFor(sub, '*\n');
      const outsidePath = path.join(root, 'outside.txt');
      expect(isIgnoredByStack(outsidePath, [e])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NESTED stack precedence (OR): a nested entry can ADD an ignore the root does not have', async () => {
    const root = await freshRoot('iibs-nest-add');
    try {
      const sub = path.join(root, 'sub');
      await mkdir(sub, { recursive: true });
      const rootEntry = await entryFor(root, '*.log\n');
      const subEntry = await entryFor(sub, '*.tmp\n');
      const stack: GitignoreEntry[] = [rootEntry, subEntry];
      // sub/x.tmp: root doesn't ignore, sub does → true (matched by 2nd entry).
      expect(isIgnoredByStack(path.join(sub, 'x.tmp'), stack)).toBe(true);
      // sub/x.txt: neither ignores → false.
      expect(isIgnoredByStack(path.join(sub, 'x.txt'), stack)).toBe(false);
      // root/y.log: root ignores → true (matched by 1st entry, returns early).
      expect(isIgnoredByStack(path.join(root, 'y.log'), stack)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NESTED stack precedence (OR): a root-ignored file stays ignored even when a nested !negation re-includes it', async () => {
    const root = await freshRoot('iibs-nest-or');
    try {
      const sub = path.join(root, 'sub');
      await mkdir(sub, { recursive: true });
      const rootEntry = await entryFor(root, '*.tmp\n');
      const subEntry = await entryFor(sub, '!data.tmp\n');
      const stack: GitignoreEntry[] = [rootEntry, subEntry];
      // The loop returns true on the FIRST entry (root) that ignores *.tmp —
      // the nested negation never gets the chance to un-ignore it.
      expect(isIgnoredByStack(path.join(sub, 'data.tmp'), stack)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// excludeNestedGraphSubtrees (pure)
// ---------------------------------------------------------------------------
describe('excludeNestedGraphSubtrees', () => {
  it('size===0 early-return: no nested graphs → returns the SAME array reference', () => {
    const input = ['src/a.ts', 'lib/b.ts'];
    const out = excludeNestedGraphSubtrees(input);
    expect(out).toBe(input); // identity — proves the early return path
  });

  it('idx===-1 (no /.yggdrasil/ segment anywhere) keeps the path', () => {
    expect(excludeNestedGraphSubtrees(['src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('idx===0 (top-level .yggdrasil/ has no leading prefix) is NOT a nested root', () => {
    const out = excludeNestedGraphSubtrees([
      '.yggdrasil/model/x/yg-node.yaml',
      '.yggdrasil/yg-config.yaml',
      'src/a.ts',
    ]);
    expect(out.sort()).toEqual([
      '.yggdrasil/model/x/yg-node.yaml',
      '.yggdrasil/yg-config.yaml',
      'src/a.ts',
    ]);
  });

  it('idx>0: a nested .yggdrasil registers a nested root and its whole subtree is dropped', () => {
    const out = excludeNestedGraphSubtrees([
      'src/a.ts',
      'apps/.yggdrasil/yg-config.yaml',
      'apps/web/index.ts',
      'apps/web/util.ts',
    ]);
    expect(out).toEqual(['src/a.ts']);
  });

  it('filter p===root branch: the nested root dir itself is dropped', () => {
    // 'apps' is the nested root; a path that EQUALS 'apps' (no trailing slash)
    // hits the `p === root` arm of the filter.
    const out = excludeNestedGraphSubtrees([
      'apps',
      'apps/.yggdrasil/cfg.yaml',
      'top.ts',
    ]);
    expect(out).toEqual(['top.ts']);
  });

  it('filter startsWith(root+"/") branch: deep descendants of the nested root are dropped', () => {
    const out = excludeNestedGraphSubtrees([
      'apps/.yggdrasil/cfg.yaml',
      'apps/deep/very/deep/file.ts',
      'other/keep.ts',
    ]);
    expect(out).toEqual(['other/keep.ts']);
  });

  it('filter keep branch: a sibling sharing a name PREFIX with the root is NOT dropped', () => {
    // Nested root is 'apps'. 'apps-extra/...' is a different dir — it neither
    // equals 'apps' nor starts with 'apps/', so it survives the filter.
    const out = excludeNestedGraphSubtrees([
      'apps/.yggdrasil/cfg.yaml',
      'apps-extra/main.ts',
    ]);
    expect(out).toEqual(['apps-extra/main.ts']);
  });

  it('multiple nested roots are each dropped independently', () => {
    const out = excludeNestedGraphSubtrees([
      'a/.yggdrasil/c.yaml',
      'a/x.ts',
      'b/.yggdrasil/c.yaml',
      'b/y.ts',
      'keep.ts',
    ]);
    expect(out).toEqual(['keep.ts']);
  });
});

// ---------------------------------------------------------------------------
// walkRepoFiles (collectFiles integration — every directory/file branch)
// ---------------------------------------------------------------------------
describe('walkRepoFiles', () => {
  it('returns repo-relative POSIX paths for a plain tree (no .gitignore present)', async () => {
    const root = await freshRoot('walk-plain');
    try {
      await mkdir(path.join(root, 'src/inner'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      await writeFile(path.join(root, 'src/inner/b.ts'), '');
      await writeFile(path.join(root, 'top.txt'), '');
      const files = (await walkRepoFiles(root)).sort();
      expect(files).toEqual(['src/a.ts', 'src/inner/b.ts', 'top.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ROOT .gitignore present: ignored file AND ignored directory are skipped', async () => {
    const root = await freshRoot('walk-rootignore');
    try {
      await writeFile(path.join(root, '.gitignore'), '*.log\nbuild/\n', 'utf-8');
      await writeFile(path.join(root, 'keep.ts'), '');
      await writeFile(path.join(root, 'noisy.log'), '');
      await mkdir(path.join(root, 'build'), { recursive: true });
      await writeFile(path.join(root, 'build/out.js'), '');
      const files = (await walkRepoFiles(root)).sort();
      // keep.ts survives; noisy.log (file skip) and build/ (dir skip) are gone.
      expect(files).toContain('keep.ts');
      expect(files).not.toContain('noisy.log');
      expect(files.some((f) => f.startsWith('build/'))).toBe(false);
      // .gitignore itself is not ignored by these patterns, so it appears.
      expect(files).toContain('.gitignore');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('LOCAL .gitignore present (collectFiles try-branch): a nested .gitignore adds an ignore for that subtree', async () => {
    const root = await freshRoot('walk-localignore');
    try {
      await mkdir(path.join(root, 'pkg'), { recursive: true });
      // No root .gitignore (loadRootGitignoreStack → []). A LOCAL one in pkg/.
      await writeFile(path.join(root, 'pkg/.gitignore'), '*.gen.ts\n', 'utf-8');
      await writeFile(path.join(root, 'pkg/keep.ts'), '');
      await writeFile(path.join(root, 'pkg/thing.gen.ts'), '');
      await writeFile(path.join(root, 'outside.gen.ts'), '');
      const files = (await walkRepoFiles(root)).sort();
      expect(files).toContain('pkg/keep.ts');
      // The local ignore only applies within pkg/ subtree.
      expect(files).not.toContain('pkg/thing.gen.ts');
      // Same-named file OUTSIDE pkg/ is unaffected (no root ignore exists).
      expect(files).toContain('outside.gen.ts');
      expect(files).toContain('pkg/.gitignore');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('.git directory is skipped entirely', async () => {
    const root = await freshRoot('walk-git');
    try {
      await mkdir(path.join(root, '.git/objects'), { recursive: true });
      await writeFile(path.join(root, '.git/config'), '');
      await writeFile(path.join(root, '.git/objects/blob'), '');
      await writeFile(path.join(root, 'real.ts'), '');
      const files = await walkRepoFiles(root);
      expect(files).toEqual(['real.ts']);
      expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('TOP-LEVEL .yggdrasil (dir===projectRoot) is skipped at the root', async () => {
    const root = await freshRoot('walk-topygg');
    try {
      await mkdir(path.join(root, '.yggdrasil/model'), { recursive: true });
      await writeFile(path.join(root, '.yggdrasil/yg-config.yaml'), '');
      await writeFile(path.join(root, '.yggdrasil/model/x.yaml'), '');
      await writeFile(path.join(root, 'app.ts'), '');
      const files = await walkRepoFiles(root);
      expect(files).toEqual(['app.ts']);
      expect(files.some((f) => f.startsWith('.yggdrasil/'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NESTED .yggdrasil (dir!==projectRoot) is pruned proactively — the whole subtree is never even walked in', async () => {
    // The boundary is read off the filesystem before the walk starts
    // (findNestedProjectRoots), so collectFiles skips the whole apps/ subtree
    // the moment it reaches that directory — it never descends into it at all.
    const root = await freshRoot('walk-nestygg');
    try {
      await mkdir(path.join(root, 'apps/web'), { recursive: true });
      await mkdir(path.join(root, 'apps/.yggdrasil'), { recursive: true });
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'apps/.yggdrasil/yg-config.yaml'), '');
      await writeFile(path.join(root, 'apps/web/main.ts'), '');
      await writeFile(path.join(root, 'src/a.ts'), '');
      const files = await walkRepoFiles(root);
      expect(files).toContain('src/a.ts');
      // The whole apps/ subtree (which contained the nested graph) is dropped.
      expect(files.every((f) => !f.startsWith('apps/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a nested, fully independent git repository (`.git` is a directory) is pruned the same way', async () => {
    const root = await freshRoot('walk-nestgit');
    try {
      await mkdir(path.join(root, 'apps/sub/.git'), { recursive: true });
      await writeFile(path.join(root, 'apps/sub/.git/HEAD'), 'ref: refs/heads/main\n');
      await writeFile(path.join(root, 'apps/sub/lib.ts'), '');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      const files = await walkRepoFiles(root);
      expect(files).toContain('src/a.ts');
      expect(files.every((f) => !f.startsWith('apps/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a `.gitignore` line hiding ONLY the nested `.yggdrasil/` marker does not un-nest the subtree — the boundary is read off disk, not the walk\'s own candidate list', async () => {
    // If nested-root detection were derived from what the walk itself turns
    // up (the OLD, list-derived shape), hiding just the marker directory from
    // git would make the walk blind to the nested project — its ordinary
    // (non-gitignored) sibling files would then leak into the coverage count.
    const root = await freshRoot('walk-nestygg-gitignored-marker');
    try {
      await mkdir(path.join(root, 'apps/vendorlib/.yggdrasil'), { recursive: true });
      await writeFile(path.join(root, 'apps/vendorlib/.yggdrasil/yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(root, 'apps/vendorlib/other.ts'), '');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      await writeFile(path.join(root, '.gitignore'), 'apps/vendorlib/.yggdrasil/\n');
      const files = await walkRepoFiles(root);
      expect(files).toContain('src/a.ts');
      // Neither the marker NOR its now-un-nested sibling leaks through.
      expect(files.every((f) => !f.startsWith('apps/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an empty directory contributes nothing (no entries to push)', async () => {
    const root = await freshRoot('walk-empty');
    try {
      await mkdir(path.join(root, 'empty'), { recursive: true });
      await writeFile(path.join(root, 'lone.ts'), '');
      const files = await walkRepoFiles(root);
      expect(files).toEqual(['lone.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a deeply nested ignored directory is pruned at the right level', async () => {
    const root = await freshRoot('walk-deepignore');
    try {
      await writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf-8');
      await mkdir(path.join(root, 'pkg/node_modules/dep'), { recursive: true });
      await writeFile(path.join(root, 'pkg/node_modules/dep/index.js'), '');
      await writeFile(path.join(root, 'pkg/real.ts'), '');
      const files = (await walkRepoFiles(root)).sort();
      expect(files).toContain('pkg/real.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E — the gitignore stack is reachable via `yg type-suggest --file`, which
// calls loadRootGitignoreStack + isIgnoredByStack and warns when a file is
// gitignored. We spawn the real binary against a copy of the e2e-lifecycle
// fixture with an injected .gitignore and assert the observed behavior.
// ---------------------------------------------------------------------------
function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gi-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('E2E — gitignore stack reachable via the CLI', () => {
  it('type-suggest warns when the target file is matched by root .gitignore (isIgnoredByStack=true path)', () => {
    const dir = copyFixture('ignored');
    try {
      // Root .gitignore ignores all of src/services/*.ts — orders.ts is gitignored.
      writeFileSync(path.join(dir, '.gitignore'), 'src/services/*.ts\n', 'utf-8');
      const { all } = run(['type-suggest', '--file', 'src/services/orders.ts'], dir);
      expect(all).toContain('matched by .gitignore');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('type-suggest does NOT warn when the target file is not gitignored (isIgnoredByStack=false path)', () => {
    const dir = copyFixture('notignored');
    try {
      // A .gitignore that does not match orders.ts.
      writeFileSync(path.join(dir, '.gitignore'), '*.log\n', 'utf-8');
      const { all } = run(['type-suggest', '--file', 'src/services/orders.ts'], dir);
      expect(all).not.toContain('matched by .gitignore');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('check passes clean on the unmodified fixture (walkRepoFiles coverage scan runs end-to-end)', () => {
    // walkRepoFiles feeds the mapping/coverage scan. A clean run proves the
    // walk surfaces every mapped source file with no spurious uncovered-file
    // or overlapping-mapping errors.
    const dir = copyFixture('walkcheck');
    try {
      const { all } = run(['check'], dir);
      expect(all).not.toContain('uncovered');
      expect(all).not.toContain('overlapping-mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
