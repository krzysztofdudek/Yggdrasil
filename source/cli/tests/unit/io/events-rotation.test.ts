/**
 * The local verdict-events sidecar rotates to `.1` once it reaches its size
 * cap, and the reader reads both generations in order.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { appendVerdictEvent, EVENTS_FILENAME, EVENTS_ROTATE_BYTES, type VerdictEvent } from '../../../src/io/events-store.js';
import { readVerdictEvents } from '../../../src/io/events-reader.js';
import { appendWithRotation } from '../../../src/io/debug-log-writer.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function dir(): string { const d = mkdtempSync(path.join(tmpdir(), 'yg-evrot-')); dirs.push(d); return d; }

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
