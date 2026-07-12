import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendDecision,
  readDecisions,
  ADVISE_DECISIONS_FILENAME,
  type AdviseDecision,
} from '../../../src/io/advise-decisions-store.js';

describe('advise-decisions-store', () => {
  let yggRoot: string;

  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-advise-store-'));
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  const dismiss: AdviseDecision = {
    v: 1,
    ts: '2026-07-12T00:00:00.000Z',
    id: 'overdue-review-by:legacy-rule',
    action: 'dismiss',
    evidenceHash: 'a'.repeat(64),
    reason: 'reviewed, keeping the rule for now',
  };
  const defer: AdviseDecision = {
    v: 1,
    ts: '2026-07-12T00:00:01.000Z',
    id: 'orphaned-aspect:draft-rule',
    action: 'defer',
    evidenceHash: 'b'.repeat(64),
    until: '2027-01-01',
    reason: 'revisit next quarter',
  };
  const done: AdviseDecision = {
    v: 1,
    ts: '2026-07-12T00:00:02.000Z',
    id: 'dead-attach:old-rule',
    action: 'done',
    evidenceHash: 'c'.repeat(64),
    reason: 'rule retired; closure recorded',
  };

  it('appends three decisions as three JSON lines, each newline-terminated, in order', async () => {
    await appendDecision(yggRoot, dismiss);
    await appendDecision(yggRoot, defer);
    await appendDecision(yggRoot, done);

    const p = path.join(yggRoot, ADVISE_DECISIONS_FILENAME);
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    // One write per line under O_APPEND: file is exactly three JSON lines, each
    // terminated by a newline (so it ends with '\n').
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual(dismiss);
    expect(JSON.parse(lines[1])).toEqual(defer);
    expect(JSON.parse(lines[2])).toEqual(done);
  });

  it('reads back the three decisions, tolerating an interleaved garbage line and an unknown-v line (skipped: 2)', async () => {
    await appendDecision(yggRoot, dismiss);
    // A non-JSON garbage line between valid records.
    appendFileSync(path.join(yggRoot, ADVISE_DECISIONS_FILENAME), 'not json at all\n', 'utf-8');
    await appendDecision(yggRoot, defer);
    // An unknown line-schema version — a future shape the current reader drops.
    appendFileSync(
      path.join(yggRoot, ADVISE_DECISIONS_FILENAME),
      JSON.stringify({ ...done, v: 2 }) + '\n',
      'utf-8',
    );
    await appendDecision(yggRoot, done);

    const { decisions, skipped } = readDecisions(yggRoot);
    expect(skipped).toBe(2);
    expect(decisions).toHaveLength(3);
    expect(decisions.map((d) => d.action)).toEqual(['dismiss', 'defer', 'done']);
    expect(decisions[0]).toEqual(dismiss);
    expect(decisions[1]).toEqual(defer);
    expect(decisions[2]).toEqual(done);
  });

  it('treats a missing register as a valid empty state (no throw)', () => {
    const { decisions, skipped } = readDecisions(yggRoot);
    expect(decisions).toEqual([]);
    expect(skipped).toBe(0);
  });

  it('drops a mis-shaped record (missing the mandatory reason) as skipped', async () => {
    await appendDecision(yggRoot, dismiss);
    // A record missing `reason` is mis-shaped — precedent needs prose — so the
    // tolerant reader counts it in `skipped` rather than surfacing a partial record.
    const { reason: _omit, ...noReason } = dismiss;
    void _omit;
    appendFileSync(
      path.join(yggRoot, ADVISE_DECISIONS_FILENAME),
      JSON.stringify(noReason) + '\n',
      'utf-8',
    );

    const { decisions, skipped } = readDecisions(yggRoot);
    expect(decisions).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});
