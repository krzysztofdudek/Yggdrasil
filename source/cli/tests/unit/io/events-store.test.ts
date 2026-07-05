import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendVerdictEvent, EVENTS_FILENAME, type VerdictEvent } from '../../../src/io/events-store.js';

describe('events-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-events-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends two events to a fresh directory as two parseable JSON lines, in order', () => {
    const first: VerdictEvent = {
      v: 1,
      ts: '2026-07-03T00:00:00.000Z',
      source: 'fill',
      aspectId: 'aspect-one',
      unitKey: 'node:cli/core/fill',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'hash-one',
    };
    const second: VerdictEvent = {
      v: 1,
      ts: '2026-07-03T00:00:01.000Z',
      source: 'fill',
      aspectId: 'aspect-two',
      unitKey: 'node:cli/core/fill',
      kind: 'llm',
      disposition: 'refused',
      hash: 'hash-two',
      reason: 'violates the rule',
      tier: 'default',
      promptRev: 1,
    };

    appendVerdictEvent(tmpDir, first);
    appendVerdictEvent(tmpDir, second);

    const eventsPath = path.join(tmpDir, EVENTS_FILENAME);
    expect(existsSync(eventsPath)).toBe(true);
    const content = readFileSync(eventsPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const parsedFirst = JSON.parse(lines[0]) as VerdictEvent;
    const parsedSecond = JSON.parse(lines[1]) as VerdictEvent;
    expect(parsedFirst).toEqual(first);
    expect(parsedSecond).toEqual(second);
  });

  it('a write to an unwritable path does NOT throw (swallowed, best-effort telemetry)', () => {
    const unwritableDir = path.join(tmpDir, 'does-not-exist', 'nested');
    const event: VerdictEvent = {
      v: 1,
      ts: '2026-07-03T00:00:00.000Z',
      source: 'fill',
      aspectId: 'aspect-one',
      unitKey: 'node:cli/core/fill',
      kind: 'deterministic',
      disposition: 'infra',
    };
    expect(() => appendVerdictEvent(unwritableDir, event)).not.toThrow();
    expect(existsSync(unwritableDir)).toBe(false);
  });
});
