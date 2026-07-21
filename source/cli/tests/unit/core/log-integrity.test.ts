import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { validateAppendOnly } from '../../../src/core/log-integrity.js';
import { hasFreshLogEntry, computeLogBaselineFromContent } from '../../../src/core/log/log-gate.js';

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('validateAppendOnly', () => {
  const e1 = '## [2026-05-11T14:23:00.000Z]\nFirst.\n';
  const e2 = '## [2026-05-11T14:24:00.000Z]\nSecond.\n';

  it('returns ok when baseline still present and prefix unchanged', () => {
    const content = e1;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: true });
  });

  it('returns ok when content has been APPENDED beyond baseline', () => {
    const content = e1 + e2;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: true });
  });

  it('returns boundary_missing when baseline datetime not found', () => {
    const content = '## [2026-05-11T15:00:00.000Z]\nReplaced.\n';
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });

  it('returns prefix_modified when baseline entry datetime exists but bytes differ', () => {
    const tampered = '## [2026-05-11T14:23:00.000Z]\nTampered body.\n';
    const result = validateAppendOnly(tampered, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('byte-exact: trailing newline before next header is part of prefix hash', () => {
    const content = e1 + e2;
    const prefixWithNewline = e1;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(prefixWithNewline));
    expect(result).toEqual({ ok: true });
  });

  it('empty content with baseline → boundary_missing', () => {
    const result = validateAppendOnly('', '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });
});

// =============================================================================
// core/log/log-gate.ts's pure helpers — hasFreshLogEntry and
// computeLogBaselineFromContent. Both are read-only primitives shared by the
// fill stage's mandatory-entry gate and `yg context`'s read-only display; no
// I/O, no clock — plain content in, a plain answer out. Colocated here as
// shared log-integrity infra alongside the append-only validator this file
// already covers.
// =============================================================================

const LG_ENTRY_A = '## [2026-05-11T14:23:00.123Z]\nFirst entry.\n';
const LG_ENTRY_B = '## [2026-05-12T09:00:00.000Z]\nSecond entry.\n';

describe('hasFreshLogEntry', () => {
  it('is false when the log has no entries at all', () => {
    expect(hasFreshLogEntry('', undefined)).toBe(false);
    expect(hasFreshLogEntry('', { last_entry_datetime: '2026-05-11T14:23:00.123Z' })).toBe(false);
  });

  it('is true when there is no stored baseline yet (first verification — any entry counts as fresh)', () => {
    expect(hasFreshLogEntry(LG_ENTRY_A, undefined)).toBe(true);
  });

  it('is false when the newest entry matches the stored baseline (no new entry since closure)', () => {
    expect(
      hasFreshLogEntry(LG_ENTRY_A, { last_entry_datetime: '2026-05-11T14:23:00.123Z' }),
    ).toBe(false);
  });

  it('is true when the newest entry postdates the stored baseline (a fresh entry landed)', () => {
    expect(
      hasFreshLogEntry(LG_ENTRY_A + LG_ENTRY_B, { last_entry_datetime: '2026-05-11T14:23:00.123Z' }),
    ).toBe(true);
  });
});

describe('computeLogBaselineFromContent', () => {
  it('is undefined for a log with no entries', () => {
    expect(computeLogBaselineFromContent('')).toBeUndefined();
    expect(computeLogBaselineFromContent('not a log header, just prose\n')).toBeUndefined();
  });

  it('carries the newest entry\'s datetime and a sha256 prefix hash over bytes [0..offsetEnd)', () => {
    const baseline = computeLogBaselineFromContent(LG_ENTRY_A + LG_ENTRY_B);
    expect(baseline).toBeDefined();
    expect(baseline!.last_entry_datetime).toBe('2026-05-12T09:00:00.000Z');
    expect(baseline!.prefix_hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same content always hashes to the same prefix.
    expect(computeLogBaselineFromContent(LG_ENTRY_A + LG_ENTRY_B)!.prefix_hash).toBe(baseline!.prefix_hash);
    // A DIFFERENT trailing entry changes the hash (the whole file up to offsetEnd is covered).
    const other = computeLogBaselineFromContent(LG_ENTRY_A + '## [2026-05-12T09:00:00.000Z]\nDifferent text.\n');
    expect(other!.prefix_hash).not.toBe(baseline!.prefix_hash);
  });
});
