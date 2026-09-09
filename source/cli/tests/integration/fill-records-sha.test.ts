// =============================================================================
// Integration — fill-writer records filledAt/filledSha on a real verdict, and
// carries the same commit on its telemetry line.
//
// createVerdictWriter is exercised DIRECTLY here, against a real temp
// directory and an in-memory LockFile, with `now`/`sha` injected exactly as
// the CLI boundary injects them — nothing here spawns the binary or touches
// git; the writer's OWN contract (fill-writer.ts) is what is under test, not
// the CLI's git resolution (covered by the e2e sha-filled suite) nor the read
// side (covered by verify-lock / check-json unit tests).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createVerdictWriter } from '../../src/core/fill-writer.js';
import { EVENTS_FILENAME, type VerdictEvent } from '../../src/io/events-store.js';
import type { LockFile, VerdictEntry } from '../../src/model/lock.js';
import type { Graph } from '../../src/model/graph.js';
import type { ExpectedPair } from '../../src/core/pairs.js';

function emptyLock(): LockFile {
  return { version: 1, verdicts: {}, nodes: {} };
}

function llmPair(unitKey: string, aspectId = 'aspect-one'): ExpectedPair {
  return { aspectId, kind: 'llm', unitKey: `node:${unitKey}`, nodePath: unitKey, status: 'enforced', subjectFiles: [] };
}

function detPair(unitKey: string, aspectId = 'aspect-det'): ExpectedPair {
  return { aspectId, kind: 'deterministic', unitKey: `node:${unitKey}`, nodePath: unitKey, status: 'enforced', subjectFiles: [] };
}

function approvedEntry(hash: string): VerdictEntry {
  return { verdict: 'approved', hash };
}

function readEvents(yggRootPath: string): VerdictEvent[] {
  return readFileSync(path.join(yggRootPath, EVENTS_FILENAME), 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as VerdictEvent);
}

describe('fill-writer — records filledAt/filledSha on the verdict it writes', () => {
  let tmpDir: string;
  let graph: Graph;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-fill-sha-'));
    // Only rootPath is read by createVerdictWriter (writeLock + appendVerdictEvent
    // both take it directly) — a full Graph is not needed to exercise the writer.
    graph = { rootPath: tmpDir } as unknown as Graph;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setEntry stamps filledAt from the injected clock and filledSha from the injection; emitEvent adds sha to the line', async () => {
    const lock = emptyLock();
    const writer = createVerdictWriter({
      graph,
      lock,
      now: () => Date.parse('2026-09-09T10:00:00.000Z'),
      onlyDeterministic: false,
      committedLlm: false,
      deterministicAspectIds: new Set(),
      sha: 'a'.repeat(40),
    });

    await writer.setEntry(llmPair('services/orders'), approvedEntry('h1'));
    await writer.drain();

    const entry = lock.verdicts['aspect-one']['node:services/orders'];
    expect(entry.filledAt).toBe('2026-09-09T10:00:00.000Z');
    expect(entry.filledSha).toBe('a'.repeat(40));

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].sha).toBe('a'.repeat(40));
  });

  it('a writer built with sha: undefined records filledAt but no filledSha, and a line with no sha key at all', async () => {
    const lock = emptyLock();
    const writer = createVerdictWriter({
      graph,
      lock,
      now: () => Date.parse('2026-09-09T10:00:00.000Z'),
      onlyDeterministic: false,
      committedLlm: false,
      deterministicAspectIds: new Set(),
      sha: undefined,
    });

    await writer.setEntry(llmPair('services/orders'), approvedEntry('h1'));
    await writer.drain();

    const entry = lock.verdicts['aspect-one']['node:services/orders'];
    // filledAt is a pure clock reading — it does not depend on a commit being
    // resolvable (see cli-check-json-filled e2e scenario 5: no git repository
    // still yields a filled.ts, only filled.sha is null).
    expect(entry.filledAt).toBe('2026-09-09T10:00:00.000Z');
    expect(entry.filledSha).toBeUndefined();

    const raw = readFileSync(path.join(tmpDir, EVENTS_FILENAME), 'utf-8').split('\n').filter((l) => l.length > 0)[0];
    expect('sha' in (JSON.parse(raw) as VerdictEvent)).toBe(false);
  });

  it('onlyDeterministic: true records neither filledAt nor filledSha on a deterministic entry', async () => {
    const lock = emptyLock();
    const writer = createVerdictWriter({
      graph,
      lock,
      now: () => Date.parse('2026-09-09T10:00:00.000Z'),
      onlyDeterministic: true,
      committedLlm: false,
      deterministicAspectIds: new Set(['aspect-det']),
      sha: 'a'.repeat(40),
    });

    await writer.setEntry(detPair('services/payments'), approvedEntry('h2'));
    await writer.drain();

    const entry = lock.verdicts['aspect-det']['node:services/payments'];
    expect(entry.filledAt).toBeUndefined();
    expect(entry.filledSha).toBeUndefined();
  });

  it('interruption after the first setEntry (drain never called): the first pair has the fields, the second was never entered', async () => {
    const lock = emptyLock();
    const writer = createVerdictWriter({
      graph,
      lock,
      now: () => Date.parse('2026-09-09T10:00:00.000Z'),
      onlyDeterministic: false,
      committedLlm: false,
      deterministicAspectIds: new Set(),
      sha: 'a'.repeat(40),
    });

    await writer.setEntry(llmPair('services/orders'), approvedEntry('h1'));
    // Simulated kill: the run stops here — never calls setEntry for the second
    // pair, and never calls drain(). The in-memory mutation inside setEntry
    // happens before persistLock is awaited, so this is already observable.

    expect(lock.verdicts['aspect-one']['node:services/orders'].filledAt).toBe('2026-09-09T10:00:00.000Z');
    expect(lock.verdicts['aspect-one']['node:services/payments']).toBeUndefined();
  });
});
