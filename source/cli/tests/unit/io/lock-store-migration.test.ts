import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLock, serializeLock } from '../../../src/io/lock-store.js';
import { LOCK_NONDET_FILE_NAME } from '../../../src/model/lock.js';

// v1/v2 verdict content lives in the committed nondeterministic file of the 5.1.0 triad,
// which readLock parses (and from which a stray v2 relation_verdicts block is dropped).
function ygRoot(json: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-lockmig-'));
  writeFileSync(path.join(dir, LOCK_NONDET_FILE_NAME), json, 'utf-8');
  return dir;
}

describe('lock-store — v1 native, v2 read leniently (relation_verdicts dropped)', () => {
  it('reads a v1 lock unchanged, preserving aspect verdicts', () => {
    const dir = ygRoot(JSON.stringify({ version: 1, verdicts: { asp: { 'node:a': { verdict: 'approved', hash: 'h' } } }, nodes: {} }));
    try {
      const lock = readLock(dir);
      expect(lock.version).toBe(1);
      expect(lock.verdicts['asp']['node:a'].verdict).toBe('approved');
      // @ts-expect-error relation_verdicts no longer exists on LockFile
      expect(lock.relation_verdicts).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads a stray v2 lock leniently: aspect verdicts survive, relation_verdicts is dropped', () => {
    const dir = ygRoot(JSON.stringify({
      version: 2,
      verdicts: { asp: { 'node:a': { verdict: 'approved', hash: 'h' } } },
      nodes: {},
      relation_verdicts: { 'node:a': { verdict: 'refused', fingerprint: 'fp', reason: 'r', evidence: {} } },
    }));
    try {
      const lock = readLock(dir);
      expect(lock.version).toBe(1); // normalized forward to the current writer version
      expect(lock.verdicts['asp']['node:a'].verdict).toBe('approved');
      // @ts-expect-error relation_verdicts is dropped, not carried
      expect(lock.relation_verdicts).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('drops an unknown top-level key — a section a later release added — and reads the rest', () => {
    const dir = ygRoot(JSON.stringify({ version: 1, verdicts: {}, nodes: {}, bogus: 1 }));
    try { expect(readLock(dir)).not.toHaveProperty('bogus'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('serializeLock emits a v1 lock with no relation_verdicts block', () => {
    const out = serializeLock({ version: 1, verdicts: {}, nodes: {} });
    expect(out).toContain('"version": 1');
    expect(out).not.toContain('relation_verdicts');
  });
});
