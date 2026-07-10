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

  it('records judge {provider, model} on an LLM line, omits it on a deterministic line, and reads a pre-judge v1 line', () => {
    // An LLM verdict line carries the resolved judge's identity (provider + model).
    const llmEvent: VerdictEvent = {
      v: 1,
      ts: '2026-07-03T00:00:00.000Z',
      source: 'fill',
      aspectId: 'llm-aspect',
      unitKey: 'node:svc',
      kind: 'llm',
      disposition: 'approved',
      hash: 'hash-llm',
      tier: 'standard',
      promptRev: 1,
      judge: { provider: 'ollama', model: 'llama3' },
    };
    // A deterministic line never carries a judge — the concept is LLM-only.
    const detEvent: VerdictEvent = {
      v: 1,
      ts: '2026-07-03T00:00:01.000Z',
      source: 'fill',
      aspectId: 'det-aspect',
      unitKey: 'node:svc',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'hash-det',
    };

    appendVerdictEvent(tmpDir, llmEvent);
    appendVerdictEvent(tmpDir, detEvent);

    const eventsPath = path.join(tmpDir, EVENTS_FILENAME);
    const content = readFileSync(eventsPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const parsedLlm = JSON.parse(lines[0]) as VerdictEvent;
    const parsedDet = JSON.parse(lines[1]) as VerdictEvent;
    // Judge round-trips as { provider, model } on the LLM line.
    expect(parsedLlm.judge).toEqual({ provider: 'ollama', model: 'llama3' });
    // The KEY itself is absent on the deterministic line (not merely undefined).
    expect('judge' in parsedDet).toBe(false);

    // A hand-written pre-wave-2 v1 line WITHOUT judge still parses cleanly — the
    // reader (Task 8) must tolerate the absent field; the shape must accept it.
    const legacyLine =
      '{"v":1,"ts":"2026-01-01T00:00:00.000Z","source":"fill","aspectId":"old",' +
      '"unitKey":"node:svc","kind":"llm","disposition":"approved","hash":"old-hash",' +
      '"tier":"standard","promptRev":1}';
    const parsedLegacy = JSON.parse(legacyLine) as VerdictEvent;
    expect(parsedLegacy.judge).toBeUndefined();
    expect(parsedLegacy.aspectId).toBe('old');
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
