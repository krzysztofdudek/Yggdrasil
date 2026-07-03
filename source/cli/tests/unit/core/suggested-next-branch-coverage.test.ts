import { describe, it, expect } from 'vitest';
import { computeSuggestedNext } from '../../../src/core/check.js';

/**
 * Branch-coverage tests for the `suggestedNext` priority cascade — the single line
 * `yg check` prints to point an agent at the highest-priority fix. Each error category
 * (log integrity/format, gitignored-mapped, structural with the coverage "Then" rider,
 * coverage, completeness, and the architecture "other" fallback) must render its own
 * remedy in the documented precedence, and a warnings-only run must surface the advisory.
 */

interface Issue {
  severity: 'error' | 'warning';
  code: string;
  nodePath?: string;
  uncoveredCount?: number;
  messageData: { what: string; why: string; next: string };
}

const md = (next: string) => ({ what: 'w', why: 'y', next });
const run = (issues: Issue[]): string | null =>
  computeSuggestedNext(issues as unknown as Parameters<typeof computeSuggestedNext>[0]);

describe('computeSuggestedNext', () => {
  it('returns null when there are no issues at all', () => {
    expect(run([])).toBeNull();
  });

  it('surfaces the advisory next when only aspect warnings remain', () => {
    const issues: Issue[] = [{ severity: 'warning', code: 'aspect-violation-advisory', messageData: md('REVIEW-ADVISORY') }];
    expect(run(issues)).toBe('REVIEW-ADVISORY');
  });

  it('renders a log-integrity remedy, defaulting an absent node and pluralizing the count', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'log-integrity', messageData: md('x') },
      { severity: 'error', code: 'log-integrity', messageData: md('x') },
    ];
    const next = run(issues);
    expect(next).toContain('<unknown>');
    expect(next).toContain('2 log integrity violations');
  });

  it('renders a log-format remedy naming the node with a singular count', () => {
    const issues: Issue[] = [{ severity: 'error', code: 'log-format', nodePath: 'orders/handler', messageData: md('x') }];
    const next = run(issues);
    expect(next).toContain('orders/handler');
    expect(next).toContain('1 log format violation');
  });

  it('surfaces the file-specific remedy for a gitignored mapped file', () => {
    const issues: Issue[] = [{ severity: 'error', code: 'mapped-file-gitignored', messageData: md('UNIGNORE-THE-FILE') }];
    expect(run(issues)).toBe('UNIGNORE-THE-FILE');
  });

  it('names the alphabetically-first structural code and appends the coverage rider', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'yaml-invalid', nodePath: 'b/n', messageData: md('x') },
      { severity: 'error', code: 'aspect-undefined', nodePath: 'a/n', messageData: md('x') },
      { severity: 'error', code: 'unmapped-files', uncoveredCount: 4, messageData: md('x') },
    ];
    const next = run(issues);
    // 'aspect-undefined' sorts before 'yaml-invalid'.
    expect(next).toContain('Fix aspect-undefined in a/n');
    expect(next).toContain('Then: 4 files need coverage');
  });

  it('renders the coverage bootstrap step when only unmapped files remain', () => {
    const issues: Issue[] = [{ severity: 'error', code: 'unmapped-files', uncoveredCount: 3, messageData: md('x') }];
    const next = run(issues);
    expect(next).toContain('yg context --file');
    expect(next).toContain('3 files need coverage');
  });

  it('renders a completeness remedy for a missing description', () => {
    const issues: Issue[] = [{ severity: 'error', code: 'description-missing', nodePath: 'x/y', messageData: md('x') }];
    const next = run(issues);
    expect(next).toContain('Fix description-missing for x/y');
  });

  it('falls back to the alphabetically-first architecture error next', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'parent-type-forbidden', nodePath: 'z/n', messageData: md('FIX-PARENT') },
      { severity: 'error', code: 'type-undefined', nodePath: 'a/n', messageData: md('FIX-TYPE') },
    ];
    // Sorted by code: 'parent-type-forbidden' < 'type-undefined', so its next wins.
    expect(run(issues)).toBe('FIX-PARENT');
  });
});
