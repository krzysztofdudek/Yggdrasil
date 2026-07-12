import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { EVENTS_FILENAME } from '../../../src/io/events-store.js';
import { readVerdictEvents } from '../../../src/io/events-reader.js';
import { gitFixtureEnv } from '../../support/git-fixture.js';

/**
 * Reader tolerance (read-side V1/G1 contract). The reader is telemetry: it must
 * NEVER throw. Unknown line-schema versions, unknown unit-key prefixes, and
 * non-JSON lines are counted and skipped (fail-open); a missing file yields an
 * empty result. The rotated `.1` sidecar is read BEFORE the current file so the
 * merged stream stays in chronological (append) order.
 */
describe('events-reader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-events-reader-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]): void => {
    writeFileSync(path.join(tmpDir, name), lines.join('\n') + '\n', 'utf-8');
  };

  it('accepts a valid v1 line and skips unknown v / unknown unit-prefix / non-JSON, counting each', () => {
    const valid = JSON.stringify({
      v: 1,
      ts: '2026-07-03T00:00:00.000Z',
      source: 'fill',
      aspectId: 'a',
      unitKey: 'node:cli/core/fill',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'h',
    });
    const futureVersion = JSON.stringify({
      v: 99,
      ts: '2026-07-03T00:00:01.000Z',
      source: 'fill',
      aspectId: 'a',
      unitKey: 'node:x',
      kind: 'deterministic',
      disposition: 'approved',
    });
    const garbage = 'this is not json {';
    const unknownPrefix = JSON.stringify({
      v: 1,
      ts: '2026-07-03T00:00:02.000Z',
      source: 'fill',
      aspectId: 'a',
      unitKey: 'drill:cli/core/fill',
      kind: 'deterministic',
      disposition: 'approved',
    });

    write(EVENTS_FILENAME, [valid, futureVersion, garbage, unknownPrefix]);

    const result = readVerdictEvents(tmpDir);
    expect(result.events).toHaveLength(1);
    expect(result.skipped).toBe(3);
    expect(result.events[0].unitKey).toBe('node:cli/core/fill');
    expect(result.firstTs).toBe('2026-07-03T00:00:00.000Z');
  });

  it('treats an absent v field as v1 (accepts the line)', () => {
    const legacy =
      '{"ts":"2026-01-01T00:00:00.000Z","source":"fill","aspectId":"old",' +
      '"unitKey":"node:svc","kind":"llm","disposition":"approved","hash":"old-hash"}';
    write(EVENTS_FILENAME, [legacy]);

    const result = readVerdictEvents(tmpDir);
    expect(result.events).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.events[0].aspectId).toBe('old');
  });

  it('reads the rotated .1 sidecar BEFORE the current file (chronological order)', () => {
    const older = JSON.stringify({
      v: 1,
      ts: '2026-06-01T00:00:00.000Z',
      source: 'fill',
      aspectId: 'older',
      unitKey: 'node:a',
      kind: 'deterministic',
      disposition: 'approved',
    });
    const newer = JSON.stringify({
      v: 1,
      ts: '2026-07-01T00:00:00.000Z',
      source: 'fill',
      aspectId: 'newer',
      unitKey: 'node:b',
      kind: 'deterministic',
      disposition: 'approved',
    });
    write(EVENTS_FILENAME + '.1', [older]);
    write(EVENTS_FILENAME, [newer]);

    const result = readVerdictEvents(tmpDir);
    expect(result.events.map((e) => e.aspectId)).toEqual(['older', 'newer']);
    expect(result.firstTs).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns an empty result (no throw) when the sidecar is missing', () => {
    const result = readVerdictEvents(tmpDir);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.firstTs).toBeUndefined();
    expect(result.gitTracked).toBe(false);
  });

  it('skips a valid-JSON line that is not an object (array / number / null), counting each', () => {
    write(EVENTS_FILENAME, ['42', '[1,2,3]', 'null']);
    const result = readVerdictEvents(tmpDir);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  it('reports gitTracked=true for a sidecar committed into a real git repo', () => {
    // Real on-disk git repo — no mocking. The sidecar is added and committed so
    // `git ls-files --error-unmatch` exits 0 for it.
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: tmpDir, stdio: 'ignore', env: gitFixtureEnv(tmpDir) });
    };
    git('init');
    git('config', 'user.email', 't@t.test');
    git('config', 'user.name', 'Test');
    write(EVENTS_FILENAME, [
      JSON.stringify({
        v: 1,
        ts: '2026-07-03T00:00:00.000Z',
        source: 'fill',
        aspectId: 'a',
        unitKey: 'node:x',
        kind: 'deterministic',
        disposition: 'approved',
      }),
    ]);
    git('add', EVENTS_FILENAME);
    git('commit', '-m', 'track sidecar');

    const result = readVerdictEvents(tmpDir);
    expect(result.gitTracked).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it('reports gitTracked=false for an untracked sidecar in a non-repo directory', () => {
    write(EVENTS_FILENAME, [
      JSON.stringify({
        v: 1,
        ts: '2026-07-03T00:00:00.000Z',
        source: 'fill',
        aspectId: 'a',
        unitKey: 'node:x',
        kind: 'deterministic',
        disposition: 'approved',
      }),
    ]);
    const result = readVerdictEvents(tmpDir);
    expect(result.gitTracked).toBe(false);
  });
});
