import { describe, it, expect } from 'vitest';
import { mergeLogTexts } from '../../../src/core/log/log-merge-driver.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';

const entry = (datetime: string, body: string): string => `## [${datetime}]\n${body}\n`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const T3 = '2026-01-04T00:00:00.000Z';

describe('mergeLogTexts — the yg-log merge driver', () => {
  it('writes the shared history, then both sides\' new entries in date order', () => {
    const base = entry(T0, 'shared');
    const ours = base + entry(T2, 'ours added');
    const theirs = base + entry(T1, 'theirs added');
    const merged = mergeLogTexts(base, ours, theirs);
    expect(merged.ok).toBe(true);
    expect(parseLog(merged.text).map((e) => e.datetime)).toEqual([T0, T1, T2]);
  });

  it('is independent of the direction of the merge', () => {
    const base = entry(T0, 'shared');
    const a = base + entry(T2, 'a');
    const b = base + entry(T1, 'b') + entry(T3, 'b again');
    expect(mergeLogTexts(base, a, b).text).toBe(mergeLogTexts(base, b, a).text);
  });

  it('takes the side that added when the other added nothing', () => {
    const base = entry(T0, 'shared');
    const theirs = base + entry(T1, 'theirs');
    expect(mergeLogTexts(base, base, theirs)).toEqual({ ok: true, text: theirs });
  });

  it('refuses with markers when a side rewrote an entry the other still holds', () => {
    const base = entry(T0, 'shared');
    const merged = mergeLogTexts(base, entry(T0, 'rewritten'), base + entry(T1, 'theirs'));
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toBe('history-rewritten');
    expect(merged.text).toMatch(/^<<<<<<< ours$/m);
    expect(merged.text).toMatch(/^>>>>>>> theirs$/m);
  });

  it('refuses when a side dropped an entry the base had', () => {
    const base = entry(T0, 'first') + entry(T1, 'second');
    const merged = mergeLogTexts(base, entry(T0, 'first'), base + entry(T2, 'theirs'));
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toBe('history-rewritten');
  });

  it('refuses when both sides superseded the same entry, keeping both sides between markers', () => {
    const base = entry(T0, 'the decision');
    const ours = base + entry(T1, `### Supersedes: ${T0}\n\nours replaces it`);
    const theirs = base + entry(T2, `### Supersedes: ${T0}\n\ntheirs replaces it`);
    const merged = mergeLogTexts(base, ours, theirs);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toBe('supersedes-conflict');
    expect(merged.detail).toContain(T0);
    expect(merged.text.startsWith(base)).toBe(true);
    expect(merged.text).toContain('ours replaces it');
    expect(merged.text).toContain('theirs replaces it');
  });

  it('does not refuse a supersession conflict one side already carried', () => {
    const conflicted = entry(T0, 'd') + entry(T1, `### Supersedes: ${T0}\n\none`) + entry(T2, `### Supersedes: ${T0}\n\ntwo`);
    const merged = mergeLogTexts(conflicted, conflicted, conflicted + entry(T3, 'unrelated'));
    expect(merged.ok).toBe(true);
  });

  it('returns identical sides unchanged', () => {
    const same = entry(T0, 'shared') + entry(T1, 'both');
    expect(mergeLogTexts(entry(T0, 'shared'), same, same)).toEqual({ ok: true, text: same });
  });

  it('refuses sides that differ before their first entry, marking the whole of both', () => {
    const ours = `intro A\n${entry(T0, 'x')}`;
    const theirs = `intro B\n${entry(T0, 'x')}`;
    const merged = mergeLogTexts('', ours, theirs);
    expect(merged.ok).toBe(false);
    expect(merged.ok ? '' : merged.reason).toBe('history-rewritten');
    expect(merged.text).toBe(`<<<<<<< ours\n${ours}=======\n${theirs}>>>>>>> theirs\n`);
  });

  it('ends each side between the markers with a newline, even a side whose last line had none', () => {
    const base = entry(T0, 'shared');
    const merged = mergeLogTexts(base, entry(T0, 'rewritten').trimEnd(), base + entry(T1, 'theirs'));
    expect(merged.ok).toBe(false);
    expect(merged.text).toMatch(/rewritten\n=======\n/);
  });

  it('refuses a side that already carries conflict markers', () => {
    const base = entry(T0, 'shared');
    const merged = mergeLogTexts(base, `${base}<<<<<<< x\n`, base + entry(T1, 't'));
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toBe('conflict-markers');
  });

  it('refuses two different entries added with one timestamp', () => {
    const base = entry(T0, 'shared');
    const merged = mergeLogTexts(base, base + entry(T1, 'ours'), base + entry(T1, 'theirs'));
    expect(merged.ok).toBe(false);
  });
});
