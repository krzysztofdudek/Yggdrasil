import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { splitLock } from '../../../src/migrations/split-lock.js';
import { readLock } from '../../../src/io/lock-store.js';
import {
  LOCK_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
  LOCK_FORMAT_VERSION,
} from '../../../src/model/lock.js';
import { FIXTURE_RM_OPTIONS } from '../../support/git-fixture.js';

/** Scaffold a .yggdrasil root with a deterministic aspect (ships check.mjs), an LLM
 *  aspect (ships content.md), and a legacy single yg-lock.json holding one verdict each
 *  plus a nodes baseline. */
function scaffold(legacyLock: unknown, gitignore?: string): string {
  const ygg = mkdtempSync(path.join(tmpdir(), 'yg-splitlock-'));
  mkdirSync(path.join(ygg, 'aspects', 'det-aspect'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'llm-aspect'), { recursive: true });
  writeFileSync(path.join(ygg, 'aspects', 'det-aspect', 'check.mjs'), 'export function check() { return []; }\n');
  writeFileSync(path.join(ygg, 'aspects', 'llm-aspect', 'content.md'), '# rule\n');
  if (legacyLock !== undefined) {
    writeFileSync(path.join(ygg, LOCK_FILE_NAME), JSON.stringify(legacyLock), 'utf-8');
  }
  if (gitignore !== undefined) writeFileSync(path.join(ygg, '.gitignore'), gitignore, 'utf-8');
  return ygg;
}

const LEGACY = {
  version: LOCK_FORMAT_VERSION,
  verdicts: {
    'det-aspect': { 'node:a': { verdict: 'approved', hash: 'hd', touched: [['read:x', 'hx']] } },
    'llm-aspect': { 'node:b': { verdict: 'approved', hash: 'hl' } },
  },
  nodes: { a: { source: 'fp-a', log: { last_entry_datetime: '2026-06-20T00:00:00.000Z', prefix_hash: 'ph' } } },
};

describe('splitLock migration step', () => {
  it('splits the legacy lock into the triad, partitioning verdicts by aspect kind', async () => {
    const ygg = scaffold(LEGACY, 'yg-secrets.yaml\n');
    try {
      const r = await splitLock(ygg);
      expect(r.actions.length).toBeGreaterThan(0);

      // Legacy single file is gone.
      expect(existsSync(path.join(ygg, LOCK_FILE_NAME))).toBe(false);

      // Deterministic verdict → gitignored cache; LLM verdict → committed nondet file.
      const det = JSON.parse(readFileSync(path.join(ygg, LOCK_DET_FILE_NAME), 'utf-8'));
      const nondet = JSON.parse(readFileSync(path.join(ygg, LOCK_NONDET_FILE_NAME), 'utf-8'));
      const logs = JSON.parse(readFileSync(path.join(ygg, LOCK_LOGS_FILE_NAME), 'utf-8'));
      expect(det.verdicts['det-aspect']).toBeDefined();
      expect(det.verdicts['llm-aspect']).toBeUndefined();
      expect(nondet.verdicts['llm-aspect']).toBeDefined();
      expect(nondet.verdicts['det-aspect']).toBeUndefined();
      expect(logs.nodes['a']).toBeDefined();

      // Verdicts preserved verbatim across the merge.
      expect(readLock(ygg)).toEqual(LEGACY);

      // The gitignored cache was added to .gitignore (existing content preserved).
      const gi = readFileSync(path.join(ygg, '.gitignore'), 'utf-8');
      expect(gi).toContain('yg-secrets.yaml');
      expect(gi.split('\n').filter((l) => l.trim() === LOCK_DET_FILE_NAME)).toHaveLength(1);
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('treats every verdict as LLM when there is no aspects/ directory (nothing classified deterministic)', async () => {
    const ygg = mkdtempSync(path.join(tmpdir(), 'yg-splitlock-noasp-'));
    writeFileSync(path.join(ygg, LOCK_FILE_NAME), JSON.stringify(LEGACY), 'utf-8');
    try {
      await splitLock(ygg);
      const nondet = JSON.parse(readFileSync(path.join(ygg, LOCK_NONDET_FILE_NAME), 'utf-8'));
      // No check.mjs anywhere → every verdict is committed-LLM; the det cache is
      // empty, so its file is not written at all (empty → no file).
      expect(nondet.verdicts['det-aspect']).toBeDefined();
      expect(nondet.verdicts['llm-aspect']).toBeDefined();
      expect(existsSync(path.join(ygg, LOCK_DET_FILE_NAME))).toBe(false);
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('appends a separating newline when .gitignore lacks a trailing one', async () => {
    const ygg = scaffold(LEGACY, 'node_modules/'); // no trailing newline
    try {
      await splitLock(ygg);
      const gi = readFileSync(path.join(ygg, '.gitignore'), 'utf-8');
      expect(gi).toBe(`node_modules/\n${LOCK_DET_FILE_NAME}\n`);
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('is a no-op when the legacy lock is absent (already split / fresh init)', async () => {
    const ygg = scaffold(undefined);
    try {
      const r = await splitLock(ygg);
      expect(r).toEqual({ actions: [], warnings: [] });
      expect(existsSync(path.join(ygg, LOCK_NONDET_FILE_NAME))).toBe(false);
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('rethrows a non-ENOENT error when the legacy lock path is unreadable (e.g. it is a directory → EISDIR)', async () => {
    const ygg = mkdtempSync(path.join(tmpdir(), 'yg-splitlock-eisdir-'));
    // Make the legacy lock path a DIRECTORY so readFileSync throws EISDIR, not ENOENT:
    // the migration must surface that, not silently treat it as "already split".
    mkdirSync(path.join(ygg, LOCK_FILE_NAME), { recursive: true });
    try {
      await expect(splitLock(ygg)).rejects.toThrow();
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('is idempotent — a second run after the split is a no-op', async () => {
    const ygg = scaffold(LEGACY);
    try {
      await splitLock(ygg);
      const second = await splitLock(ygg);
      expect(second).toEqual({ actions: [], warnings: [] });
    } finally {
      rmSync(ygg, FIXTURE_RM_OPTIONS);
    }
  });

  it('creates .gitignore with the cache entry when none exists, and does not duplicate it when already present', async () => {
    // No .gitignore at all → created with the entry.
    const a = scaffold(LEGACY);
    try {
      await splitLock(a);
      const gi = readFileSync(path.join(a, '.gitignore'), 'utf-8');
      expect(gi.split('\n').filter((l) => l.trim() === LOCK_DET_FILE_NAME)).toHaveLength(1);
    } finally {
      rmSync(a, FIXTURE_RM_OPTIONS);
    }

    // .gitignore already lists the cache → no second action for it, no duplicate.
    const b = scaffold(LEGACY, `${LOCK_DET_FILE_NAME}\n`);
    try {
      const r = await splitLock(b);
      expect(r.actions.some((x) => x.includes('.gitignore'))).toBe(false);
      const gi = readFileSync(path.join(b, '.gitignore'), 'utf-8');
      expect(gi.split('\n').filter((l) => l.trim() === LOCK_DET_FILE_NAME)).toHaveLength(1);
    } finally {
      rmSync(b, FIXTURE_RM_OPTIONS);
    }
  });
});
