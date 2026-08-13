import { describe, it, expect } from 'vitest';
import { computeSuggestedNext } from '../../../src/core/check.js';

/**
 * Branch-coverage tests for the `suggestedNext` priority cascade — the single line
 * `yg check` prints to point an agent at the highest-priority fix. Each error category
 * (log integrity/format, structural with the coverage "Then" rider, coverage,
 * completeness, and the architecture "other" fallback) must render its own remedy in
 * the documented precedence, and a warnings-only run must surface the advisory.
 */

interface Issue {
  severity: 'error' | 'warning';
  code: string;
  nodePath?: string;
  aspectId?: string;
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

  it('surfaces a non-advisory warning next when only such warnings remain (C-41)', () => {
    // A fully-green graph with a single rule past its review_by date produces
    // errors=[], warnings=[aspect-review-overdue]. The top-level Next: must still
    // point somewhere rather than going silently absent.
    const issues: Issue[] = [
      { severity: 'warning', code: 'aspect-review-overdue', aspectId: 'audit-log', messageData: md('RENEW-OR-DEMOTE') },
    ];
    expect(run(issues)).toBe('RENEW-OR-DEMOTE');
  });

  it('picks the alphabetically-first aspectId among advisory warnings (C-42)', () => {
    // Raw emission order (pair iteration) is not locale order; the Next: line must
    // name the same aspect groupIssues/--top renders first — the locale-first id.
    const issues: Issue[] = [
      { severity: 'warning', code: 'aspect-violation-advisory', aspectId: 'zebra', messageData: md('NEXT-ZEBRA') },
      { severity: 'warning', code: 'aspect-violation-advisory', aspectId: 'alpha', messageData: md('NEXT-ALPHA') },
    ];
    expect(run(issues)).toBe('NEXT-ALPHA');
  });

  it('prefers an advisory warning over other warnings when both are present (C-41/C-42)', () => {
    const issues: Issue[] = [
      { severity: 'warning', code: 'high-fan-out', nodePath: 'a/n', messageData: md('NEXT-FANOUT') },
      { severity: 'warning', code: 'aspect-violation-advisory', aspectId: 'audit-log', messageData: md('NEXT-ADVISORY') },
    ];
    expect(run(issues)).toBe('NEXT-ADVISORY');
  });

  it('picks the alphabetically-first enforced refusal by aspectId (C-37)', () => {
    // Raw emission order puts 'B-rule' first (byte compare: B < a), but locale order
    // puts 'audit-log' first — matching the group bare `yg check --top` renders.
    const issues: Issue[] = [
      { severity: 'error', code: 'aspect-violation-enforced', aspectId: 'B-rule', nodePath: 'x/n', messageData: md('NEXT-BRULE') },
      { severity: 'error', code: 'aspect-violation-enforced', aspectId: 'audit-log', nodePath: 'y/n', messageData: md('NEXT-AUDIT') },
    ];
    expect(run(issues)).toBe('NEXT-AUDIT');
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

  it('surfaces the file-specific remedy for a tracked∩gitignored anomaly via the "any other error" fallback', () => {
    // tracked-file-gitignored carries no dedicated branch (unlike the retired
    // mapped-file-gitignored) — it is neither structural, unmapped-files, nor
    // completeness, so as the sole error it falls through to the final "any
    // remaining error" step and its own `next` still surfaces directly.
    const issues: Issue[] = [{ severity: 'error', code: 'tracked-file-gitignored', messageData: md('UNIGNORE-THE-FILE') }];
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

/**
 * Findings the current change is NOT accountable for arrive here as `-outside`
 * twins at warning severity. Their `next` is written for the finding, not for
 * the scope — an outside `unverified` still carries `yg check --approve`, which
 * would review the whole graph — so the warnings fallback must never surface it.
 */
describe('computeSuggestedNext — findings outside the change', () => {
  const STANDING = "run 'yg check --full' for the complete audit";

  it('points at the full audit instead of an outside finding\'s own command', () => {
    const issues: Issue[] = [
      { severity: 'warning', code: 'unverified-outside', aspectId: 'audit-log', messageData: md('yg check --approve') },
    ];
    const next = run(issues);
    expect(next).not.toBe('yg check --approve');
    expect(next).toBe(`1 enforced obligation(s) outside your changes — ${STANDING}`);
  });

  it('counts the coverage twin by the files it names, not as one finding', () => {
    const issues: Issue[] = [
      { severity: 'warning', code: 'unverified-outside', aspectId: 'audit-log', messageData: md('yg check --approve') },
      { severity: 'warning', code: 'unmapped-files-outside', uncoveredCount: 3, messageData: md('x') },
    ];
    expect(run(issues)).toBe(`4 enforced obligation(s) outside your changes — ${STANDING}`);
  });

  it('outranks a surviving pre-existing warning, whose next is not about this change', () => {
    const issues: Issue[] = [
      { severity: 'warning', code: 'unverified-outside', aspectId: 'audit-log', messageData: md('yg check --approve') },
      { severity: 'warning', code: 'high-fan-out', nodePath: 'a/n', messageData: md('NEXT-FANOUT') },
    ];
    expect(run(issues)).toBe(`1 enforced obligation(s) outside your changes — ${STANDING}`);
  });

  it('outranks the ADVISORY branch too — the one that steers at a repo-wide review', () => {
    // The live case: this repository ships advisory aspects, so a
    // progressive-green run would otherwise end on an advisory violation's own
    // guidance about re-reviewing every component — a repo-wide paid operation
    // nobody asked for, clearing debt this change did not cause.
    const issues: Issue[] = [
      { severity: 'warning', code: 'unverified-outside', aspectId: 'audit-log', messageData: md('yg check --approve') },
      { severity: 'warning', code: 'aspect-violation-advisory', aspectId: 'audit-log', messageData: md('yg check --approve') },
    ];
    const next = run(issues);
    expect(next).not.toBe('yg check --approve');
    expect(next).toBe(`1 enforced obligation(s) outside your changes — ${STANDING}`);
  });

  it('leaves a run with no twin at all exactly as it was', () => {
    const issues: Issue[] = [
      { severity: 'warning', code: 'aspect-violation-advisory', aspectId: 'audit-log', messageData: md('NEXT-ADVISORY') },
      { severity: 'warning', code: 'high-fan-out', nodePath: 'a/n', messageData: md('NEXT-FANOUT') },
    ];
    expect(run(issues)).toBe('NEXT-ADVISORY');
  });

  it('lets a real error outrank the standing line entirely', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'lock-invalid', messageData: md('RESTORE-THE-LOCK') },
      { severity: 'warning', code: 'unverified-outside', aspectId: 'audit-log', messageData: md('yg check --approve') },
    ];
    expect(run(issues)).toBe('RESTORE-THE-LOCK');
  });

  it('reads the coverage count from the blocking half of a split, never the inherited one', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'unmapped-files', uncoveredCount: 2, messageData: md('x') },
      { severity: 'warning', code: 'unmapped-files-outside', uncoveredCount: 5, messageData: md('x') },
    ];
    const next = run(issues);
    expect(next).toContain('2 files need coverage');
    expect(next).not.toContain('5 files');
  });

  it('reads the structural rider from the blocking half of a split too', () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'yaml-invalid', nodePath: 'b/n', messageData: md('x') },
      { severity: 'error', code: 'unmapped-files', uncoveredCount: 2, messageData: md('x') },
      { severity: 'warning', code: 'unmapped-files-outside', uncoveredCount: 5, messageData: md('x') },
    ];
    const next = run(issues);
    expect(next).toContain('Then: 2 files need coverage');
  });
});
