// =============================================================================
// Unit — a rule's own history: the log beside it, and its standing as part of
// that history.
//
// A component records why it is the way it is. A rule needs the same thing for
// the same reason, and its STANDING — draft enforces nothing, advisory reports
// without blocking, enforced refuses — is the most consequential thing anyone
// changes about it. These cases pin what makes that history trustworthy:
//
//  - The log is written beside the rule and nowhere else. A symlinked or
//    hard-linked file would let an append land somewhere other than where the
//    rule's history is read from, so both are refused before anything is
//    written.
//  - A standing changed by hand is noticed once and written down once. The tool
//    reads the rule's OWN log to decide whether the change is already recorded,
//    so the recording run and the run that merely reports it agree even days
//    apart.
//  - The tool never claims a change nobody made: a rule it has never seen is
//    remembered silently, because there is no "from" and nothing to narrate.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAspectLogEntry, readAspectLog, aspectLogPath } from '../../../src/core/log/aspect-log.js';
import {
  currentStatus,
  statusLine,
  driftLine,
  parseStatusEntry,
  lastRecordedStatus,
  findStatusDrift,
  recordAspectStatuses,
} from '../../../src/core/log/aspect-status.js';
import type { AspectDef, Graph } from '../../../src/model/graph.js';
import type { LockFile } from '../../../src/model/lock.js';

const ASPECT = 'billing/charge-audited';
/** A fixed clock: every timestamp below is the caller's reading, never the machine's. */
const NOW = Date.parse('2026-09-08T09:00:00.000Z');

function aspect(id: string, status?: 'draft' | 'advisory' | 'enforced'): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
  } as AspectDef;
}

function graphOf(rootPath: string, aspects: AspectDef[]): Graph {
  return { rootPath, aspects, nodes: new Map(), flows: [] } as unknown as Graph;
}

function emptyLock(): LockFile {
  return { version: 1, verdicts: {}, nodes: {} } as LockFile;
}

describe('a rule’s log, beside the rule', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-aspect-log-'));
    mkdirSync(path.join(yggRoot, 'aspects', 'billing', 'charge-audited'), { recursive: true });
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  it('keeps the log inside the rule’s own directory, in POSIX form', () => {
    expect(aspectLogPath(yggRoot, ASPECT)).toBe(
      [yggRoot, 'aspects', 'billing', 'charge-audited', 'log.md'].join('/'),
    );
  });

  it('appends entries and reads them back newest first', async () => {
    const first = await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: 'why it exists', nowMs: NOW });
    const second = await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: 'why it changed', nowMs: NOW + 1000 });
    expect(first.ok && second.ok).toBe(true);

    const read = await readAspectLog(yggRoot, ASPECT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((e) => e.body.trim())).toEqual(['why it changed', 'why it exists']);
    if (second.ok) expect(read.entries[0].datetime).toBe(second.datetime);
  });

  it('shows only the newest entries when the reader asked for a few', async () => {
    for (const [i, text] of ['oldest', 'middle', 'newest'].entries()) {
      await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: text, nowMs: NOW + i * 1000 });
    }
    const read = await readAspectLog(yggRoot, ASPECT, 2);
    expect(read.ok && read.entries.map((e) => e.body.trim())).toEqual(['newest', 'middle']);
  });

  it('reads a rule nobody has said anything about as no entries, not an error', async () => {
    // Refusing here would make the read useless exactly when a reader asks
    // "has anything ever happened to this rule?".
    await expect(readAspectLog(yggRoot, ASPECT)).resolves.toEqual({ ok: true, entries: [] });
  });

  it('refuses a log whose entry boundary is broken, rather than half-reading it', async () => {
    writeFileSync(aspectLogPath(yggRoot, ASPECT), 'a line with no entry header at all\n', 'utf-8');
    const read = await readAspectLog(yggRoot, ASPECT);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.what).toContain(`log for rule '${ASPECT}' is malformed at line`);
    expect(read.error.why).toContain('guessing where one ends');
  });

  it('refuses to append text that would destroy the entry boundary', async () => {
    const result = await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: '   ', nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('empty after trim');
  });

  it('refuses a log that is a symbolic link, so an append cannot land elsewhere', async () => {
    const elsewhere = path.join(yggRoot, 'elsewhere.md');
    writeFileSync(elsewhere, '', 'utf-8');
    symlinkSync(elsewhere, aspectLogPath(yggRoot, ASPECT));

    const result = await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: 'note', nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('is a symbolic link');
    // Nothing was written through the link.
    expect(readFileSync(elsewhere, 'utf-8')).toBe('');
  });

  it('refuses a log with a second hard link, which an atomic rename would break', async () => {
    const logPath = aspectLogPath(yggRoot, ASPECT);
    writeFileSync(logPath, '', 'utf-8');
    linkSync(logPath, path.join(yggRoot, 'second-link.md'));

    const result = await appendAspectLogEntry({ yggRootPath: yggRoot, aspectId: ASPECT, reasonText: 'note', nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('more than one hard link');
  });
});

describe('the sentence a standing change is recorded as', () => {
  it('reads as English and still says where the rule ended up', () => {
    const line = statusLine({ from: 'advisory', to: 'enforced', by: 'the maintainer', evidence: 'two quarters clean' });
    expect(line).toBe('Status: advisory → enforced, decided by the maintainer. Evidence: two quarters clean');
    expect(parseStatusEntry(line)).toEqual({ from: 'advisory', to: 'enforced' });
  });

  it('says plainly when the tool is writing down a change it merely found', () => {
    const line = driftLine('draft', 'advisory');
    expect(line).toContain('changed outside the CLI');
    expect(line).toContain('none was recorded');
    expect(parseStatusEntry(line)).toEqual({ from: 'draft', to: 'advisory' });
  });

  it('reads a standing back out of an entry that has other prose around it', () => {
    const body = ['Some context first.', '  Status: draft → enforced, decided by me. Evidence: none', 'And after.'].join('\n');
    expect(parseStatusEntry(body)).toEqual({ from: 'draft', to: 'enforced' });
  });

  it('says nothing about an entry that did not move the rule', () => {
    // That is how a reader tells "this said something else about the rule" from
    // "this moved the rule".
    expect(parseStatusEntry('We reviewed the rule and kept it as it is.')).toBeNull();
    expect(parseStatusEntry('Status: nothing changed here')).toBeNull();
    expect(parseStatusEntry('Status:  → enforced')).toBeNull();
    expect(parseStatusEntry('Status: draft → ')).toBeNull();
  });

  it('takes the newest recorded standing, because an older entry is history', () => {
    const entries = [
      { body: 'Just a note about the rule.' },
      { body: statusLine({ from: 'advisory', to: 'enforced', by: 'me', evidence: 'clean' }) },
      { body: statusLine({ from: 'draft', to: 'advisory', by: 'me', evidence: 'first pass' }) },
    ];
    expect(lastRecordedStatus(entries)).toBe('enforced');
    expect(lastRecordedStatus([{ body: 'nothing about standing' }])).toBeNull();
    expect(lastRecordedStatus([])).toBeNull();
  });

  it('treats a rule whose file names no standing as enforced', () => {
    expect(currentStatus(aspect('a'))).toBe('enforced');
    expect(currentStatus(aspect('a', 'draft'))).toBe('draft');
  });
});

describe('noticing a standing that changed behind the tool’s back', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-aspect-drift-'));
    for (const id of ['billing/charge-audited', 'billing/refund-logged']) {
      mkdirSync(path.join(yggRoot, 'aspects', ...id.split('/')), { recursive: true });
    }
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  function lockRemembering(statuses: Record<string, string>): LockFile {
    const lock = emptyLock();
    lock.aspects = Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }]));
    return lock;
  }

  it('says nothing about a rule this checkout has never seen', () => {
    // There is no "from", so there is nothing to report and nothing to act on.
    const graph = graphOf(yggRoot, [aspect(ASPECT, 'advisory')]);
    expect(findStatusDrift(graph, emptyLock())).toEqual([]);
  });

  it('reports every rule whose standing differs from what it last saw, by name', () => {
    const graph = graphOf(yggRoot, [aspect('billing/refund-logged', 'draft'), aspect(ASPECT, 'enforced')]);
    const lock = lockRemembering({ 'billing/refund-logged': 'enforced', [ASPECT]: 'advisory' });

    expect(findStatusDrift(graph, lock)).toEqual([
      { aspectId: 'billing/charge-audited', from: 'advisory', to: 'enforced' },
      { aspectId: 'billing/refund-logged', from: 'enforced', to: 'draft' },
    ]);
  });

  it('reports nothing when every remembered standing still holds', () => {
    const graph = graphOf(yggRoot, [aspect(ASPECT, 'advisory')]);
    expect(findStatusDrift(graph, lockRemembering({ [ASPECT]: 'advisory' }))).toEqual([]);
  });

  it('remembers a first sighting silently, writing nothing into the rule’s log', async () => {
    // "This rule stands at enforced" in every rule's log is noise, and noise is
    // what stops a log from being read.
    const graph = graphOf(yggRoot, [aspect(ASPECT)]);
    const lock = emptyLock();

    const result = await recordAspectStatuses(graph, lock, NOW);
    expect(result).toEqual({ changed: true, recorded: [] });
    expect(lock.aspects?.[ASPECT]).toEqual({ status: 'enforced' });
    expect(await readAspectLog(yggRoot, ASPECT)).toEqual({ ok: true, entries: [] });
  });

  it('writes a change made by hand into the rule’s own history, exactly once', async () => {
    const graph = graphOf(yggRoot, [aspect(ASPECT, 'enforced')]);
    const lock = lockRemembering({ [ASPECT]: 'advisory' });

    const first = await recordAspectStatuses(graph, lock, NOW);
    expect(first.recorded).toEqual([{ aspectId: ASPECT, from: 'advisory', to: 'enforced' }]);
    expect(lock.aspects?.[ASPECT]).toEqual({ status: 'enforced' });

    const log = await readAspectLog(yggRoot, ASPECT);
    expect(log.ok && log.entries[0].body).toContain('advisory → enforced, changed outside the CLI');

    // The memory has moved on, so a later run has nothing left to say.
    const second = await recordAspectStatuses(graph, lock, NOW + 1000);
    expect(second).toEqual({ changed: false, recorded: [] });
  });

  it('stays silent when the caller already recorded the change in the rule’s log', async () => {
    // Deciding this by reading the log — rather than by trusting a flag — is
    // what makes the two paths agree even when they run days apart.
    const graph = graphOf(yggRoot, [aspect(ASPECT, 'enforced')]);
    await appendAspectLogEntry({
      yggRootPath: yggRoot,
      aspectId: ASPECT,
      reasonText: statusLine({ from: 'advisory', to: 'enforced', by: 'the maintainer', evidence: 'two quarters clean' }),
      nowMs: NOW,
    });
    const lock = lockRemembering({ [ASPECT]: 'advisory' });

    const result = await recordAspectStatuses(graph, lock, NOW + 1000);
    expect(result).toEqual({ changed: true, recorded: [] });
    expect(lock.aspects?.[ASPECT]).toEqual({ status: 'enforced' });

    const log = await readAspectLog(yggRoot, ASPECT);
    expect(log.ok && log.entries).toHaveLength(1);
  });

  it('leaves the memory untouched when the change could not be written down', async () => {
    // Advancing it would leave the change neither recorded nor ever noticeable
    // again.
    const elsewhere = path.join(yggRoot, 'elsewhere.md');
    writeFileSync(elsewhere, '', 'utf-8');
    symlinkSync(elsewhere, aspectLogPath(yggRoot, ASPECT));

    const graph = graphOf(yggRoot, [aspect(ASPECT, 'enforced')]);
    const lock = lockRemembering({ [ASPECT]: 'advisory' });

    const result = await recordAspectStatuses(graph, lock, NOW);
    expect(result).toEqual({ changed: false, recorded: [] });
    expect(lock.aspects?.[ASPECT]).toEqual({ status: 'advisory' });
  });
});
