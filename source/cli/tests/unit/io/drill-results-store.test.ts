import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendDrillResult, DRILL_RESULTS_FILENAME, type DrillResultLine } from '../../../src/io/drill-results-store.js';

describe('drill-results-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-drill-store-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const detLine: DrillResultLine = {
    v: 1,
    ts: '2026-07-11T00:00:00.000Z',
    aspect: 'no-direct-minimatch',
    case: 'violates-named-import/import-minimatch',
    expect: 'refused',
    got: 'refused',
    src: 'dev',
    corpus: 'dev',
    caseHash: 'case-hash-1',
    ruleHash: 'rule-hash-1',
    kind: 'deterministic',
  };
  const llmLine: DrillResultLine = {
    v: 1,
    ts: '2026-07-11T00:00:01.000Z',
    aspect: 'has-doc-comment',
    case: 'satisfies-documented/ok',
    expect: 'satisfied',
    got: 'satisfied',
    src: 'holdout',
    corpus: 'external-set',
    caseHash: 'case-hash-2',
    ruleHash: 'rule-hash-2',
    kind: 'llm',
    tier: 'standard',
    votes: { satisfied: 1, total: 1 },
  };

  it('writes one JSON line + newline; a second call appends (two lines), in order', () => {
    appendDrillResult(tmpDir, detLine);
    appendDrillResult(tmpDir, llmLine);

    const p = path.join(tmpDir, DRILL_RESULTS_FILENAME);
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(detLine);
    expect(JSON.parse(lines[1])).toEqual(llmLine);
  });

  it('self-ensures ".drill-results.jsonl*" in .yggdrasil/.gitignore before the first write (idempotent)', () => {
    appendDrillResult(tmpDir, detLine);
    const giPath = path.join(tmpDir, '.gitignore');
    expect(existsSync(giPath)).toBe(true);
    const gi1 = readFileSync(giPath, 'utf-8');
    const matches = gi1.split('\n').filter((l) => l.trim() === '.drill-results.jsonl*');
    expect(matches).toHaveLength(1);

    // A second write does NOT duplicate the entry.
    appendDrillResult(tmpDir, llmLine);
    const gi2 = readFileSync(giPath, 'utf-8');
    expect(gi2.split('\n').filter((l) => l.trim() === '.drill-results.jsonl*')).toHaveLength(1);
  });

  it('preserves a pre-existing .gitignore and appends the entry on its own line', () => {
    const giPath = path.join(tmpDir, '.gitignore');
    writeFileSync(giPath, 'yg-secrets.yaml\n.yg-events.jsonl\n', 'utf-8');
    appendDrillResult(tmpDir, detLine);
    const gi = readFileSync(giPath, 'utf-8');
    expect(gi).toContain('yg-secrets.yaml');
    expect(gi).toContain('.yg-events.jsonl');
    expect(gi.split('\n').filter((l) => l.trim() === '.drill-results.jsonl*')).toHaveLength(1);
  });

  it('a write to an unwritable path does NOT throw (best-effort, never breaks a drill run)', () => {
    const unwritable = path.join(tmpDir, 'nope', 'deeper');
    expect(() => appendDrillResult(unwritable, detLine)).not.toThrow();
    expect(existsSync(unwritable)).toBe(false);
  });
});
