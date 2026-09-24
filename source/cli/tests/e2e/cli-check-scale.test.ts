// =============================================================================
// CLI E2E — plain `yg check` and `yg context` do per-run work, not per-consumer.
//
// The protocol runs `yg check` after every change and `yg context` before every
// edit, so their cost is paid constantly. Both used to redo the same repository
// work many times over: every consumer inside a check (coverage, mapping
// validation, type classification, the relation pass, pairs, the suppression
// audit) re-listed each mapped directory and re-read its `.gitignore`, and
// matched every file against every mapping entry; `yg context` validated and
// enumerated the whole graph to answer about one component.
//
// Pinned by counting operations on a generated monorepo-shaped project
// (tests/support/scale-fixture.ts, tests/support/fs-op-counter.mjs):
//   - a check reads each directory's `.gitignore` at most once and lists each
//     directory a small, fixed number of times;
//   - `yg context` for one component costs about what `yg owner` costs for a
//     file in it — the lookup it shares — not a whole-graph validation.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScaleFixture } from '../support/scale-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_DIR, 'dist', 'bin.js');
const COUNTER = path.join(__dirname, '../support/fs-op-counter.mjs');
const distExists = existsSync(BIN_PATH);

type Counts = Record<string, number>;

function counted(dir: string, args: string[]): Counts {
  const counts = mkdtempSync(path.join(tmpdir(), 'yg-check-scale-counts-'));
  try {
    const r = spawnSync('node', ['--import', COUNTER, BIN_PATH, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, YG_OP_COUNT_FILE: path.join(counts, 'ops'), YG_OP_COUNT_CLI: CLI_DIR },
      timeout: 120_000,
    });
    expect(r.status === 0 || r.status === 1, `${r.stdout}\n${r.stderr}`).toBe(true);
    const total: Counts = {};
    for (const name of readdirSync(counts)) {
      const perThread = JSON.parse(readFileSync(path.join(counts, name), 'utf-8')) as Record<string, number | string>;
      for (const [k, v] of Object.entries(perThread)) {
        if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
      }
    }
    return total;
  } finally {
    rmSync(counts, { recursive: true, force: true });
  }
}

function countDirectories(root: string): number {
  let n = 0;
  const walk = (d: string): void => {
    n++;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== '.git') walk(path.join(d, e.name));
    }
  };
  walk(root);
  return n;
}

const FS_KEYS = [
  'fs.readFileSync', 'fs.statSync', 'fs.lstatSync', 'fs.readdirSync', 'fs.accessSync',
  'fsp.readFile', 'fsp.stat', 'fsp.lstat', 'fsp.readdir', 'fsp.access',
];
const sum = (c: Counts, keys: string[]): number => keys.reduce((n, k) => n + (c[k] ?? 0), 0);

describe.skipIf(!distExists)('CLI E2E — check and context scale with the run, not the consumers', () => {
  it('a plain check reads each .gitignore once and lists each directory a bounded number of times', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-scale-'));
    try {
      generateScaleFixture(dir, { nodes: 60, filesPerNode: 6, bigNodes: 1, bigNodeFiles: 120, uncoveredFiles: 40 });
      const directories = countDirectories(dir);
      counted(dir, ['check', '--no-approve']); // warm the AST cache, as an edit loop would
      const c = counted(dir, ['check', '--no-approve']);
      const gitignoreReads = (c['fsp.readFile:.gitignore'] ?? 0) + (c['fs.readFileSync:.gitignore'] ?? 0);
      const listings = (c['fsp.readdir'] ?? 0) + (c['fs.readdirSync'] ?? 0);
      const detail = `${directories} directories: ${gitignoreReads} .gitignore reads, ${listings} listings`;
      expect(gitignoreReads, detail).toBeLessThanOrEqual(directories);
      expect(listings, detail).toBeLessThanOrEqual(4 * directories);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('context for one component costs about what owner costs for a file in it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-scale-'));
    try {
      generateScaleFixture(dir, { nodes: 60, filesPerNode: 6, bigNodes: 1, bigNodeFiles: 120, uncoveredFiles: 40 });
      const owner = sum(counted(dir, ['owner', '--file', 'src/g1/m30/a/f0.ts']), FS_KEYS);
      const byFile = sum(counted(dir, ['context', '--file', 'src/g1/m30/a/f0.ts']), FS_KEYS);
      const byNode = sum(counted(dir, ['context', '--node', 'g1-m30']), FS_KEYS);
      const detail = `owner ${owner}, context --file ${byFile}, context --node ${byNode}`;
      expect(byFile, detail).toBeLessThan(1.6 * owner);
      expect(byNode, detail).toBeLessThan(1.6 * owner);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
