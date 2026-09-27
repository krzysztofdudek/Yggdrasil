// =============================================================================
// `yg adopt`'s undo when the undo itself fails.
//
// A failed restore cannot be produced on a real disk on demand (it takes a file
// system that refuses a rename mid-transaction), so this file stands the two
// file-system calls the transaction makes in for ones that fail on cue; every
// other call is real, against real directories in a temp location. The
// transaction must never report the repository as restored when it is not: a
// failed copy whose restore also failed throws GraphRestoreError naming where
// the previous graph is, and a rollback that failed says what it left behind.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const { GraphRestoreError, describeRestoreFailure, installGraph, resolveProposal } = await import('../../../src/cli/adopt-transaction.js');
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let root: string;
const stamp = (): Date => new Date('2026-01-02T03:04:05.678Z');

function w(rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

async function proposal(): Promise<{ root: string; graphDir: string }> {
  w('staged/.yggdrasil/yg-config.yaml', 'version: "6.0.0"\n');
  w('staged/.yggdrasil/yg-architecture.yaml', 'node_types:\n  service:\n    description: svc\n');
  return (await resolveProposal(path.join(root, 'staged')))!;
}

/** rename fails for any move OUT of a `.yggdrasil.replaced-*` directory — the move back. */
function failMoveBack(): void {
  vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
    if (path.basename(String(from)).startsWith('.yggdrasil.replaced-')) throw new Error('EBUSY: resource busy');
    return actual.rename(from, to);
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'yg-adopt-restore-'));
});

afterEach(() => {
  vi.mocked(fsp.cp).mockImplementation(actual.cp);
  vi.mocked(fsp.rename).mockImplementation(actual.rename);
  vi.mocked(fsp.rm).mockImplementation(actual.rm);
  rmSync(root, { recursive: true, force: true });
});

describe('installGraph — a copy that fails', () => {
  it('rethrows the copy error unchanged when the previous graph was put back', async () => {
    const p = await proposal();
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    vi.mocked(fsp.cp).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const thrown = await installGraph(path.join(root, 'repo'), p, stamp).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(GraphRestoreError);
    expect((thrown as Error).message).toContain('ENOSPC');
    expect(readdirSync(path.join(root, 'repo'))).toEqual(['.yggdrasil']);
    expect(existsSync(path.join(root, 'repo', '.yggdrasil', 'yg-config.yaml'))).toBe(true);
  });

  it('throws GraphRestoreError naming where the previous graph still is when it could not be moved back', async () => {
    const p = await proposal();
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    vi.mocked(fsp.cp).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    failMoveBack();
    const thrown = await installGraph(path.join(root, 'repo'), p, stamp).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(GraphRestoreError);
    const err = thrown as InstanceType<typeof GraphRestoreError>;
    expect((err.cause as Error).message).toContain('ENOSPC');
    expect(err.restore.reason).toContain('EBUSY');
    expect(err.restore.destination).toBe(path.join(root, 'repo', '.yggdrasil'));
    expect(path.basename(err.restore.preservedAt!).startsWith('.yggdrasil.replaced-')).toBe(true);
    // The previous graph was never deleted: it is intact where the error says.
    expect(existsSync(path.join(err.restore.preservedAt!, 'yg-config.yaml'))).toBe(true);
    expect(err.message).toContain('ENOSPC');
    expect(err.message).toContain('EBUSY');
  });
});

describe('InstallTransaction.rollback — an undo that fails', () => {
  it('resolves to undefined when the repository is back as it was', async () => {
    const p = await proposal();
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    const tx = await installGraph(path.join(root, 'repo'), p, stamp);
    expect(await tx.rollback()).toBeUndefined();
    expect(readdirSync(path.join(root, 'repo'))).toEqual(['.yggdrasil']);
  });

  it('resolves to what it left behind, and gives the same answer on a second call', async () => {
    const p = await proposal();
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    const tx = await installGraph(path.join(root, 'repo'), p, stamp);
    failMoveBack();
    const left = await tx.rollback();
    expect(left).toBeDefined();
    expect(left!.reason).toContain('EBUSY');
    expect(left!.preservedAt).toBe(tx.movedAsideTo);
    expect(existsSync(path.join(tx.movedAsideTo!, 'yg-config.yaml'))).toBe(true);
    expect(await tx.rollback()).toEqual(left);
  });

  it('counts the repository as restored when clearing reported an error but the previous graph moved back', async () => {
    // The clear removed the directory and still reported a failure; the move back
    // then succeeded, so the previous graph is in place. Before, this came back as
    // a failure with no preserved path, which the command worded as "this
    // repository had no graph before this run" about a repository that had one.
    const p = await proposal();
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    const tx = await installGraph(path.join(root, 'repo'), p, stamp);
    vi.mocked(fsp.rm).mockImplementationOnce(async (target, opts) => {
      await actual.rm(target, opts);
      throw new Error('EPERM: operation not permitted');
    });
    expect(await tx.rollback()).toBeUndefined();
    expect(readdirSync(path.join(root, 'repo'))).toEqual(['.yggdrasil']);
    expect(existsSync(path.join(root, 'repo', '.yggdrasil', 'yg-config.yaml'))).toBe(true);
  });
});

describe('describeRestoreFailure — the text adopt-restore-failed carries', () => {
  it('names where the previous graph is and the move back, when one was kept aside', () => {
    const repo = path.join(root, 'repo');
    const text = describeRestoreFailure(repo, {
      destination: path.join(repo, '.yggdrasil'),
      preservedAt: path.join(repo, '.yggdrasil.replaced-2026-01-02T03-04-05-678Z'),
      reason: 'EBUSY: resource busy',
    });
    expect(text.why).toBe('The graph this repository had is intact at .yggdrasil.replaced-2026-01-02T03-04-05-678Z/ but could not be moved back, so .yggdrasil/ does not hold it: the next check would run against a partial graph or none. Nothing was deleted.');
    expect(text.next).toBe('Delete .yggdrasil/ if it is there, then rename .yggdrasil.replaced-2026-01-02T03-04-05-678Z/ back to .yggdrasil/.');
  });

  it('says the repository had no graph and names the directory to delete, when none was kept aside', () => {
    const repo = path.join(root, 'repo');
    const text = describeRestoreFailure(repo, { destination: path.join(repo, '.yggdrasil'), reason: 'EPERM: operation not permitted' });
    expect(text.why).toBe('This repository had no graph before this run, and .yggdrasil/ could not be removed, so a partly copied graph may be left there and would govern the next check.');
    expect(text.next).toBe('Delete .yggdrasil/ by hand, then run yg adopt again once the cause is fixed.');
  });
});
