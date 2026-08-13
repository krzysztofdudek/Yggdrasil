import { describe, it, expect } from 'vitest';
import { formatOutput, resolveTopValue } from '../../../src/cli/check-render-views.js';
import type { CheckView } from '../../../src/cli/check-render-views.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  unverifiedMessage,
} from '../../../src/formatters/lock-issue-messages.js';
import { applyChangeScope } from '../../../src/core/check-progressive.js';

/** Strip ANSI color codes so block-line counting is deterministic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Count rendered issue BLOCKS — a block begins with two-space-indented
 *  "<label>  <node>  <what>" (or the compact "<label> (<n>)" unmapped block).
 *  Continuation lines (Why:/Fix:/indented detail) are NOT block starts. */
function countBlocks(out: string): number {
  const clean = stripAnsi(out);
  return clean
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l) && !/^ {2}(Why:|Fix:)/.test(l))
    .length;
}

/**
 * Unit tests for the `yg check` view-selection render layer
 * (check-render-views.ts): the top-level `formatOutput` dispatcher and the
 * --summary/--top/--aspect/--details view bodies, the `Next:` line
 * composition, and `resolveTopValue`. These exercise the rendering directly
 * against constructed CheckResult objects — no spawned binary, no build — so
 * they pin the agent-facing OUTPUT contract: every view renders the same
 * header with the TRUE error/warning counts, and a truncated view must never
 * read as a clean build over errors it merely declined to print.
 */

function baseResult(issues: CheckIssue[]): CheckResult {
  const hasError = issues.some((i) => i.severity === 'error');
  return {
    projectName: 'test',
    nodeCount: 1,
    nodeTypeCounts: new Map(),
    aspectCount: 1,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: hasError ? 'yg check --approve' : null,
    advisoryWarnings: issues.filter((i) => i.code === 'aspect-violation-advisory').length,
    draftSkipped: 0,
    verifiedDet: 0,
    verifiedLlm: 0,
    pairs: [],
  };
}

describe('check render — Next line surfacing', () => {
  /** A result whose only issue is an advisory aspect-violation warning — the
   *  warnings-only PASS case. computeSuggestedNext returns the warning's `next`
   *  (non-null) even though there are zero errors. */
  function warningsOnlyResult(): CheckResult {
    const advWarning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason: 'missing audit entry',
      }),
    };
    return {
      projectName: 'test',
      nodeCount: 1,
      nodeTypeCounts: new Map(),
      aspectCount: 1,
      flowCount: 0,
      coveredFiles: 0,
      totalFiles: 0,
      issues: [advWarning],
      // What computeSuggestedNext returns for a warnings-only run: the first
      // advisory aspect-violation warning's own `next`.
      suggestedNext: advWarning.messageData.next,
      advisoryWarnings: 1,
      draftSkipped: 0,
      verifiedDet: 0,
      verifiedLlm: 0,
      pairs: [],
    };
  }

  it('renders the Next line on a warnings-only PASS (no errors, non-null suggestedNext)', () => {
    const out = formatOutput(warningsOnlyResult());
    // Still a PASS (warnings never fail the verdict)…
    expect(out).toContain('yg check: PASS');
    expect(out).toContain('1 warning');
    // …and the computed next-action is surfaced, not silently dropped.
    expect(out).toMatch(/\nNext: /);
  });

  it('omits the Next line on a fully-green run (no issues, null suggestedNext)', () => {
    const green: CheckResult = {
      ...warningsOnlyResult(),
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
    };
    const out = formatOutput(green);
    expect(out).toContain('yg check: PASS');
    // A clean run is self-evidently done — no invented green Next line.
    expect(out).not.toContain('Next:');
  });

  it('still renders the Next line on a failing run (errors present)', () => {
    const out = formatOutput(baseResult([
      {
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        nodePath: 'orders/handler',
        aspectId: 'audit-logging',
        messageData: unverifiedMessage({
          aspectId: 'audit-logging',
          unitKey: 'orders/handler#audit-logging',
        }),
      },
    ]));
    expect(out).toContain('yg check: FAIL');
    expect(out).toMatch(/\nNext: /);
  });
});

// ── Triage views: --top and --summary ──────────────────────

/** A four-error result mirroring the sample-project shape: two LLM unverified,
 *  one deterministic unverified, and one non-pair structural error (no
 *  pairKind) → the "other" bucket in --summary. */
function fourErrorResult(): CheckResult {
  const issues: CheckIssue[] = [
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'auth/auth-api',
      aspectId: 'requires-logging',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'requires-logging', unitKey: 'auth/auth-api#requires-logging' }),
    },
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/order-service',
      aspectId: 'requires-audit',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'requires-audit', unitKey: 'orders/order-service#requires-audit' }),
    },
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/order-service',
      aspectId: 'is-deterministic',
      pairKind: 'deterministic',
      messageData: unverifiedMessage({ aspectId: 'is-deterministic', unitKey: 'orders/order-service#is-deterministic' }),
    },
    {
      // Non-pair structural error — carries NO pairKind. Must be bucketed as
      // "other" in --summary so per-node totals reconcile with the header.
      severity: 'error',
      code: 'mapping-path-missing',
      rule: 'mapping-path-missing',
      nodePath: 'users/missing-service',
      messageData: {
        what: "Mapping path 'src/users/missing.service.ts' does not exist on disk.",
        why: 'A node mapping points at a file that is not present.',
        next: 'Create the file or fix the mapping entry.',
      },
    },
  ];
  return baseResult(issues);
}

describe('check render — --top view', () => {
  it('full view renders the Errors header with true count and every group', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'full' }));
    // The fourErrorResult has 3 unverified issues (each with a distinct aspectId)
    // + 1 mapping-path-missing. Unverified collapses by CODE ONLY → 1 group;
    // mapping-path-missing → 1 group. Total = 2 groups, 4 issues.
    expect(out).toContain('Errors (4) in 2 groups:');
    // Two groups render: one unverified group block + one mapping-path-missing block.
    expect(countBlocks(out)).toBe(2);
    // The three unverified aspects appear as body-line annotations (not in header).
    expect(out).toContain("aspect 'requires-logging'");
    expect(out).toContain("aspect 'requires-audit'");
    expect(out).toContain("aspect 'is-deterministic'");
  });

  it('{kind:top,n:1} renders the true Errors(4) header, exactly one block, and the Next line', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 1 }));
    // Header keeps the TRUE total — a truncated view must never read as fewer errors.
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(1);
    expect(out).toMatch(/\nNext: /);
  });

  it('{kind:top,n:0} (defensive — unreachable via CLI) renders zero blocks plus the empty-section annotation', () => {
    // The CLI never produces n:0 (bare --top maps to 1; explicit "0" is a guided
    // error) — this pins the DEFENSIVE rendering: no group blocks, and the
    // Errors subheader is annotated instead of dangling empty.
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 0 }));
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(0);
    // Annotation beneath the group-less subheader — 4-space indented so
    // block-counting parsers never mistake it for a group block.
    expect(out).toContain('    (no error groups within --top 0 — run yg check for the full list)');
    expect(out).toMatch(/\nNext: /);
    // Exactly one Next line, nothing more.
    expect((out.match(/\nNext: /g) ?? []).length).toBe(1);
  });

  it('{kind:top,n:99} renders all GROUP blocks without crashing (n exceeds group count)', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 99 }));
    expect(out).toContain('Errors (4):');
    // The fourErrorResult has 2 groups (unverified x3 collapses → 1; mapping-path-missing → 1).
    // --top renders at most n GROUPS, so n=99 shows all 2 groups, not 4 individual issues.
    expect(countBlocks(out)).toBe(2);
  });

  it('top view renders the highest-priority block first (unverified before structural)', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 1 }));
    // unverified outranks mapping-path-missing in the §6 cascade.
    expect(out).toContain('unverified');
    expect(out).not.toContain('mapping-path-missing');
  });
});

describe('check render — --summary view', () => {
  it('renders per-node det/LLM split, an "other" bucket, no Why: lines, and the true header', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'summary' }));
    // True header count preserved.
    expect(out).toContain('Errors (4):');
    // auth/auth-api: 1 LLM unverified.
    expect(out).toMatch(/auth\/auth-api\s+1 unverified \(0 deterministic-free, 1 LLM\)/);
    // orders/order-service: 1 LLM + 1 deterministic.
    expect(out).toMatch(/orders\/order-service\s+2 unverified \(1 deterministic-free, 1 LLM\)/);
    // The non-pair structural error lands in the per-node "other" bucket.
    expect(out).toMatch(/users\/missing-service\s+.*1 other/);
    // No per-issue blocks: no Why:/Fix: lines.
    expect(out).not.toContain('Why:');
    expect(out).not.toContain('Fix:');
    // Next line still present.
    expect(out).toMatch(/\nNext: /);
  });

  it('on a green result prints only the PASS header — no rows', () => {
    const green: CheckResult = {
      ...fourErrorResult(),
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
    };
    const out = stripAnsi(formatOutput(green, { kind: 'summary' }));
    expect(out).toContain('yg check: PASS');
    // No per-node rows, no Errors header.
    expect(out).not.toContain('unverified');
    expect(out).not.toContain('Next:');
  });

  // REGRESSION (v5.2.0): a non-pair coverage issue buckets as ONE "other" per
  // issue OBJECT, NOT per uncoveredCount. The header Errors(N) counts each
  // aggregate coverage issue (one unmapped-files issue with uncoveredCount:7) as
  // ONE; the per-node "other" total must reconcile with it. Before the fix the
  // summary added `issue.uncoveredCount` (7), over-counting against the header.
  it('a single unmapped-files issue (uncoveredCount:7) renders "1 other", reconciling with Errors(1)', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-files',
      nodePath: 'lib/widgets',
      uncoveredCount: 7,
      // No pairKind — this is a structural/coverage issue, not a verification pair.
      messageData: {
        what: '7 files under this node are not mapped to any node.',
        why: 'Unmapped files are not verified by any aspect.',
        next: 'Add the files to a node mapping or create a node.',
      },
    };

    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'summary' }));
    // Header counts the issue OBJECT once.
    expect(out).toContain('Errors (1):');
    // Per-node "other" bucket matches the header — ONE, not the 7 uncovered files.
    expect(out).toMatch(/lib\/widgets\s+.*1 other/);
    expect(out).not.toContain('7 other');
  });

  // A file-level (nodeless) pair-derived issue must row under its own file
  // path, never collapse into '(repo)' — that would fold the entire
  // type-covered tier into one undifferentiated row.
  it('a nodeless (type-covered-file) issue rows under its own file path, not (repo)', () => {
    const fileIssue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'own-file-rule',
      pairKind: 'deterministic',
      nodePath: undefined,
      unitKey: 'file:src/leaf/a.ts',
      messageData: unverifiedMessage({ aspectId: 'own-file-rule', unitKey: 'file:src/leaf/a.ts' }),
    } as CheckIssue;
    const out = stripAnsi(formatOutput(baseResult([fileIssue]), { kind: 'summary' }));
    expect(out).toMatch(/src\/leaf\/a\.ts\s+1 unverified \(1 deterministic-free, 0 LLM\)/);
    expect(out).not.toContain('(repo)');
  });

  // '(repo)' keeps its pre-existing meaning: an issue with NEITHER a component
  // NOR a file unit (a stale digest, an unreadable lock).
  it('a genuinely repo-level issue (neither nodePath nor a file unitKey) still rows under (repo)', () => {
    const repoIssue: CheckIssue = {
      severity: 'warning',
      code: 'rules-digest-stale',
      rule: 'rules-digest-stale',
      messageData: { what: 'stale', why: 'y', next: 'yg init --upgrade' },
    } as CheckIssue;
    const out = stripAnsi(formatOutput(baseResult([repoIssue]), { kind: 'summary' }));
    expect(out).toContain('(repo)');
  });
});

describe('check render — Next: residual annotation (task 1.4)', () => {
  it('annotates Next when --approve will not clear all error groups', () => {
    const issues: CheckIssue[] = [
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'x',pairKind:'llm',nodePath:'a',messageData:unverifiedMessage({aspectId:'x',unitKey:'a'})} as CheckIssue,
      {severity:'error',code:'aspect-violation-enforced',rule:'aspect-violation-enforced',aspectId:'y',pairKind:'llm',nodePath:'a',messageData:llmRefusedMessage({aspectId:'y',unitKey:'a',reason:'r'})} as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    expect(out).toMatch(/Next: yg check --approve {2}\(fills 1 unverified; 1 errors? remain/);
  });

  it('does NOT annotate Next when all errors are unverified (--approve will clear all)', () => {
    const issues: CheckIssue[] = [
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'x',pairKind:'llm',nodePath:'a',messageData:unverifiedMessage({aspectId:'x',unitKey:'a'})} as CheckIssue,
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'y',pairKind:'llm',nodePath:'b',messageData:unverifiedMessage({aspectId:'y',unitKey:'b'})} as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    expect(out).toMatch(/\nNext: yg check --approve\n/);
    expect(out).not.toContain('fills');
  });

  it('does NOT annotate Next on a fully-green run (suggestedNext is null)', () => {
    const green: CheckResult = {
      projectName: 'test',
      nodeCount: 1,
      nodeTypeCounts: new Map(),
      aspectCount: 1,
      flowCount: 0,
      coveredFiles: 0,
      totalFiles: 0,
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
      draftSkipped: 0,
      verifiedDet: 0,
      verifiedLlm: 0,
      pairs: [],
    };
    const out = stripAnsi(formatOutput(green));
    expect(out).not.toContain('Next:');
    expect(out).not.toContain('fills');
  });
});

// F1: a pair this SAME run's fill already proved cannot run at all (its
// `messageData.next` names the real remedy, never 'yg check --approve' — see
// core/type-visibility.ts's cannotRunUnverifiedMessage) must never be counted
// as something --approve will "fill", and its group Fix line must never
// repeat the command that just failed on it. Before this fix, both the
// residual annotation and the group's shared Fix line treated every
// `unverified` issue as equally fillable, so a run reporting "1 cannot run"
// in its type-coverage block would, two sections later, still say
// "Fix: yg check --approve" for that exact pair and promise re-running it
// would "fill" it.
describe('check render — Next: residual annotation excludes a pair this run proved cannot run (F1)', () => {
  const cannotRunNext =
    'Give the file a component of its own (a yg-node.yaml mapping it), or fix what the reason above names in check.mjs / yg-architecture.yaml — not another --approve.';

  it('does not count a "cannot run" unverified pair toward the fillable N — it folds into K (needs a code/graph fix) instead', () => {
    const issues: CheckIssue[] = [
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'fillable-x',pairKind:'deterministic',nodePath:'a',messageData:unverifiedMessage({aspectId:'fillable-x',unitKey:'a'})} as CheckIssue,
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'needs-node-context',pairKind:'deterministic',nodePath:undefined,unitKey:'file:src/crashy/a.ts',messageData:{what:'w',why:'y',next:cannotRunNext}} as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    expect(out).toMatch(/Next: yg check --approve {2}\(fills 1 unverified; 1 error remain — need code\/graph fixes\)/);
  });

  it('the group Fix line names the real remedy for a cannot-run member instead of repeating the shared --approve line', () => {
    const issues: CheckIssue[] = [
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'fillable-x',pairKind:'deterministic',nodePath:'a',messageData:unverifiedMessage({aspectId:'fillable-x',unitKey:'a'})} as CheckIssue,
      {severity:'error',code:'unverified',rule:'unverified',aspectId:'needs-node-context',pairKind:'deterministic',nodePath:undefined,unitKey:'file:src/crashy/a.ts',messageData:{what:'w',why:'y',next:cannotRunNext}} as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    // The generic Fix line appears exactly once — for the fillable member.
    expect((out.match(/Fix: yg check --approve/g) ?? []).length).toBe(1);
    // The cannot-run member gets its own remedy instead, not a second copy
    // of the command this run already proved does nothing for it.
    expect(out).toContain('Fix: Give the file a component of its own');
  });
});

describe('resolveTopValue', () => {
  const cases: Array<[boolean | string | undefined, number | null]> = [
    [undefined, 0],
    [true, 1],        // bare --top → the single suggested-next group
    ['1', 1],
    ['5', 5],
    ['99', 99],
    ['0', null],      // explicit "0" is garbage — bare --top (→ 1) is the single-group path
    ['-2', null],
    ['abc', null],
    ['1.5', null],
    ['', null],
    [false, null],
  ];
  for (const [raw, expected] of cases) {
    it(`maps ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(resolveTopValue(raw)).toBe(expected);
    });
  }

  it('confirms a CheckView union shape is accepted by formatOutput', () => {
    const views: CheckView[] = [{ kind: 'full' }, { kind: 'top', n: 2 }, { kind: 'summary' }];
    for (const v of views) {
      expect(() => formatOutput(fourErrorResult(), v)).not.toThrow();
    }
  });
});

// ── Aspect drill-in view: --aspect <id> (task 2.2) ────────────────────────────

describe('check render — --aspect drill-in view (task 2.2)', () => {
  /** Build issues: 2 errors on aspect 'x' (nodes 'node-a', 'node-b'), 1 error on aspect 'y' (node 'node-c'). */
  function aspectDrillIssues(): CheckIssue[] {
    return [
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'node-a',
        messageData: llmRefusedMessage({ aspectId: 'x', unitKey: 'node-a#x', reason: 'missing entry A' }),
      } as CheckIssue,
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'node-b',
        messageData: llmRefusedMessage({ aspectId: 'x', unitKey: 'node-b#x', reason: 'missing entry B' }),
      } as CheckIssue,
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'y',
        pairKind: 'llm',
        nodePath: 'node-c',
        messageData: llmRefusedMessage({ aspectId: 'y', unitKey: 'node-c#y', reason: 'y issue' }),
      } as CheckIssue,
    ];
  }

  it('filters to aspect x: contains "aspect x", shows 2 of 3 errors, no y-issue content', () => {
    const out = stripAnsi(formatOutput(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' }));
    // Header must mention the aspect id and K of N counts.
    expect(out).toContain("aspect 'x'");
    expect(out).toContain('2 of 3 errors');
    // y-issue content must NOT appear.
    expect(out).not.toContain('node-c');
    expect(out).not.toContain('y issue');
    // Both x-nodes must appear.
    expect(out).toContain('node-a');
    expect(out).toContain('node-b');
    // Next (this group): line must be present.
    expect(out).toMatch(/\nNext \(this group\): /);
  });

  it('drill-in uses isTTY:false — no truncation even when members exceed CAP_NODES', () => {
    // Build 15 issues on aspect 'x' — exceeds the CAP_NODES=12 truncation threshold.
    const manyIssues: CheckIssue[] = Array.from({ length: 15 }, (_, i) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'x',
      pairKind: 'llm',
      nodePath: `node-${i}`,
      messageData: llmRefusedMessage({ aspectId: 'x', unitKey: `node-${i}#x`, reason: `reason-${i}` }),
    } as CheckIssue));
    const out = stripAnsi(formatOutput(baseResult(manyIssues), { kind: 'aspect', id: 'x' }));
    // All 15 nodes must appear — no "... and N more" truncation.
    for (let i = 0; i < 15; i++) {
      expect(out).toContain(`node-${i}`);
    }
    expect(out).not.toContain('... and');
  });

  it('exit code logic is outside formatOutput — aspect view does not affect it', () => {
    // This is a contract test: formatOutput must not throw or return empty on aspect view.
    // The actual exit code (derived from full result.issues) is tested at the CLI action layer.
    const out = formatOutput(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' });
    expect(out.length).toBeGreaterThan(0);
  });

  // Fix 6(b): an aspect with ZERO issues this run, while OTHER errors exist, must
  // still surface a global Next — the early return on the empty drill-in used to
  // dead-end the agent with no next step.
  it('aspect with zero matching issues falls through to a global Next when other errors exist', () => {
    // aspectDrillIssues() has errors on aspects x and y (none on 'z'). The global
    // result has a suggestedNext (baseResult sets it because there ARE errors).
    const out = stripAnsi(formatOutput(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'z' }));
    // Header still names the requested aspect and shows 0 of N.
    expect(out).toContain("aspect 'z'");
    expect(out).toContain('0 of 3 errors');
    // No drill-in "Next (this group):" line (there are no matching issues)…
    expect(out).not.toMatch(/Next \(this group\):/);
    // …but a GLOBAL Next must still point the agent somewhere (no dead-end).
    expect(out).toMatch(/\nNext: /);
  });

  it('aspect with matching issues keeps the "Next (this group):" form (no global Next)', () => {
    const out = stripAnsi(formatOutput(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' }));
    // Matching issues → the drill-in group-scoped Next is used.
    expect(out).toMatch(/Next \(this group\): /);
    // …and NOT the global Next form (avoid double-messaging).
    expect(out).not.toMatch(/\nNext: /);
  });

  // The drill-in "Next (this group):" pointer must name the HIGHEST-PRIORITY
  // filtered issue's next, per the same cascade computeSuggestedNext uses — NOT
  // the first issue in emission order. Here an enforced refusal (rank 3) is
  // emitted BEFORE an unverified pair (rank 2) on the same aspect, so a naive
  // array-order pick would point at the refusal's "Three exits" text instead of
  // the unverified pair's "yg check --approve".
  it('drill-in Next points at the highest-priority issue, not the first-emitted one', () => {
    const mixedPriorityIssues: CheckIssue[] = [
      // Emitted FIRST but LOWER priority (enforced refusal, rank 3).
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'node-a',
        messageData: llmRefusedMessage({ aspectId: 'x', unitKey: 'node-a#x', reason: 'missing entry A' }),
      } as CheckIssue,
      // Emitted SECOND but HIGHER priority (unverified, rank 2).
      {
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'node-b',
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: 'node-b#x' }),
      } as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(mixedPriorityIssues), { kind: 'aspect', id: 'x' }));
    // The pointer must be the unverified pair's next ('yg check --approve'), NOT
    // the enforced refusal's 'Three exits:' text.
    expect(out).toMatch(/\nNext \(this group\): yg check --approve/);
    expect(out).not.toMatch(/\nNext \(this group\): Three exits:/);
  });
});

// ── --top GROUP-based rendering (task 2.3) ────────────────────────────────────

/**
 * Build a result with 4 DISTINCT error groups:
 *   1. unverified (aspect x)         — code-only group (CODE_ONLY_GROUP_CODES)
 *   2. aspect-violation-enforced (y) — refused enforced, aspect y
 *   3. aspect-violation-enforced (z) — refused enforced, aspect z
 *   4. relation-undeclared-dependency (no aspectId) — structural
 *
 * Priority order (issuePriorityRank): unverified (rank 2) < enforced (rank 3)
 * < relation (unranked ERROR, rank = ERROR_CODE_PRIORITY.length=10).
 * So groups in order: unverified → aspect y → aspect z → relation.
 */
function fourGroupErrorResult(): CheckResult {
  const issues: CheckIssue[] = [
    // Group 1: unverified (code-only group — collapses by code, regardless of aspect)
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'auth/handler',
      aspectId: 'aspect-x',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'aspect-x', unitKey: 'auth/handler#aspect-x' }),
    } as CheckIssue,
    // Group 2: refused enforced, aspect y
    {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'aspect-y',
      pairKind: 'llm',
      nodePath: 'orders/service',
      messageData: llmRefusedMessage({ aspectId: 'aspect-y', unitKey: 'orders/service#aspect-y', reason: 'missing audit on aspect y' }),
    } as CheckIssue,
    // Group 3: refused enforced, aspect z
    {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'aspect-z',
      pairKind: 'llm',
      nodePath: 'billing/service',
      messageData: llmRefusedMessage({ aspectId: 'aspect-z', unitKey: 'billing/service#aspect-z', reason: 'missing validation on aspect z' }),
    } as CheckIssue,
    // Group 4: relation-undeclared-dependency (structural, no aspectId)
    {
      severity: 'error',
      code: 'relation-undeclared-dependency',
      rule: 'relation-undeclared-dependency',
      nodePath: 'payments/processor',
      messageData: {
        what: 'payments/processor depends on billing/service but has no declared relation.',
        why: 'Every statically-resolvable cross-node dependency must be declared as a relation.',
        next: 'Add a relation entry in payments/processor/yg-node.yaml.',
      },
    } as CheckIssue,
  ];
  return {
    ...baseResult(issues),
    // All 4 issues are errors; suggestedNext points at highest-priority (unverified).
    suggestedNext: 'yg check --approve',
  };
}
describe('check render — --top GROUP view (task 2.3)', () => {
  it('{kind:top,n:2} renders exactly 2 group blocks, the true Errors(4) header, and a Next line', () => {
    const result = fourGroupErrorResult();
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 2 }));
    // TRUE header — never truncated.
    expect(out).toContain('Errors (4):');
    // Exactly 2 GROUP blocks rendered (not 2 individual issues).
    expect(countBlocks(out)).toBe(2);
    // Next line always present.
    expect(out).toMatch(/\nNext: /);
  });

  it('{kind:top,n:2} shows the 2 highest-priority groups (unverified, aspect-y) and NOT the lower ones', () => {
    const result = fourGroupErrorResult();
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 2 }));
    // Group 1 (unverified, highest priority) must appear.
    expect(out).toContain('unverified (not yet reviewed)');
    // Group 2 (aspect-violation-enforced aspect-y, second priority) must appear.
    expect(out).toContain("aspect 'aspect-y'");
    // Group 3 (aspect-z) must NOT appear.
    expect(out).not.toContain("aspect 'aspect-z'");
    // Group 4 (relation-undeclared-dependency) must NOT appear.
    expect(out).not.toContain('relation-undeclared-dependency');
  });

  it('{kind:top,n:0} (defensive) renders zero group blocks, the annotated subheader, and Next', () => {
    // n:0 is unreachable via the CLI (bare --top → 1, explicit "0" → guided
    // error); pins the defensive path: annotated subheader, no dangling header.
    const result = fourGroupErrorResult();
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 0 }));
    // TRUE header present.
    expect(out).toContain('Errors (4):');
    // Zero group blocks — the annotation must NOT register as a block.
    expect(countBlocks(out)).toBe(0);
    expect(out).toContain('    (no error groups within --top 0 — run yg check for the full list)');
    // Next line still present.
    expect(out).toMatch(/\nNext: /);
    // Exactly one Next line.
    expect((out.match(/\nNext: /g) ?? []).length).toBe(1);
  });

  it('{kind:top,n:1} with errors AND warnings: warning subheader is annotated, not left dangling', () => {
    // Add an advisory (warning) unverified pair on top of the 4 error groups.
    // --top 1 slices [error groups..., warning groups...] at 1 → only the top
    // ERROR group renders; the Warnings section keeps its TRUE count but has
    // no chosen group, so it must carry the annotation instead of a bare header.
    const base = fourGroupErrorResult();
    const warning: CheckIssue = {
      severity: 'warning',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'notify/mailer',
      aspectId: 'aspect-adv',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'aspect-adv', unitKey: 'notify/mailer#aspect-adv' }),
    } as CheckIssue;
    const result: CheckResult = { ...base, issues: [...base.issues, warning] };
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 1 }));
    // TRUE aggregate counts for BOTH severities stay visible.
    expect(out).toContain('Errors (4):');
    expect(out).toContain('Warnings (1):');
    // Exactly ONE group block rendered (the suggested-next error group).
    expect(countBlocks(out)).toBe(1);
    // The Errors section has a body, so it is NOT annotated.
    expect(out).not.toContain('(no error groups within --top 1');
    // The Warnings section is annotated instead of dangling empty.
    expect(out).toContain('    (no warning groups within --top 1 — run yg check for the full list)');
    expect(out).toMatch(/\nNext: /);
  });

  it('{kind:top,n:4} renders all 4 groups when n equals group count', () => {
    const result = fourGroupErrorResult();
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 4 }));
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(4);
    // All four group labels present.
    expect(out).toContain('unverified (not yet reviewed)');
    expect(out).toContain("aspect 'aspect-y'");
    expect(out).toContain("aspect 'aspect-z'");
    expect(out).toContain('relation-undeclared-dependency');
  });
});

// ── Zero-classifying-types notice (coverage.type_level on, no `when:` anywhere) ──

describe('check render — zero-classifying-types notice', () => {
  const NOTICE =
    "Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — no file can be type-covered until you add classifying types.";

  it('flag ON, zero classifying types: prints the standing notice', () => {
    const result: CheckResult = {
      ...baseResult([]),
      typeLevel: true,
      classifyingTypeCount: 0,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain(NOTICE);
  });

  it('flag ON, at least one classifying type: no notice', () => {
    const result: CheckResult = {
      ...baseResult([]),
      typeLevel: true,
      classifyingTypeCount: 2,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).not.toContain('Type-level coverage is on');
  });

  it('flag OFF: no notice even with zero classifying types', () => {
    const result: CheckResult = {
      ...baseResult([]),
      typeLevel: false,
      classifyingTypeCount: 0,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).not.toContain('Type-level coverage is on');
  });
});

// ── --top coverage issue dispatch (task 2.3 fix) ─────────────────────────────

describe('check render — --top view: coverage issues (task 2.3 fix)', () => {
  it('{kind:top,n:1} with unmapped-files error renders via renderUnmappedBlock, not renderGroup', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-files',
      uncoveredFiles: ['src/a.ts', 'src/b.ts'],
      uncoveredCount: 2,
      messageData: {
        what: '2 files are not mapped to any node.',
        why: 'Unmapped files are not verified by any aspect.',
        next: 'Add the files to a node mapping or create a new node.',
      },
    };
    const result = baseResult([issue]);
    const out = stripAnsi(formatOutput(result, { kind: 'top', n: 1 }));

    // renderUnmappedBlock produces "  unmapped (2)" — count label present.
    expect(out).toContain('unmapped (2)');
    // File list from uncoveredFiles must appear.
    expect(out).toContain('src/a.ts');
    // renderGroup header pattern ("N pairs  N nodes") must NOT appear.
    expect(out).not.toMatch(/\d+ pairs\s+\d+ nodes/);
    // renderGroup member line pattern ("- ") for an empty nodePath must NOT appear.
    expect(out).not.toMatch(/^\s*- \s*$/m);
  });
});

// ── --top view: the two halves of a split coverage finding ───────────────────

/**
 * Under a change scope the aggregate coverage finding is split in two. Before
 * the halves carried DISTINCT codes, both would have keyed the same group in
 * `groupIssues` (which keys by code alone when there is no aspect), and the
 * `--top` view — which deliberately renders coverage inside its cascade rather
 * than excluding it — would have rendered `members[0]` and silently dropped the
 * other half, with array order deciding which one survived. These pin that the
 * twin codes really do keep the two halves visible as separate blocks, through
 * the actual view rather than by inspection of the grouping key.
 */
describe('check render — --top view: a split coverage finding', () => {
  /** The aggregate coverage finding exactly as the coverage phase emits it. */
  const aggregate = (): CheckIssue => ({
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    uncoveredFiles: ['src/in-diff.ts', 'src/inherited-a.ts', 'src/inherited-b.ts'],
    uncoveredCount: 3,
    messageData: {
      what: '3 source files not covered by any node.\n  src/in-diff.ts\n  src/inherited-a.ts\n  src/inherited-b.ts',
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: 'Check ownership candidates: yg context --file <path>',
    },
  });

  // The halves themselves are built by the real split, not by hand: it is the
  // split's own output the view has to keep separable.
  const halves = (): CheckIssue[] =>
    applyChangeScope(
      [aggregate()],
      {
        global: false,
        pairKeys: new Set(),
        nodePaths: new Set(),
        files: new Set(['src/in-diff.ts']),
        logOnlyNodePaths: new Set(),
        changedInputCount: 1,
      },
      [],
    );

  it('renders BOTH halves, each naming only its own files', () => {
    const issues = halves();
    expect(issues.map((i) => i.code)).toEqual(['unmapped-files', 'unmapped-files-outside']);
    const out = stripAnsi(formatOutput(baseResult(issues), { kind: 'top', n: 5 }));
    expect(out).toContain('src/in-diff.ts');
    expect(out).toContain('src/inherited-a.ts');
    expect(out).toContain('src/inherited-b.ts');
    // The blocking half keeps the compact file-list block with its own count…
    expect(out).toContain('unmapped (1)');
    // …and the two halves never read as the same thing: only one of them is
    // this change's business, and the label says which.
    expect(out).toContain('unmapped (outside changes) (2)');
  });

  it('keeps the halves under their own severity sections', () => {
    const out = stripAnsi(formatOutput(baseResult(halves()), { kind: 'top', n: 5 }));
    const errorAt = out.indexOf('Errors (1):');
    const warningAt = out.indexOf('Warnings (1):');
    expect(errorAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(errorAt);
    // The blocking half's file is disclosed above the warnings subheader; the
    // inherited half's files below it.
    expect(out.indexOf('src/in-diff.ts')).toBeLessThan(warningAt);
    expect(out.indexOf('src/inherited-a.ts')).toBeGreaterThan(warningAt);
  });

  it('renders the reverse order identically — no array-order accident', () => {
    const [inDiff, outside] = halves();
    const forward = stripAnsi(formatOutput(baseResult([inDiff, outside]), { kind: 'top', n: 5 }));
    const reversed = stripAnsi(formatOutput(baseResult([outside, inDiff]), { kind: 'top', n: 5 }));
    expect(reversed).toBe(forward);
  });
});

// ── Every view discloses the inherited half's file list ─────────────────────

/**
 * The file list IS a coverage finding — its `what` carries the count on line 1
 * and the filenames beneath. A view that routes the finding to the generic
 * block renderer shows line 1 only, so the finding renders as a bare number
 * with every filename gone. That is what happened to the inherited half in the
 * details view while the same half rendered correctly elsewhere.
 */
describe('check render — the inherited coverage half in every view', () => {
  const inherited = (): CheckIssue[] =>
    applyChangeScope(
      [
        {
          severity: 'error',
          code: 'unmapped-files',
          rule: 'unmapped-file',
          uncoveredFiles: ['src/inherited-a.ts', 'src/inherited-b.ts'],
          uncoveredCount: 2,
          messageData: {
            what: '2 source files not covered by any node.\n  src/inherited-a.ts\n  src/inherited-b.ts',
            why: 'Files without graph coverage cannot be modified under the protocol.',
            next: 'Check ownership candidates: yg context --file <path>',
          },
        },
      ],
      {
        global: false,
        pairKeys: new Set(),
        nodePaths: new Set(),
        files: new Set(),
        logOnlyNodePaths: new Set(),
        changedInputCount: 0,
      },
      [],
    );

  it('produces exactly one inherited half, and nothing blocking', () => {
    const issues = inherited();
    expect(issues.map((i) => i.code)).toEqual(['unmapped-files-outside']);
    expect(issues[0].severity).toBe('warning');
  });

  for (const view of [{ kind: 'full' }, { kind: 'details' }, { kind: 'top', n: 5 }] as CheckView[]) {
    it(`names both inherited files in the ${view.kind} view`, () => {
      const out = stripAnsi(formatOutput(baseResult(inherited()), view));
      expect(out).toContain('src/inherited-a.ts');
      expect(out).toContain('src/inherited-b.ts');
      // …and as a compact coverage block, not as a truncated one-line summary,
      // marked as the change's inheritance rather than its business — the two
      // halves of one split finding must not share a label.
      expect(out).toContain('unmapped (outside changes) (2)');
    });
  }

  it('does not call the inherited half "uncovered" — that is the advisory tier', () => {
    const out = stripAnsi(formatOutput(baseResult(inherited()), { kind: 'full' }));
    expect(out).not.toContain('uncovered (2)');
  });
});
