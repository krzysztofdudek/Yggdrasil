/**
 * The local verdict-events sidecar rotates to `.1` once it reaches its size
 * cap, and the reader reads both generations in order. The committed LLM-fill
 * stream is sealed by month instead, and every sealed month stays readable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  appendVerdictEvent,
  COMMITTED_EVENTS_FILENAME,
  COMMITTED_EVENTS_SEGMENT_RE,
  EVENTS_FILENAME,
  EVENTS_ROTATE_BYTES,
  type VerdictEvent,
} from '../../../src/io/events-store.js';
import { readVerdictEvents } from '../../../src/io/events-reader.js';
import { appendWithRotation, readFirstLine, sealFile } from '../../../src/io/debug-log-writer.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function dir(): string { const d = mkdtempSync(path.join(tmpdir(), 'yg-evrot-')); dirs.push(d); return d; }

/** A sealed month's filename, spelled out: the name is the contract a direct reader relies on. */
const committedSegmentFilename = (month: string): string => `yg-events.llm.${month}.jsonl`;

const ev = (unit: string): VerdictEvent => ({ v: 1, ts: '2026-09-23T00:00:00.000Z', source: 'fill', aspectId: 'a', unitKey: unit, kind: 'deterministic', disposition: 'approved', hash: 'h' });

describe('events sidecar rotation', () => {
  it('rotates the sidecar to .1 at its cap and the reader returns both generations, older first', () => {
    const root = dir();
    const current = path.join(root, EVENTS_FILENAME);
    // An old generation already at the cap: one real line, padded with blank lines.
    writeFileSync(current, JSON.stringify(ev('node:old')) + '\n' + '\n'.repeat(EVENTS_ROTATE_BYTES));
    appendVerdictEvent(root, ev('node:new'));
    expect(existsSync(`${current}.1`)).toBe(true);
    expect(statSync(current).size).toBeLessThan(1000);
    const read = readVerdictEvents(root);
    expect(read.events.map((e) => e.unitKey)).toEqual(['node:old', 'node:new']);
  });

  it('appendWithRotation keeps exactly one previous generation', () => {
    const f = path.join(dir(), 'x.log');
    appendWithRotation(f, 'aaaa\n', 8);
    appendWithRotation(f, 'bbbb\n', 8);
    appendWithRotation(f, 'cccc\n', 8); // x.log hit 10 bytes → rotated
    expect(readFileSync(`${f}.1`, 'utf-8')).toBe('aaaa\nbbbb\n');
    expect(readFileSync(f, 'utf-8')).toBe('cccc\n');
    appendWithRotation(f, 'dddd\n', 8);
    appendWithRotation(f, 'eeee\n', 8);
    expect(readFileSync(`${f}.1`, 'utf-8')).toBe('cccc\ndddd\n');
    expect(readFileSync(f, 'utf-8')).toBe('eeee\n');
  });
});

describe('committed LLM-fill stream: sealed by month', () => {
  const llm = (unit: string, ts: string): VerdictEvent => ({ v: 1, ts, source: 'fill', aspectId: 'a', unitKey: unit, kind: 'llm', disposition: 'approved', hash: `h-${unit}` });
  const committed = { committedLlm: true };
  const lines = (file: string): string[] => readFileSync(file, 'utf-8').split('\n').filter((l) => l !== '');
  const committedFiles = (root: string): string[] =>
    readdirSync(root).filter((n) => n === COMMITTED_EVENTS_FILENAME || COMMITTED_EVENTS_SEGMENT_RE.test(n)).sort();

  it('keeps appending to the current file while the month does not change', () => {
    const root = dir();
    appendVerdictEvent(root, llm('node:a', '2026-09-01T00:00:00.000Z'), committed);
    appendVerdictEvent(root, llm('node:b', '2026-09-30T23:59:59.000Z'), committed);
    expect(committedFiles(root)).toEqual([COMMITTED_EVENTS_FILENAME]);
    expect(lines(path.join(root, COMMITTED_EVENTS_FILENAME))).toHaveLength(2);
  });

  it('seals the current file under the month it began in when an event of a later month arrives, and the reader still returns every event, oldest first', () => {
    const root = dir();
    appendVerdictEvent(root, llm('node:jul', '2026-07-13T00:00:00.000Z'), committed);
    appendVerdictEvent(root, llm('node:aug', '2026-08-02T00:00:00.000Z'), committed);
    appendVerdictEvent(root, llm('node:sep', '2026-09-27T00:00:00.000Z'), committed);

    expect(committedFiles(root)).toEqual([committedSegmentFilename('2026-07'), committedSegmentFilename('2026-08'), COMMITTED_EVENTS_FILENAME]);
    expect(lines(path.join(root, committedSegmentFilename('2026-07')))).toHaveLength(1);
    expect(lines(path.join(root, COMMITTED_EVENTS_FILENAME))).toHaveLength(1);

    const read = readVerdictEvents(root);
    expect(read.events.map((e) => e.unitKey)).toEqual(['node:jul', 'node:aug', 'node:sep']);
    expect(read.committedCount).toBe(3);
  });

  it('adds to a month another branch already sealed instead of replacing it, and the reader counts a line both sealed once', () => {
    const root = dir();
    const shared = JSON.stringify(llm('node:shared', '2026-08-01T00:00:00.000Z'));
    // A merge brought in the other branch's seal of August …
    writeFileSync(path.join(root, committedSegmentFilename('2026-08')), `${shared}\n${JSON.stringify(llm('node:theirs', '2026-08-03T00:00:00.000Z'))}\n`);
    // … while this branch's current file still holds August, the shared line included.
    writeFileSync(path.join(root, COMMITTED_EVENTS_FILENAME), `${shared}\n${JSON.stringify(llm('node:ours', '2026-08-04T00:00:00.000Z'))}\n`);

    appendVerdictEvent(root, llm('node:sep', '2026-09-01T00:00:00.000Z'), committed);

    expect(lines(path.join(root, committedSegmentFilename('2026-08')))).toHaveLength(4);
    const read = readVerdictEvents(root);
    expect(read.events.map((e) => e.unitKey)).toEqual(['node:shared', 'node:theirs', 'node:ours', 'node:sep']);
    expect(read.committedCount).toBe(4);
  });

  it('seals a current file whose first event is longer than a few KiB', () => {
    const root = dir();
    // The committed stream strips `reason`, so the length comes from a long unit key.
    appendVerdictEvent(root, llm(`file:${'deep/'.repeat(2000)}x.ts`, '2026-07-13T00:00:00.000Z'), committed);
    appendVerdictEvent(root, llm('node:sep', '2026-09-27T00:00:00.000Z'), committed);
    expect(committedFiles(root)).toEqual([committedSegmentFilename('2026-07'), COMMITTED_EVENTS_FILENAME]);
  });

  it('leaves a current file whose first line cannot be read as it is, rather than seal it under a guessed month', () => {
    const root = dir();
    writeFileSync(path.join(root, COMMITTED_EVENTS_FILENAME), 'not json\n');
    appendVerdictEvent(root, llm('node:a', '2026-09-01T00:00:00.000Z'), committed);
    expect(committedFiles(root)).toEqual([COMMITTED_EVENTS_FILENAME]);
    expect(lines(path.join(root, COMMITTED_EVENTS_FILENAME))).toHaveLength(2);
  });

  it('never seals the local sidecar by month', () => {
    const root = dir();
    appendVerdictEvent(root, llm('node:jul', '2026-07-13T00:00:00.000Z'));
    appendVerdictEvent(root, llm('node:sep', '2026-09-27T00:00:00.000Z'));
    expect(lines(path.join(root, EVENTS_FILENAME))).toHaveLength(2);
    expect(committedFiles(root)).toEqual([]);
  });

  it('names a sealed month by a pattern that matches only that shape', () => {
    expect(COMMITTED_EVENTS_SEGMENT_RE.test('yg-events.llm.2026-09.jsonl')).toBe(true);
    expect(COMMITTED_EVENTS_SEGMENT_RE.test(COMMITTED_EVENTS_FILENAME)).toBe(false);
    expect(COMMITTED_EVENTS_SEGMENT_RE.test('yg-events.llm.notes.jsonl')).toBe(false);
  });
});

describe('readFirstLine and sealFile', () => {
  it('readFirstLine returns the first line, and nothing for an absent, empty or unterminated file', () => {
    const d = dir();
    const f = path.join(d, 'x.log');
    expect(readFirstLine(f)).toBeUndefined();
    writeFileSync(f, '');
    expect(readFirstLine(f)).toBeUndefined();
    writeFileSync(f, 'first\nsecond\n');
    expect(readFirstLine(f)).toBe('first');
    writeFileSync(f, 'a'.repeat(50));
    expect(readFirstLine(f, 10)).toBeUndefined();
  });

  it('readFirstLine reads a first line longer than one read step, multi-byte characters across the step intact', () => {
    const f = path.join(dir(), 'x.log');
    const long = `${'ż'.repeat(3000)}${'a'.repeat(5000)}`;
    writeFileSync(f, `${long}\nsecond\n`);
    expect(readFirstLine(f)).toBe(long);
    writeFileSync(f, `${'a'.repeat(9000)}\n`);
    expect(readFirstLine(f, 8192)).toBeUndefined();
  });

  it('sealFile renames into a free name, and appends into a taken one', () => {
    const d = dir();
    const log = path.join(d, 'x.log');
    const sealed = path.join(d, 'x.sealed');
    writeFileSync(log, 'one\n');
    sealFile(log, sealed);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(sealed, 'utf-8')).toBe('one\n');
    writeFileSync(log, 'two\n');
    writeFileSync(sealed, 'one');
    sealFile(log, sealed);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(sealed, 'utf-8')).toBe('one\ntwo\n');
  });
});
