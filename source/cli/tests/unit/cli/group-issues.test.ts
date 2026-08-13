import { describe, it, expect } from 'vitest';
import {
  groupIssues,
  CODE_ONLY_GROUP_CODES,
  FULL_WHAT_CODES,
  COVERAGE_GROUP_EXCLUDED_CODES,
  coverageBlockLabel,
} from '../../../src/cli/group-issues.js';
import { computeSuggestedNext } from '../../../src/core/check.js';
import type { CheckIssue } from '../../../src/core/check.js';

function iss(p: Partial<CheckIssue>): CheckIssue {
  return {
    severity: 'error', code: 'unverified', rule: 'unverified',
    messageData: { what: 'w', why: 'shared-why', next: 'yg check --approve' },
    ...p,
  } as CheckIssue;
}

describe('groupIssues', () => {
  it('collapses same (code, aspectId) across nodes into ONE group', () => {
    const groups = groupIssues([
      iss({ aspectId: 'audit-logging', nodePath: 'b' }),
      iss({ aspectId: 'audit-logging', nodePath: 'a' }),
      iss({ aspectId: 'audit-logging', nodePath: 'c' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pairCount).toBe(3);
    expect(groups[0].nodeCount).toBe(3);
    expect(groups[0].members.map((m) => m.nodePath)).toEqual(['a', 'b', 'c']); // sorted
    expect(groups[0].sharedWhy).toBe('shared-why');
  });

  it('keeps different aspectIds as separate groups for non-unverified codes', () => {
    const groups = groupIssues([
      iss({ code: 'aspect-violation-enforced', aspectId: 'x', nodePath: 'a' }),
      iss({ code: 'aspect-violation-enforced', aspectId: 'y', nodePath: 'a' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('marks refusal codes as perMemberReason', () => {
    const [g] = groupIssues([
      iss({ code: 'aspect-violation-enforced', aspectId: 'x', nodePath: 'a' }),
    ]);
    expect(g.perMemberReason).toBe(true);
    expect(g.label).toBe('enforced');
  });

  // The type-relation gate's `what` carries its sample-edges list on lines
  // after the first (mirroring relation-undeclared-dependency's own violation
  // list) — truncating to line 1 in --details would hide exactly the edges the
  // agent needs to allow, graduate, or remove.
  it('marks type-relation-forbidden as a FULL_WHAT code (its sample-edges list must not be truncated)', () => {
    expect(FULL_WHAT_CODES.has('type-relation-forbidden')).toBe(true);
    const [g] = groupIssues([iss({ code: 'type-relation-forbidden' })]);
    expect(g.perMemberReason).toBe(true);
  });

  // NEW: unverified issues with DIFFERENT aspectIds collapse into ONE group
  it('collapses unverified issues with DIFFERENT aspectIds into ONE group', () => {
    const groups = groupIssues([
      iss({ code: 'unverified', aspectId: 'audit-logging', nodePath: 'orders/handler' }),
      iss({ code: 'unverified', aspectId: 'command-exit-codes', nodePath: 'cli/commands/check' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pairCount).toBe(2);
    // The group spans multiple aspects — aspectId is undefined on the group
    expect(groups[0].aspectId).toBeUndefined();
    // Individual members still carry their own aspectIds
    const aspectIds = groups[0].members.map((m) => m.aspectId);
    expect(aspectIds).toContain('audit-logging');
    expect(aspectIds).toContain('command-exit-codes');
  });

  // NEW: CODE_ONLY_GROUP_CODES export check
  it('CODE_ONLY_GROUP_CODES includes "unverified"', () => {
    expect(CODE_ONLY_GROUP_CODES.has('unverified')).toBe(true);
  });

  // NEW: non-unverified codes with different aspectIds remain as separate groups
  it('prompt-too-large with two different aspectIds makes TWO groups', () => {
    const groups = groupIssues([
      iss({ code: 'prompt-too-large', aspectId: 'aspect-a', nodePath: 'node/a' }),
      iss({ code: 'prompt-too-large', aspectId: 'aspect-b', nodePath: 'node/b' }),
    ]);
    expect(groups).toHaveLength(2);
    // Each group retains its specific aspectId
    const ids = groups.map((g) => g.aspectId).sort();
    expect(ids).toEqual(['aspect-a', 'aspect-b']);
  });

  // ── Fix 4: divergent per-node `next` / `why` detection ──────────────────────
  // For codes whose fix is NODE-SPECIFIC (log-entry-missing, relation-undeclared,
  // architecture errors), a group of 2+ members carries DISTINCT `next` (and
  // sometimes `why`) values. The group must flag this so the renderer surfaces
  // each member's own command rather than only the alphabetically-first member's.
  it('flags divergentNext when two members carry distinct `next` values', () => {
    const [g] = groupIssues([
      iss({
        code: 'log-entry-missing', aspectId: undefined, nodePath: 'orders/handler',
        messageData: { what: "No fresh log entry for node 'orders/handler'.", why: "Node type 'command' has log_required.", next: "yg log add --node orders/handler --reason '<x>'" },
      }),
      iss({
        code: 'log-entry-missing', aspectId: undefined, nodePath: 'billing/charge',
        messageData: { what: "No fresh log entry for node 'billing/charge'.", why: "Node type 'command' has log_required.", next: "yg log add --node billing/charge --reason '<x>'" },
      }),
    ]);
    expect(g.divergentNext).toBe(true);
  });

  it('does NOT flag divergentNext when all members share one `next` (LLM refusal)', () => {
    const [g] = groupIssues([
      iss({
        code: 'aspect-violation-enforced', aspectId: 'audit-logging', nodePath: 'a',
        messageData: { what: 'refused on a', why: 'shared-why', next: 'fix A, fix B, or yg-suppress' },
      }),
      iss({
        code: 'aspect-violation-enforced', aspectId: 'audit-logging', nodePath: 'b',
        messageData: { what: 'refused on b', why: 'shared-why', next: 'fix A, fix B, or yg-suppress' },
      }),
    ]);
    expect(g.divergentNext).toBe(false);
    expect(g.divergentWhy).toBe(false);
  });

  it('flags divergentWhy when two members carry distinct `why` values (relation-target-forbidden allow-list vs default-deny)', () => {
    const [g] = groupIssues([
      iss({
        code: 'relation-target-forbidden', aspectId: undefined, nodePath: 'a',
        messageData: { what: 'forbidden on a', why: "Allowed targets for 'uses' from type 'x': [y]", next: 'change relation' },
      }),
      iss({
        code: 'relation-target-forbidden', aspectId: undefined, nodePath: 'b',
        messageData: { what: 'forbidden on b', why: "Type 'x' denies relation 'uses' by default", next: 'open uses for type x' },
      }),
    ]);
    expect(g.divergentWhy).toBe(true);
    expect(g.divergentNext).toBe(true);
  });

  it('single-member group is never flagged divergent', () => {
    const [g] = groupIssues([
      iss({ code: 'log-entry-missing', aspectId: undefined, nodePath: 'solo',
        messageData: { what: 'w', why: 'y', next: 'yg log add --node solo' } }),
    ]);
    expect(g.divergentNext).toBe(false);
    expect(g.divergentWhy).toBe(false);
  });
});

// ── fileCount — nodeless (type-covered-file) pair-derived members ────────────
// A pair-derived issue with no nodePath carries its unitKey instead (set by
// core/check.ts's emitPairIssue). nodeCount must count ONLY members with a
// real component; fileCount counts nodeless members by their DISTINCT file
// unit key, so the group header can say "3 components, 7 files" without
// double-counting a file that several aspects share.
function fileIss(p: Partial<CheckIssue>): CheckIssue {
  return iss({ nodePath: undefined, ...p });
}

describe('groupIssues — fileCount', () => {
  it('a nodeless member is excluded from nodeCount and counted in fileCount instead', () => {
    const [g] = groupIssues([
      iss({ aspectId: 'a', nodePath: 'svc' }),
      fileIss({ aspectId: 'a', unitKey: 'file:src/leaf/a.ts' }),
    ]);
    expect(g.nodeCount).toBe(1);
    expect(g.fileCount).toBe(1);
  });

  it('several aspects sharing the SAME file unit key count as ONE file, not one per aspect', () => {
    const [g] = groupIssues([
      fileIss({ code: 'unverified', aspectId: 'a', unitKey: 'file:src/leaf/a.ts' }),
      fileIss({ code: 'unverified', aspectId: 'b', unitKey: 'file:src/leaf/a.ts' }),
    ]);
    // Both are code-only ('unverified') so they collapse into one group.
    expect(g.fileCount).toBe(1);
    expect(g.nodeCount).toBe(0);
  });

  it('a genuinely repo-level member (neither nodePath nor unitKey) counts toward neither', () => {
    const [g] = groupIssues([
      { severity: 'warning', code: 'rules-digest-stale', rule: 'rules-digest-stale', messageData: { what: 'w', why: 'y', next: 'n' } } as CheckIssue,
    ]);
    expect(g.nodeCount).toBe(0);
    expect(g.fileCount).toBe(0);
  });

  it('sort key falls back to unitKey for a nodeless member (not collapsed to empty string)', () => {
    const [g] = groupIssues([
      fileIss({ aspectId: 'a', unitKey: 'file:src/leaf/z.ts' }),
      fileIss({ aspectId: 'a', unitKey: 'file:src/leaf/a.ts' }),
    ]);
    // Sorted: file:src/leaf/a.ts before file:src/leaf/z.ts.
    expect(g.members.map((m) => m.unitKey)).toEqual(['file:src/leaf/a.ts', 'file:src/leaf/z.ts']);
  });
});

// ── F3: bare `--top` group === the rule `Next:` names (single ordering) ───────
// issuePriorityRank (drives which group bare `--top` renders, via groupIssues)
// and computeSuggestedNext (drives the `Next:` line) must order UNRANKED errors
// identically. Before the fix, groupIssues sorted every unranked error
// alphabetically by code — so `unmapped-files` (coverage) could take the top slot
// over a structural code, and within structural the alphabetical pick differed
// from computeSuggestedNext's emission-order pick — letting bare `--top` render a
// different rule than `Next:` pointed at. Both surfaces now share ONE ordering:
// structural < coverage < completeness < other, alphabetical-by-code within a
// category. These pin the invariant on the exact issue sets the review flagged.
function structuralIssue(code: string, nodePath: string): CheckIssue {
  return {
    severity: 'error', code, rule: code, nodePath,
    messageData: { what: `${code} on ${nodePath}`, why: 'structural graph defect', next: `Fix ${code}` },
  } as CheckIssue;
}
function unmappedIssue(): CheckIssue {
  return {
    severity: 'error', code: 'unmapped-files', rule: 'unmapped-files',
    uncoveredCount: 2, uncoveredFiles: ['src/a.ts', 'src/b.ts'],
    messageData: { what: '2 files not covered', why: 'coverage gap', next: 'yg context --file <uncovered-path>' },
  } as unknown as CheckIssue;
}

describe('bare --top group === the rule Next names (F3 invariant)', () => {
  it('within-structural: the alphabetically-first structural code wins BOTH surfaces (event-unpaired < yaml-invalid); coverage never jumps ahead', () => {
    const errors: CheckIssue[] = [
      structuralIssue('yaml-invalid', 'nodeB'),    // 'y'
      unmappedIssue(),                              // 'unmapped-files' — coverage
      structuralIssue('event-unpaired', 'nodeA'),  // 'e' — alphabetically first
    ];
    // Bare `--top` renders groupIssues(errors)[0] (errors first, sliced at n=1).
    const topGroup = groupIssues(errors)[0];
    const next = computeSuggestedNext(errors);
    expect(next).not.toBeNull();
    // Structural beats coverage; the alphabetically-first structural wins the slot.
    expect(topGroup.code).toBe('event-unpaired');
    // The `Next:` line names EXACTLY that rule.
    expect(next!.startsWith('Fix event-unpaired ')).toBe(true);
    // Invariant: the group bare `--top` renders is the group `Next:` names.
    expect(next!.includes(topGroup.code)).toBe(true);
    // Coverage did NOT win the top slot (the old alphabetical-across-all bug).
    expect(topGroup.code).not.toBe('unmapped-files');
  });

  it('structural-vs-coverage: a structural code that sorts AFTER unmapped-files still wins over coverage (when-predicate-invalid > unmapped-files)', () => {
    const errors: CheckIssue[] = [
      unmappedIssue(),                                     // 'unmapped-files' (u)
      structuralIssue('when-predicate-invalid', 'nodeC'), // 'w' — sorts after 'u'
    ];
    const topGroup = groupIssues(errors)[0];
    const next = computeSuggestedNext(errors);
    // OLD: alphabetical-across-all put unmapped-files first (u<w) → `--top` showed
    // coverage while `Next:` pointed at the structural error. NEW: structural < coverage.
    expect(topGroup.code).toBe('when-predicate-invalid');
    expect(next!.startsWith('Fix when-predicate-invalid ')).toBe(true);
    expect(next!.includes(topGroup.code)).toBe(true);
  });

  it('other-error only (mapping-path-missing): Next is no longer null and names the group bare --top renders', () => {
    // mapping-path-missing is an "other" error (not structural/coverage/
    // completeness). Previously computeSuggestedNext returned null here while
    // `--top` still rendered its group — no `Next:` to agree with. Now `Next:`
    // names it, holding the invariant even on an other-error-only red repo.
    const errors: CheckIssue[] = [
      iss({
        code: 'mapping-path-missing', rule: 'mapping-path-missing', aspectId: undefined, nodePath: 'broken',
        messageData: { what: 'mapping path missing on broken', why: 'x', next: 'yg fix mapping on broken' },
      }),
    ];
    const topGroup = groupIssues(errors)[0];
    const next = computeSuggestedNext(errors);
    expect(topGroup.code).toBe('mapping-path-missing');
    expect(next).toBe('yg fix mapping on broken'); // the issue's own next, alphabetically-first
  });
});

// ── computeSuggestedNext's structural fallback names the FILE for a
//    nodeless (type-covered-file) structural issue, never '.yggdrasil'. ──────
describe('computeSuggestedNext — nodeless structural fallback', () => {
  it('names the subject FILE (from the unit key) when the chosen structural issue has no component', () => {
    const errors: CheckIssue[] = [{
      severity: 'error',
      code: 'file-unreadable',
      rule: 'file-unreadable',
      nodePath: undefined,
      unitKey: 'file:src/leaf/a.ts',
      messageData: {
        what: "Aspect 'own-file-rule' could not read its subject file 'src/leaf/a.ts': EACCES.",
        why: 'y',
        next: 'Fix permissions.',
      },
    } as CheckIssue];
    const next = computeSuggestedNext(errors);
    expect(next).toContain('Fix file-unreadable in src/leaf/a.ts');
    expect(next).not.toContain('.yggdrasil');
  });

  it('still falls back to .yggdrasil for a genuinely repo-level structural issue (neither nodePath nor a file unitKey)', () => {
    const errors: CheckIssue[] = [{
      severity: 'error',
      code: 'config-invalid',
      rule: 'config-invalid',
      messageData: { what: 'bad config', why: 'y', next: 'fix it' },
    } as CheckIssue];
    const next = computeSuggestedNext(errors);
    expect(next).toContain('Fix config-invalid in .yggdrasil');
  });
});

// A pair this run's fill already proved cannot run (see
// core/type-visibility.ts's cannotRunUnverifiedMessage) carries its own real
// remedy as `next`, never the generic 'yg check --approve'. computeSuggestedNext
// must not let that pair's `next` win the overall `Next:` slot while a pair
// --approve genuinely CAN still change is sitting right next to it — the run
// would tell the reader to re-run the one command it just proved is useless
// for one member, while staying silent about the pair it would actually help.
describe('computeSuggestedNext — a pair this run proved cannot run never displaces a pair --approve can still fill', () => {
  const cannotRunNext =
    'Give the file a component of its own (a yg-node.yaml mapping it), or fix what the reason above names in check.mjs / yg-architecture.yaml — not another --approve.';

  it('picks the fillable pair\'s generic command when a fillable AND a cannot-run unverified pair both exist', () => {
    const errors: CheckIssue[] = [
      iss({
        aspectId: 'needs-node-context', nodePath: undefined, unitKey: 'file:src/crashy/a.ts',
        messageData: { what: 'w', why: 'y', next: cannotRunNext },
      }),
      iss({ aspectId: 'fillable-y', nodePath: 'a' }), // default messageData.next: 'yg check --approve'
    ];
    expect(computeSuggestedNext(errors)).toBe('yg check --approve');
  });

  it('falls back to the cannot-run pair\'s own remedy only once EVERY unverified pair is unfillable', () => {
    const errors: CheckIssue[] = [
      iss({
        aspectId: 'needs-node-context', nodePath: undefined, unitKey: 'file:src/crashy/a.ts',
        messageData: { what: 'w', why: 'y', next: cannotRunNext },
      }),
    ];
    expect(computeSuggestedNext(errors)).toBe(cannotRunNext);
  });
});

// ── Twins of the scoped codes, derived rather than hand-listed ───────────────

/**
 * Each of the three render sets decides how a code is presented: collapsed into
 * one group, shown with its full actionable body, or pulled out as a file-list
 * block. A finding put outside the change is the SAME finding — it must present
 * the same way, or being outside the change silently costs a reader the
 * reviewer's reason, the violation list, or the file names.
 */
describe('render code sets — the -outside twins', () => {
  it('collapses `unverified-outside` by code, exactly as its untwinned form does', () => {
    expect(CODE_ONLY_GROUP_CODES.has('unverified-outside')).toBe(true);
    const groups = groupIssues([
      iss({ severity: 'warning', code: 'unverified-outside', aspectId: 'audit-logging', nodePath: 'a' }),
      iss({ severity: 'warning', code: 'unverified-outside', aspectId: 'retention', nodePath: 'b' }),
      iss({ severity: 'warning', code: 'unverified-outside', aspectId: 'naming', nodePath: 'c' }),
    ]);
    // One block, not one per aspect — otherwise a run reporting inherited debt
    // fragments into dozens of blocks and pushes real warnings past the cap.
    expect(groups).toHaveLength(1);
    expect(groups[0].pairCount).toBe(3);
    expect(groups[0].aspectId).toBeUndefined();
  });

  it('keeps the full actionable body for every twin that can carry one', () => {
    for (const code of [
      'aspect-violation-enforced-outside',
      'relation-undeclared-dependency-outside',
      'type-relation-forbidden-outside',
    ]) {
      expect(FULL_WHAT_CODES.has(code), code).toBe(true);
    }
  });

  it('invents no twin for a code a change scope can never twin', () => {
    // `aspect-violation-advisory` is already a warning, so it is not scoped and
    // no twin of it ever exists. A blanket `.map(outsideTwin)` would have put a
    // code here that nothing can ever produce.
    expect(FULL_WHAT_CODES.has('aspect-violation-advisory-outside')).toBe(false);
  });

  it('routes the inherited half of a split coverage finding to the file-list block', () => {
    expect(COVERAGE_GROUP_EXCLUDED_CODES.has('unmapped-files-outside')).toBe(true);
    expect(COVERAGE_GROUP_EXCLUDED_CODES.has('uncovered-advisory-outside')).toBe(false);
  });

  it('labels the inherited half by what it is, not by the section it sits in', () => {
    expect(coverageBlockLabel('unmapped-files')).toBe('unmapped');
    expect(coverageBlockLabel('unmapped-files-outside')).toBe('unmapped');
    expect(coverageBlockLabel('uncovered-advisory')).toBe('uncovered');
  });
});
