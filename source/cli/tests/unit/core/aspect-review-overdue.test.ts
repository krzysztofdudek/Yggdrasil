import { describe, it, expect } from 'vitest';
import { checkReviewOverdue } from '../../../src/core/checks/aspect-contracts.js';
import type { Graph } from '../../../src/model/graph.js';

/**
 * checkReviewOverdue — the constitution review-cadence linter (spec RZ-18).
 *
 * An aspect whose `review_by:` date has PASSED (against an INJECTED UTC clock) is
 * overdue and emits ONE grouped warning. Invariants proven here:
 *   - the clock is injected (a fixed past/future Date pins the result);
 *   - overdue is status-INDEPENDENT (a draft aspect with a past date still warns);
 *   - the comparison is strict-less-than on zero-padded ISO bare dates, so a date
 *     equal to "today" is NOT overdue;
 *   - the verbatim WHAT/WHY/NEXT text is emitted.
 */

function mkGraph(aspects: Array<Record<string, unknown>>): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map(),
    aspects,
    flows: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
  } as unknown as Graph;
}

const A_PAST = { id: 'past-rule', name: 'past', reviewer: { type: 'llm' }, artifacts: [], reviewBy: '2026-08-01' };
const A_FUTURE = { id: 'future-rule', name: 'future', reviewer: { type: 'llm' }, artifacts: [], reviewBy: '2028-01-01' };

describe('checkReviewOverdue', () => {
  it('a future clock warns on exactly the one aspect whose date has passed', () => {
    const issues = checkReviewOverdue(
      mkGraph([A_PAST, A_FUTURE]),
      new Date('2027-10-01T00:00:00Z'),
    );
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.code).toBe('aspect-review-overdue');
    expect(issue.severity).toBe('warning');
    // The synthetic aspects/<id> nodePath drives grouping. ValidationIssue carries
    // no aspectId field, so overdue warnings collapse into ONE code-only group and
    // list their affected aspect nodePaths beneath the shared why+fix.
    expect(issue.nodePath).toBe('aspects/past-rule');
    // Verbatim WHAT/WHY/NEXT (spec RZ-18).
    expect(issue.messageData!.what).toBe("Aspect 'past-rule' is past its review_by date (2026-08-01).");
    expect(issue.messageData!.why).toBe(
      'A review_by date is a standing request to re-examine whether this rule still earns its place — the date has passed, so the rule is running unreviewed.',
    );
    expect(issue.messageData!.next).toBe(
      'Ask the user to renew or retire this rule — propose a new review_by date or a demotion; never change the date without their approval.',
    );
  });

  it('a past clock (before both dates) warns zero', () => {
    const issues = checkReviewOverdue(
      mkGraph([A_PAST, A_FUTURE]),
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(issues).toHaveLength(0);
  });

  it('overdue is status-independent — a draft aspect with a past date still warns', () => {
    const draftPast = { ...A_PAST, id: 'draft-rule', status: 'draft' };
    const issues = checkReviewOverdue(
      mkGraph([draftPast]),
      new Date('2027-10-01T00:00:00Z'),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].nodePath).toBe('aspects/draft-rule');
  });

  it('a date equal to today is NOT overdue (strict less-than on bare ISO dates)', () => {
    const dueToday = { ...A_PAST, id: 'today-rule', reviewBy: '2027-10-01' };
    const issues = checkReviewOverdue(
      mkGraph([dueToday]),
      new Date('2027-10-01T23:59:59Z'),
    );
    expect(issues).toHaveLength(0);
  });

  it('aspects without review_by never participate (presence gate)', () => {
    const noDate = { id: 'plain', name: 'plain', reviewer: { type: 'llm' }, artifacts: [] };
    const issues = checkReviewOverdue(
      mkGraph([noDate]),
      new Date('2999-01-01T00:00:00Z'),
    );
    expect(issues).toHaveLength(0);
  });

  it('multiple overdue aspects all emit under the same code (one grouped warning)', () => {
    const secondPast = { ...A_PAST, id: 'second-past', reviewBy: '2025-05-05' };
    const issues = checkReviewOverdue(
      mkGraph([A_PAST, secondPast, A_FUTURE]),
      new Date('2027-10-01T00:00:00Z'),
    );
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['aspect-review-overdue']));
    // Shared why + next across every member is what lets the renderer collapse
    // them into a single block with each aspect listed beneath.
    expect(new Set(issues.map((i) => i.messageData!.why)).size).toBe(1);
    expect(new Set(issues.map((i) => i.messageData!.next)).size).toBe(1);
  });
});
