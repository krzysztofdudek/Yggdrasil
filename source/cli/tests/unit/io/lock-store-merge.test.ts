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

  it('refuses a side whose shape the reader would refuse, or that carries a key this CLI does not know, instead of dropping it', () => {
    const later = JSON.stringify({ version: 1, verdicts: {}, nodes: {}, relations: { r: 1 } });
    expect(mergeLockTexts(base, later, base).ok).toBe(false);
    const newField = JSON.stringify({ version: 1, verdicts: { a: { 'file:x': { verdict: 'approved', hash: 'h', costUsd: 1 } } }, nodes: {} });
    expect(mergeLockTexts(base, newField, base).ok).toBe(false);
    const noHash = JSON.stringify({ version: 1, verdicts: { a: { 'file:x': { verdict: 'approved' } } }, nodes: {} });
    expect(mergeLockTexts(base, base, noHash).ok).toBe(false);
    const halfLog = typesFile({ t: { log: { last_entry_datetime: 'd0' } as never } });
    expect(mergeLockTexts('', halfLog, typesFile({})).ok).toBe(false);
    expect(mergeLockTexts('', typesFile({}), base).ok).toBe(false);
  });

  it('refuses a type baseline side of any other shape: an unknown key, types not an object, an entry that is not { log? }', () => {
    const t = typesFile({});
    expect(mergeLockTexts('', JSON.stringify({ version: 1, types: {}, extra: 1 }), t)).toEqual({ ok: false, why: 'ours has keys this CLI does not know (extra)' });
    expect(mergeLockTexts('', JSON.stringify({ version: 1, types: [] }), t)).toEqual({ ok: false, why: 'ours "types" is not a JSON object' });
    expect(mergeLockTexts('', JSON.stringify({ version: 1, types: { t: { other: 1 } } }), t)).toEqual({ ok: false, why: 'ours "types.t" is not { log? }' });
    expect(mergeLockTexts('', JSON.stringify({ version: 1, types: { t: 'x' } }), t).ok).toBe(false);
  });

  it('keeps a type with no log baseline, and merges the rules\' remembered status like any other section', () => {
    const u = { log: { last_entry_datetime: 'du', prefix_hash: 'pu' } };
    expect(JSON.parse(merged('', typesFile({ t: {} }), typesFile({ t: {}, u })))).toEqual({ version: 1, types: { t: {}, u } });
    const withAspects = (status: string): string => serializeLock({ version: 1, verdicts: {}, nodes: {}, aspects: { r: { status } } });
    const out = merged(withAspects('advisory'), withAspects('enforced'), withAspects('advisory'));
    expect((JSON.parse(out) as LockFile).aspects).toEqual({ r: { status: 'enforced' } });
  });

  it('is independent of the direction of the merge for random lock triples (property)', () => {
    let seed = 473;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)];
    const entry = (): VerdictEntry => (rnd(3) === 0 ? { verdict: 'refused', hash: pick(['h1', 'h2']), reason: 'r' } : { verdict: 'approved', hash: pick(['h1', 'h2', 'h3']) });
    const mutate = (from: LockFile): LockFile => {
      const verdicts: LockFile['verdicts'] = JSON.parse(JSON.stringify(from.verdicts));
      const nodes: LockFile['nodes'] = JSON.parse(JSON.stringify(from.nodes));
      for (let i = rnd(5); i > 0; i--) {
        const aspect = pick(['a', 'b', 'c']);
        const unit = pick(['file:x', 'file:y', 'node:n']);
        if (rnd(4) === 0) {
          if (verdicts[aspect]) delete verdicts[aspect][unit];
          if (rnd(3) === 0) delete verdicts[aspect];
        } else {
          (verdicts[aspect] ??= {})[unit] = entry();
        }
        const node = pick(['n', 'm', 'k']);
        const r = rnd(5);
        if (r === 0) delete nodes[node];
        else if (r === 1) nodes[node] = { ...(nodes[node] ?? {}), source: pick(['s1', 's2']) };
        else if (r === 2) nodes[node] = { ...(nodes[node] ?? {}), log: { last_entry_datetime: pick(['d1', 'd2']), prefix_hash: pick(['p1', 'p2']) } };
        else if (r === 3) nodes[node] = {};
      }
      return { version: 1, verdicts, nodes };
    };
    const typesOf = (): Record<string, { log?: { last_entry_datetime: string; prefix_hash: string } }> => {
      const out: Record<string, { log?: { last_entry_datetime: string; prefix_hash: string } }> = {};
      for (const t of ['t', 'u', 'w']) {
        const r = rnd(4);
        if (r === 1) out[t] = {};
        else if (r > 1) out[t] = { log: { last_entry_datetime: pick(['d1', 'd2']), prefix_hash: pick(['p1', 'p2']) } };
      }
      return out;
    };
    for (let run = 0; run < 500; run++) {
      const b = mutate(mutate({ version: 1, verdicts: {}, nodes: {} }));
      const [bt, ot, tt] = [b, mutate(b), mutate(b)].map((l) => (rnd(6) === 0 ? '' : serializeLock(l)));
      const forward = mergeLockTexts(bt, ot, tt);
      const backward = mergeLockTexts(bt, tt, ot);
      expect(forward).toEqual(backward);
      expect(forward.ok).toBe(true);
      if (forward.ok) expect(mergeLockTexts('', forward.text, forward.text)).toEqual(forward);
      const [tb, to, tth] = [typesOf(), typesOf(), typesOf()].map(typesFile);
      expect(mergeLockTexts(tb, to, tth)).toEqual(mergeLockTexts(tb, tth, to));
    }
  });
});
