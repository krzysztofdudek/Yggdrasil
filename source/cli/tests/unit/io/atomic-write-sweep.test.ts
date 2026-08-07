/**
 * Tests for io/atomic-write.ts's stale-temp sweep.
 *
 * An atomic write leaves a temp beside its target between writing and renaming
 * and removes it when the write THROWS. Nothing runs when the process is killed
 * outright — an out-of-memory abort, a forced kill — so the temp survives and
 * reads as untracked noise beside the locks. The sweep clears such leftovers,
 * and every case here is about how narrowly it is scoped: it must never remove
 * a file that is not one of ours, and never one another writer might still be
 * mid-write on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { atomicWriteFile, sweepStaleTempFiles } from '../../../src/io/atomic-write.js';

let dir: string;
const HOUR_MS = 60 * 60 * 1000;
/** A fixed "now" so age comparisons never depend on the real clock. */
const NOW = 1_700_000_000_000;
const now = (): number => NOW;

/** Write a file and age it to `msOld` before NOW. */
function writeAged(name: string, msOld: number): string {
  const full = path.join(dir, name);
  writeFileSync(full, 'x');
  const seconds = (NOW - msOld) / 1000;
  utimesSync(full, seconds, seconds);
  return full;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'yg-atomic-sweep-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sweepStaleTempFiles', () => {
  it('removes a stale temp matching the writer’s own naming', async () => {
    const leftover = writeAged('.yg-lock.deterministic.json.4242-7-a1b2c3d4.tmp', 3 * HOUR_MS);
    await sweepStaleTempFiles(dir, now);
    expect(existsSync(leftover)).toBe(false);
  });

  it('leaves a RECENT temp alone — another process may still be mid-write on it', async () => {
    const inFlight = writeAged('.yg-lock.deterministic.json.99-1-deadbeef.tmp', 5 * 60 * 1000);
    await sweepStaleTempFiles(dir, now);
    expect(existsSync(inFlight)).toBe(true);
  });

  it('leaves anything that is not one of ours, however much it looks like a temp', async () => {
    // A hand-written .tmp has no pid/counter/random triple; the lock, the graph
    // and an ordinary file must obviously survive too. All aged well past the
    // cutoff, so only the NAME can be what spares them.
    const spared = [
      'notes.tmp',
      'scratch.tmp',
      '.yg-lock.deterministic.json',
      'yg-config.yaml',
      '.yg-lock.deterministic.json.tmp',
      '.yg-lock.deterministic.json.abc-1-a1b2c3d4.tmp',
      '.yg-lock.deterministic.json.12-1-nothex12.tmp',
    ].map((n) => writeAged(n, 5 * HOUR_MS));

    await sweepStaleTempFiles(dir, now);

    for (const f of spared) expect(existsSync(f)).toBe(true);
  });

  it('does not descend into subdirectories', async () => {
    const sub = path.join(dir, 'model');
    mkdirSync(sub);
    const nested = path.join(sub, 'x.json.1-1-aabbccdd.tmp');
    writeFileSync(nested, 'x');
    const seconds = (NOW - 5 * HOUR_MS) / 1000;
    utimesSync(nested, seconds, seconds);

    await sweepStaleTempFiles(dir, now);

    expect(existsSync(nested)).toBe(true);
  });

  it('leaves a DIRECTORY whose name matches the temp pattern — the sweep removes files only', async () => {
    const dirNamedLikeTemp = path.join(dir, 'out.json.77-2-a1b2c3d4.tmp');
    mkdirSync(dirNamedLikeTemp);
    const seconds = (NOW - 5 * HOUR_MS) / 1000;
    utimesSync(dirNamedLikeTemp, seconds, seconds);

    await sweepStaleTempFiles(dir, now);

    expect(existsSync(dirNamedLikeTemp)).toBe(true);
  });

  it('keeps going when one entry cannot be removed, rather than abandoning the sweep', async () => {
    // A read-only containing directory makes the unlink fail. The sweep must
    // log and move on: a leftover it cannot clear is not a reason to fail the
    // command that ran it, and it must not stop the sweep either.
    const sub = path.join(dir, 'locked');
    mkdirSync(sub);
    const stuck = path.join(sub, 'out.json.55-1-aabbccdd.tmp');
    writeFileSync(stuck, 'x');
    const seconds = (NOW - 5 * HOUR_MS) / 1000;
    utimesSync(stuck, seconds, seconds);
    chmodSync(sub, 0o500);
    try {
      await expect(sweepStaleTempFiles(sub, now)).resolves.toBeUndefined();
      expect(existsSync(stuck)).toBe(true);
    } finally {
      chmodSync(sub, 0o700);
    }
  });

  it('is silent on a directory it cannot read — a sweep must never fail the command that ran it', async () => {
    await expect(sweepStaleTempFiles(path.join(dir, 'does-not-exist'), now)).resolves.toBeUndefined();
  });

  it('leaves the directory as it was when there is nothing stale', async () => {
    writeFileSync(path.join(dir, 'keep.json'), '{}');
    const before = readdirSync(dir).sort();
    await sweepStaleTempFiles(dir, now);
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe('atomicWriteFile', () => {
  it('leaves no temp behind on a successful write', async () => {
    const target = path.join(dir, 'nested', 'out.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(readdirSync(path.dirname(target))).toEqual(['out.json']);
  });

  it('removes its own temp and rethrows when the write fails', async () => {
    // The half-written temp must not survive a failure — otherwise every failed
    // write leaves exactly the litter the sweep above exists to clean up, and
    // the target must be left untouched either way.
    const sub = path.join(dir, 'readonly');
    mkdirSync(sub);
    chmodSync(sub, 0o500);
    try {
      await expect(atomicWriteFile(path.join(sub, 'out.json'), '{}')).rejects.toThrow();
      expect(readdirSync(sub)).toEqual([]);
    } finally {
      chmodSync(sub, 0o700);
    }
  });

  it('produces a temp name the sweep recognises', async () => {
    // Pinned together so the writer's naming and the sweep's pattern cannot
    // drift apart — a drift would make the sweep silently stop finding anything.
    const target = path.join(dir, 'out.json');
    const leftover = writeAged(`out.json.${process.pid}-1-0f1e2d3c.tmp`, 5 * HOUR_MS);
    await atomicWriteFile(target, '{}');
    await sweepStaleTempFiles(dir, now);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
