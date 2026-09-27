import { describe, it, expect } from 'vitest';
import { mergeLockTexts, serializeLock } from '../../../src/io/lock-store.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';

const v = (hash: string): VerdictEntry => ({ verdict: 'approved', hash });
const lock = (verdicts: LockFile['verdicts'], nodes: LockFile['nodes'] = {}): string => serializeLock({ version: 1, verdicts, nodes });
const typesFile = (types: Record<string, { log?: { last_entry_datetime: string; prefix_hash: string } }>): string =>
  `${JSON.stringify({ version: 1, types }, null, 2)}\n`;

function merged(base: string, ours: string, theirs: string): string {
  const r = mergeLockTexts(base, ours, theirs);
  if (!r.ok) throw new Error(r.why);
  return r.text;
}

describe('mergeLockTexts — the yg-lock merge driver', () => {
  const base = lock({ a: { 'file:x': v('h0') } }, { n: { source: 's0', log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } } });

  it('takes the union of keys and the same bytes whichever side is ours', () => {
    const ours = lock({ a: { 'file:x': v('h0'), 'file:y': v('hy') } }, { n: { source: 's0', log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } } });
    const theirs = lock({ a: { 'file:x': v('h0') }, b: { 'file:z': v('hz') } }, { n: { source: 's0', log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } }, m: { source: 'sm' } });
    const out = merged(base, ours, theirs);
    expect(out).toBe(merged(base, theirs, ours));
    expect(out).toBe(lock({ a: { 'file:x': v('h0'), 'file:y': v('hy') }, b: { 'file:z': v('hz') } }, { m: { source: 'sm' }, n: { source: 's0', log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } } }));
  });

  it('drops a key both sides changed to different values, so the pair reads as unverified', () => {
    const ours = lock({ a: { 'file:x': v('h1') } }, { n: { source: 's1', log: { last_entry_datetime: 'd1', prefix_hash: 'p1' } } });
    const theirs = lock({ a: { 'file:x': v('h2') } }, { n: { source: 's2', log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } } });
    const out = merged(base, ours, theirs);
    expect(out).toBe(merged(base, theirs, ours));
    const doc = JSON.parse(out) as LockFile;
    expect(doc.verdicts.a).toEqual({});
    expect(doc.nodes.n).toEqual({ log: { last_entry_datetime: 'd1', prefix_hash: 'p1' } });
  });

  it('takes the one side that changed a key, a deletion included', () => {
    const ours = lock({ a: { 'file:x': v('h1') } }, {});
    const theirs = base;
    const doc = JSON.parse(merged(base, ours, theirs)) as LockFile;
    expect(doc.verdicts.a['file:x'].hash).toBe('h1');
    expect(doc.nodes).toEqual({});
  });

  it('drops a key one side deleted and the other changed', () => {
    const ours = lock({ a: {} });
    const theirs = lock({ a: { 'file:x': v('h2') } });
    expect((JSON.parse(merged(base, ours, theirs)) as LockFile).verdicts.a).toEqual({});
  });

  it('merges the type baseline file the same way, in its own layout', () => {
    const b = typesFile({ t: { log: { last_entry_datetime: 'd0', prefix_hash: 'p0' } } });
    const o = typesFile({ t: { log: { last_entry_datetime: 'd1', prefix_hash: 'p1' } }, u: { log: { last_entry_datetime: 'du', prefix_hash: 'pu' } } });
    const t = typesFile({ t: { log: { last_entry_datetime: 'd2', prefix_hash: 'p2' } } });
    const out = merged(b, o, t);
    expect(out).toBe(merged(b, t, o));
    expect(JSON.parse(out)).toEqual({ version: 1, types: { t: {}, u: { log: { last_entry_datetime: 'du', prefix_hash: 'pu' } } } });
    expect(out.split('\n')[3]).toBe('    "t": {},');
  });

  it('treats a side git hands as empty (the file absent there) as no keys', () => {
    const ours = lock({ a: { 'file:x': v('h0') } });
    expect(merged('', ours, '')).toBe(ours);
  });

  it('refuses a side that does not parse, carries markers, or has another version', () => {
    expect(mergeLockTexts(base, '{', base).ok).toBe(false);
    expect(mergeLockTexts(base, `<<<<<<< ours\n${base}`, base).ok).toBe(false);
    expect(mergeLockTexts(base, JSON.stringify({ version: 2, verdicts: {}, nodes: {} }), base).ok).toBe(false);
  });
});
