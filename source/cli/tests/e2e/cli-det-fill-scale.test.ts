// =============================================================================
// CLI E2E — the deterministic fill grows linearly with the size of a node.
//
// The keyless gate (`yg check --approve --only-deterministic`) re-fills every
// deterministic pair on a fresh checkout. A `per: file` rule has one pair per
// file of its node, and each pair used to re-walk and stat the whole node (to
// decide whether its subject was narrower than the node), read every file of
// the node, and parse every one of them in every worker. That made one node's
// fill quadratic: a 3,500-file component took half an hour for four regex
// rules.
//
// This pins the growth, not a time: the same generated project with one node
// of N files and of 2N files, the filesystem and parse operations of the whole
// fill counted (tests/support/fs-op-counter.mjs), and doubling the node must
// roughly double the work. Quadratic work quadruples it.
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

function fillOnce(files: number): Counts {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-det-scale-'));
  const counts = mkdtempSync(path.join(tmpdir(), 'yg-det-scale-counts-'));
  try {
    generateScaleFixture(dir, { nodes: 0, bigNodes: 1, bigNodeFiles: files, uncoveredFiles: 0 });
    const r = spawnSync('node', ['--import', COUNTER, BIN_PATH, 'check', '--approve', '--only-deterministic', '--quiet'], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, YG_OP_COUNT_FILE: path.join(counts, 'ops'), YG_OP_COUNT_CLI: CLI_DIR },
      timeout: 120_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const total: Counts = {};
    for (const name of readdirSync(counts)) {
      const perThread = JSON.parse(readFileSync(path.join(counts, name), 'utf-8')) as Record<string, number | string>;
      for (const [k, v] of Object.entries(perThread)) {
        if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
      }
    }
    return total;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(counts, { recursive: true, force: true });
  }
}

const sum = (c: Counts, keys: string[]): number => keys.reduce((n, k) => n + (c[k] ?? 0), 0);

describe.skipIf(!distExists)('CLI E2E — deterministic fill scale', () => {
  it('doubling a node roughly doubles the filesystem and parse work, not quadruples it', () => {
    const small = fillOnce(80);
    const large = fillOnce(160);

    const FS_KEYS = [
      'fs.readFileSync', 'fs.statSync', 'fs.lstatSync', 'fs.readdirSync', 'fs.accessSync',
      'fsp.readFile', 'fsp.stat', 'fsp.lstat', 'fsp.readdir', 'fsp.access',
    ];
    const fsRatio = sum(large, FS_KEYS) / sum(small, FS_KEYS);
    const parseRatio = (large['treesitter.parse'] ?? 0) / Math.max(1, small['treesitter.parse'] ?? 0);
    const detail = `fs ${sum(small, FS_KEYS)} -> ${sum(large, FS_KEYS)}, parses ${small['treesitter.parse'] ?? 0} -> ${large['treesitter.parse'] ?? 0}`;

    // Linear work doubles (plus a fixed start-up share, which only lowers the
    // ratio); quadratic work quadruples. 2.6 separates the two with room for noise.
    expect(fsRatio, detail).toBeLessThan(2.6);
    expect(parseRatio, detail).toBeLessThan(2.6);
    // Four rules over N files, none of which reads a tree: no rule may cause a
    // parse per file per worker. The only parses left belong to the plain
    // check's own per-file facts — one per file.
    expect(large['treesitter.parse'] ?? 0, detail).toBeLessThanOrEqual(2 * 160);
  }, 240_000);
});
