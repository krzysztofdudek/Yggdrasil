import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendVerdictEvent,
  EVENTS_FILENAME,
  COMMITTED_EVENTS_FILENAME,
  type VerdictEvent,
} from '../../../src/io/events-store.js';

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

  it('round-trips all three source discriminators (fill / drill / diag) as three valid JSON lines, each newline-terminated', () => {
    // The source union widened to 'fill' | 'drill' | 'diag'. Each producer's line
    // must survive a write/read cycle with its discriminator intact, and the
    // drill unitKey uses the 'drill:<aspect>/<case>' form.
    const fillEvent: VerdictEvent = {
      v: 1,
      ts: '2026-07-10T00:00:00.000Z',
      source: 'fill',
      aspectId: 'aspect-fill',
      unitKey: 'node:x',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'hash-fill',
    };
    const drillEvent: VerdictEvent = {
      v: 1,
      ts: '2026-07-10T00:00:01.000Z',
      source: 'drill',
      aspectId: 'aspect-drill',
      unitKey: 'drill:a/violates-1',
      kind: 'llm',
      disposition: 'refused',
      hash: 'hash-drill',
      reason: 'case violates the rule',
      tier: 'default',
      promptRev: 1,
    };
    const diagEvent: VerdictEvent = {
      v: 1,
      ts: '2026-07-10T00:00:02.000Z',
      source: 'diag',
      aspectId: 'aspect-diag',
      unitKey: 'file:y',
      kind: 'llm',
      disposition: 'approved',
      hash: 'hash-diag',
      tier: 'default',
      promptRev: 1,
    };

    appendVerdictEvent(tmpDir, fillEvent);
    appendVerdictEvent(tmpDir, drillEvent);
    appendVerdictEvent(tmpDir, diagEvent);

    const eventsPath = path.join(tmpDir, EVENTS_FILENAME);
    const content = readFileSync(eventsPath, 'utf-8');

    // One write() per line, O_APPEND: the file is exactly three JSON lines, each
    // terminated by a newline (so it ends with '\n' and splitting yields a trailing
    // empty segment — never a JSON payload without its own newline).
    expect(content.endsWith('\n')).toBe(true);
    const rawLines = content.split('\n');
    expect(rawLines[rawLines.length - 1]).toBe('');
    const lines = rawLines.filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);

    // Each raw line parses as JSON and its source discriminator round-trips.
    const parsed = lines.map((l) => JSON.parse(l) as VerdictEvent);
    expect(parsed.map((e) => e.source)).toEqual(['fill', 'drill', 'diag']);
    expect(parsed[0]).toEqual(fillEvent);
    expect(parsed[1]).toEqual(drillEvent);
    expect(parsed[2]).toEqual(diagEvent);
    // The drill unitKey carries the drill:<aspect>/<case> form.
    expect(parsed[1].unitKey).toBe('drill:a/violates-1');
  });

  // ── Single-home switch (RZ-14). When the committed-events opt-in is ON, an
  //    LLM verification-FILL event (source:'fill', kind:'llm') is written to the
  //    COMMITTED shared stream and NOT to the local sidecar (no double-write, no
  //    double-count). Deterministic, drill, and diag events ALWAYS stay local —
  //    preserving the keyless-CI zero-churn invariant. ────────────────────────

  const llmFill = (overrides: Partial<VerdictEvent> = {}): VerdictEvent => ({
    v: 1,
    ts: '2026-07-13T00:00:00.000Z',
    source: 'fill',
    aspectId: 'llm-aspect',
    unitKey: 'node:svc',
    kind: 'llm',
    disposition: 'approved',
    hash: 'hash-llm',
    tier: 'standard',
    promptRev: 1,
    ...overrides,
  });

  const readLines = (name: string): VerdictEvent[] => {
    const p = path.join(tmpDir, name);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as VerdictEvent);
  };

  it('committedLlm ON: an LLM-fill event lands in the COMMITTED stream and NOT the local sidecar', () => {
    appendVerdictEvent(tmpDir, llmFill(), { committedLlm: true });

    // Committed stream got exactly the one event; the local sidecar was never created.
    const committed = readLines(COMMITTED_EVENTS_FILENAME);
    expect(committed).toHaveLength(1);
    expect(committed[0].aspectId).toBe('llm-aspect');
    expect(existsSync(path.join(tmpDir, EVENTS_FILENAME))).toBe(false);
    // The two homes are distinct files (committed one is NOT dot-prefixed / gitignored).
    expect(COMMITTED_EVENTS_FILENAME).toBe('yg-events.llm.jsonl');
    expect(EVENTS_FILENAME.startsWith('.')).toBe(true);
    expect(COMMITTED_EVENTS_FILENAME.startsWith('.')).toBe(false);
  });

  it('committedLlm ON: a deterministic-fill event STAYS local (never routed to the committed stream)', () => {
    const detFill: VerdictEvent = {
      v: 1,
      ts: '2026-07-13T00:00:01.000Z',
      source: 'fill',
      aspectId: 'det-aspect',
      unitKey: 'node:svc',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'hash-det',
    };
    appendVerdictEvent(tmpDir, detFill, { committedLlm: true });

    expect(readLines(EVENTS_FILENAME)).toHaveLength(1);
    expect(existsSync(path.join(tmpDir, COMMITTED_EVENTS_FILENAME))).toBe(false);
  });

  it('committedLlm ON: a drill LLM event STAYS local (only source:fill is graduated)', () => {
    const drillLlm: VerdictEvent = {
      v: 1,
      ts: '2026-07-13T00:00:02.000Z',
      source: 'drill',
      aspectId: 'llm-aspect',
      unitKey: 'drill:a/violates-1',
      kind: 'llm',
      disposition: 'refused',
      reason: 'case violates the rule',
      tier: 'standard',
      promptRev: 1,
    };
    appendVerdictEvent(tmpDir, drillLlm, { committedLlm: true });

    expect(readLines(EVENTS_FILENAME)).toHaveLength(1);
    expect(existsSync(path.join(tmpDir, COMMITTED_EVENTS_FILENAME))).toBe(false);
  });

  it('committedLlm OFF (or absent): an LLM-fill event STAYS local (today’s behavior)', () => {
    appendVerdictEvent(tmpDir, llmFill(), { committedLlm: false });
    appendVerdictEvent(tmpDir, llmFill({ ts: '2026-07-13T00:00:03.000Z' })); // no opts at all

    expect(readLines(EVENTS_FILENAME)).toHaveLength(2);
    expect(existsSync(path.join(tmpDir, COMMITTED_EVENTS_FILENAME))).toBe(false);
  });

  it('reason-strip: the COMMITTED refusal line has NO reason; the LOCAL (key OFF) line keeps it', () => {
    const refusal = llmFill({ disposition: 'refused', reason: 'leaks src/secret.ts internals' });

    // Committed copy (key ON): reason is stripped for privacy.
    appendVerdictEvent(tmpDir, refusal, { committedLlm: true });
    const committed = readLines(COMMITTED_EVENTS_FILENAME);
    expect(committed).toHaveLength(1);
    expect('reason' in committed[0]).toBe(false);
    expect(committed[0].disposition).toBe('refused');
    // Every other field survives the strip.
    expect(committed[0].hash).toBe('hash-llm');
    expect(committed[0].aspectId).toBe('llm-aspect');

    // Local copy (key OFF): reason is retained verbatim.
    appendVerdictEvent(tmpDir, refusal, { committedLlm: false });
    const local = readLines(EVENTS_FILENAME);
    expect(local).toHaveLength(1);
    expect(local[0].reason).toBe('leaks src/secret.ts internals');
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
