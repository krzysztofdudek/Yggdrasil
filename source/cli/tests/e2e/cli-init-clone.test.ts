import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function yg(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

function git(args: string[], cwd: string): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/**
 * The first path the docs recommend: `yg init`, commit, and let a teammate (or
 * CI) clone. Git does not track empty directories, so whatever init leaves
 * empty never reaches the clone. The clone must still be a working graph.
 */
function initCommitClone(dropPlaceholders: boolean): { root: string; clone: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-init-clone-'));
  const origin = path.join(root, 'origin');
  const clone = path.join(root, 'clone');
  spawnSync('mkdir', ['-p', origin]);
  git(['init', '-q'], origin);
  const init = yg(['init', '--no-reviewer'], origin);
  expect(init.status, init.all).toBe(0);
  if (dropPlaceholders) {
    // A graph committed by an init that wrote no placeholders: the clone
    // arrives with no model/, aspects/ or flows/ at all.
    for (const d of ['model', 'aspects', 'flows']) rmSync(path.join(origin, '.yggdrasil', d, '.gitkeep'), { force: true });
  }
  git(['add', '-A'], origin);
  git(['commit', '-q', '-m', 'init'], origin);
  git(['clone', '-q', origin, clone], root);
  return { root, clone };
}

describe.skipIf(!distExists)('a fresh yg init survives commit and clone', () => {
  it('init keeps model/, aspects/ and flows/ in the clone', () => {
    const { root, clone } = initCommitClone(false);
    try {
      for (const d of ['model', 'aspects', 'flows']) {
        expect(existsSync(path.join(clone, '.yggdrasil', d)), `${d}/ missing from the clone`).toBe(true);
      }
      const check = yg(['check'], clone);
      expect(check.status, check.all).toBe(0);
      expect(check.all).not.toContain("Run 'yg init'");
      const det = yg(['check', '--approve', '--only-deterministic'], clone);
      expect(det.status, det.all).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a clone without the empty directories is an empty graph, not an uninitialized one', () => {
    const { root, clone } = initCommitClone(true);
    try {
      expect(existsSync(path.join(clone, '.yggdrasil', 'model'))).toBe(false);
      const check = yg(['check'], clone);
      expect(check.status, check.all).toBe(0);
      expect(check.all).not.toContain('No .yggdrasil/ directory found');
      const tree = yg(['tree'], clone);
      expect(tree.status, tree.all).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
