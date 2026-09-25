import { describe, it, expect } from 'vitest';
import { formatOutput, resolveTopValue, enrichCheckJson } from '../../../src/cli/check-render-views.js';
import type { CheckView } from '../../../src/cli/check-render-views.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
} from '../../../src/formatters/lock-issue-messages.js';
import { applyChangeScope } from '../../../src/core/check-progressive.js';
import { computeSuggestedNext } from '../../../src/core/check.js';
import { buildCheckJson } from '../../../src/core/check-json.js';

/** Strip ANSI color codes so line matching is deterministic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** The heading lines of a report: one per finding block. */
function headings(out: string): string[] {
  return stripAnsi(out).split('\n').filter((l) => /^(error|warning)\[/.test(l));
}

/** The `next:` and `then:` lines of a report. */
function steps(out: string): string[] {
  return stripAnsi(out).split('\n').filter((l) => /^(next|then): /.test(l));
}

/** A report, undecorated. */
function render(result: CheckResult, view: CheckView = { kind: 'full' }): string {
  return stripAnsi(formatOutput(result, view, false, false));
}

/**
 * Unit tests for the `yg check` view-selection render layer
 * (check-render-views.ts): the top-level `formatOutput` dispatcher and the
 * --summary/--top/--aspect/--details views, the `next:`/`then:` composition,
 * and `resolveTopValue`. These exercise the rendering directly against
 * constructed CheckResult objects — no spawned binary, no build — so they pin
 * the agent-facing OUTPUT contract: every view renders the same verdict line
 * with the TRUE error/warning counts, and a truncated view must never read as
 * a clean build over errors it merely declined to print.
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

describe('check render — next line surfacing', () => {
  /** A result whose only issue is an advisory aspect-violation warning — the warnings-only PASS case. */
  function warningsOnlyResult(): CheckResult {
    const advWarning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason: 'missing audit entry',
      }),
    };
    return { ...baseResult([advWarning]), suggestedNext: advWarning.messageData.next, advisoryWarnings: 1 };
  }

  it('renders a next line on a warnings-only PASS', () => {
    const out = render(warningsOnlyResult());
    // Still a PASS (warnings never fail the verdict)…
    expect(out.split('\n')[0]).toBe('yg check: PASS  1 warning   1 node');
    // …and the step is surfaced, not silently dropped.
    expect(out).toMatch(/\nnext: /);
  });

  it('omits the next line on a fully-green run', () => {
    const green: CheckResult = { ...warningsOnlyResult(), issues: [], suggestedNext: null, advisoryWarnings: 0 };
    const out = render(green);
    expect(out).toContain('yg check: PASS');
    // A clean run is self-evidently done — no invented next line.
    expect(out).not.toContain('next:');
  });

  it('renders a next line on a failing run with more than one block', () => {
    const out = render(fourErrorResult());
    expect(out).toContain('yg check: FAIL');
    expect(out).toMatch(/\nnext: /);
  });

  it('a single block whose fix IS the step prints the step once, in its fix:, and no next line', () => {
    const out = render(baseResult([
      {
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        nodePath: 'orders/handler',
        aspectId: 'audit-logging',
        pairKind: 'llm',
        messageData: unverifiedMessage({
          aspectId: 'audit-logging',
          unitKey: 'orders/handler#audit-logging',
        }),
      },
    ]));
    expect(out).toContain('yg check: FAIL');
    expect(out).toContain('  fix:  yg check --approve  (1 reviewer pair · paid — ask the user to approve it first)');
    expect(out).not.toContain('next:');
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
  it('full view renders the true count and every block', () => {
    const out = render(fourErrorResult(), { kind: 'full' });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  4 errors   1 node');
    // Unverified collapses by CODE → 1 block; mapping-path-missing → 1 block.
    expect(headings(out)).toHaveLength(2);
    // The three unverified pairs are named on the member lines, not in the heading.
    expect(out).toContain('requires-logging @ auth/auth-api');
    expect(out).toContain('requires-audit @ orders/order-service');
    expect(out).toContain('is-deterministic @ orders/order-service');
  });

  it('{kind:top,n:1} keeps the true count, renders exactly one block, counts the rest, and keeps next', () => {
    const out = render(fourErrorResult(), { kind: 'top', n: 1 });
    // The verdict keeps the TRUE total — a truncated view must never read as fewer errors — and names the view.
    expect(out.split('\n')[0]).toBe('yg check: FAIL  4 errors   1 node   view: top 1');
    expect(headings(out)).toHaveLength(1);
    expect(out).toContain('… +1 more block  (yg check)');
    expect(out).toMatch(/\nnext: /);
  });

  it('{kind:top,n:0} (defensive — unreachable via CLI) renders zero blocks, counts them, and one next', () => {
    // The CLI never produces n:0 (bare --top maps to 1; explicit "0" is a guided error).
    const out = render(fourErrorResult(), { kind: 'top', n: 0 });
    expect(out.split('\n')[0]).toContain('4 errors');
    expect(headings(out)).toHaveLength(0);
    expect(out).toContain('… +2 more blocks  (yg check)');
    expect((out.match(/\nnext: /g) ?? []).length).toBe(1);
  });

  it('{kind:top,n:99} renders every block without crashing (n exceeds block count)', () => {
    const out = render(fourErrorResult(), { kind: 'top', n: 99 });
    expect(out.split('\n')[0]).toContain('4 errors');
    // --top renders at most n BLOCKS: n=99 shows both, not 4 individual issues.
    expect(headings(out)).toHaveLength(2);
    expect(out).not.toContain('more block');
  });

  it('top view renders the highest-tier block first (a code or graph error before pending pairs), and next points at it', () => {
    const out = render(fourErrorResult(), { kind: 'top', n: 1 });
    expect(headings(out)).toEqual(["error[mapping-path-missing] Mapping path 'src/users/missing.service.ts' does not exist on disk"]);
    expect(out).not.toContain('error[unverified]');
    // next never names the fill while a code or graph error stands; then: does.
    expect(steps(out)).toEqual([
      'next: Create the file or fix the mapping entry  (mapping-path-missing)',
      'then: yg check --approve  (1 script pair · free + 2 reviewer pairs · paid — ask the user to approve it first)',
    ]);
  });
});

describe('check render — --summary view', () => {
  it('renders one line per severity, each label with its count and the script/reviewer split, no blocks, and the true verdict', () => {
    const out = render(fourErrorResult(), { kind: 'summary' });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  4 errors   1 node   view: summary');
    expect(out).toContain('errors    mapping-path-missing 1 · unverified 3 (1 script · 2 reviewer)');
    // No per-finding blocks: no headings, no why:/fix: fields.
    expect(headings(out)).toHaveLength(0);
    expect(out).not.toContain('why:');
    expect(out).not.toContain('fix:');
    // The step is still there.
    expect(out).toMatch(/\nnext: /);
  });

  it('--summary by node renders one row per node, each label with its count, busiest first', () => {
    const out = render(fourErrorResult(), { kind: 'summary', by: 'nodes' });
    expect(out.split('\n')[0]).toContain('view: summary by node');
    expect(out).toMatch(/\norders\/order-service\s+unverified 2\n/);
    expect(out).toMatch(/\nauth\/auth-api\s+unverified 1\n/);
    expect(out).toMatch(/\nusers\/missing-service\s+mapping-path-missing 1\n/);
    expect(out.indexOf('orders/order-service')).toBeLessThan(out.indexOf('auth/auth-api'));
  });

  it('on a green result prints only the PASS verdict — no rows', () => {
    const green: CheckResult = { ...fourErrorResult(), issues: [], suggestedNext: null, advisoryWarnings: 0 };
    for (const view of [{ kind: 'summary' }, { kind: 'summary', by: 'nodes' }] as CheckView[]) {
      const out = render(green, view);
      expect(out).toContain('yg check: PASS');
      expect(out).not.toContain('unverified');
      expect(out).not.toMatch(/^errors|^warnings/m);
      expect(out).not.toContain('next:');
    }
  });

  // A coverage finding counts in the noun its block counts in — files — in
  // both summary shapes, the same number its block heading states; the verdict
  // line keeps counting the finding once.
  it('a single unmapped-files issue (uncoveredCount:7) counts its 7 files under its label, beside a verdict of 1 error', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-files',
      nodePath: 'lib/widgets',
      uncoveredCount: 7,
      messageData: {
        what: '7 files under this node are not mapped to any node.',
        why: 'Unmapped files are not verified by any aspect.',
        next: 'Add the files to a node mapping or create a node.',
      },
    };
    const out = render(baseResult([issue]), { kind: 'summary' });
    expect(out.split('\n')[0]).toContain('1 error');
    expect(out).toContain('errors    unmapped 7');
    expect(render(baseResult([issue]), { kind: 'summary', by: 'nodes' })).toMatch(/lib\/widgets\s+unmapped 7/);
    expect(render(baseResult([issue]))).toContain('error[unmapped] 7 files belong to no node');
  });

  // A file-level (nodeless) pair-derived issue must row under its own file
  // path, never collapse into '(repository)' — that would fold the entire
  // type-covered tier into one undifferentiated row.
  it('a nodeless (type-covered-file) issue rows under its own file path, not (repository)', () => {
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
    const out = render(baseResult([fileIssue]), { kind: 'summary', by: 'nodes' });
    expect(out).toMatch(/\nsrc\/leaf\/a\.ts\s+unverified 1\n/);
    expect(out).not.toContain('(repository)');
  });

  // '(repository)': an issue with NEITHER a component NOR a file unit (a stale
  // digest, an unreadable lock).
  it('a genuinely repo-level issue (neither nodePath nor a file unitKey) rows under (repository)', () => {
    const repoIssue: CheckIssue = {
      severity: 'warning',
      code: 'rules-digest-stale',
      rule: 'rules-digest-stale',
      messageData: { what: 'stale', why: 'y', next: 'yg init --upgrade' },
    } as CheckIssue;
    const out = render(baseResult([repoIssue]), { kind: 'summary', by: 'nodes' });
    expect(out).toMatch(/\n\(repository\)\s+rules-digest-stale 1\n/);
  });

  // A finding put outside the change must never be indistinguishable from
  // real, in-scope debt at a glance: it counts under its own -outside label.
  it('gives a finding put outside the change its own label', () => {
    const outsideIssue: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-enforced-outside',
      rule: 'aspect-violation-enforced',
      nodePath: 'legacy/reporting',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'legacy/reporting#audit-logging',
        reason: 'inherited from the reference branch',
      }),
    } as CheckIssue;
    const out = render(baseResult([outsideIssue]), { kind: 'summary' });
    expect(out.split('\n')[0]).toContain('1 warning');
    expect(out).toContain('warnings  refused-outside 1');
    expect(render(baseResult([outsideIssue]), { kind: 'summary', by: 'nodes' })).toMatch(/legacy\/reporting\s+refused-outside 1/);
  });

  // The per-node totals still have to reconcile with the verdict line even once
  // a node carries BOTH an inherited twin AND a genuine warning of its own.
  it('reconciles per-node totals when a node carries both an outside twin and a genuine warning', () => {
    const issues: CheckIssue[] = [
      {
        severity: 'warning', code: 'aspect-violation-enforced-outside', rule: 'aspect-violation-enforced',
        nodePath: 'legacy/reporting', aspectId: 'audit-logging', pairKind: 'llm',
        messageData: llmRefusedMessage({ aspectId: 'audit-logging', unitKey: 'legacy/reporting#audit-logging', reason: 'inherited' }),
      } as CheckIssue,
      {
        severity: 'warning', code: 'aspect-violation-advisory', rule: 'aspect-violation-advisory',
        nodePath: 'legacy/reporting', aspectId: 'style-guide', pairKind: 'llm',
        messageData: llmRefusedMessage({ aspectId: 'style-guide', unitKey: 'legacy/reporting#style-guide', reason: 'style nit' }),
      } as CheckIssue,
    ];
    expect(render(baseResult(issues), { kind: 'summary' })).toContain('warnings  refused 1 · refused-outside 1');
    const out = render(baseResult(issues), { kind: 'summary', by: 'nodes' });
    expect(out.split('\n')[0]).toContain('2 warnings');
    expect(out).toMatch(/\nlegacy\/reporting\s+refused-outside 1 · refused 1\n/);
  });
});

describe('check render — next: never a fill while a code error stands, then: names it', () => {
  /** A script refusal located at a line, on a rule of its own. */
  const detRefusal = (aspect: string, file: string): CheckIssue => ({
    severity: 'error', code: 'aspect-violation-enforced', rule: 'aspect-violation-enforced', aspectId: aspect, pairKind: 'deterministic', nodePath: 'svc/a',
    messageData: detRefusedMessage({ aspectId: aspect, unitKey: 'node:svc/a', reason: `${file}:3: forbidden` }),
  } as CheckIssue);
  const pending = (aspect: string, node: string): CheckIssue => ({
    severity: 'error', code: 'unverified', rule: 'unverified', aspectId: aspect, pairKind: 'llm', nodePath: node,
    messageData: unverifiedMessage({ aspectId: aspect, unitKey: node }),
  } as CheckIssue);

  it('points next at the code fix, annotates what else needs one, and names the fill in then:', () => {
    const issues = [pending('x', 'svc/a'), detRefusal('y', 'src/a.ts'), detRefusal('z', 'src/b.ts')];
    const out = render(baseResult(issues));
    expect(steps(out)).toEqual([
      'next: edit src/a.ts:3  (refused — 2 errors need a code or graph fix)',
      'then: yg check --approve  (1 reviewer pair · paid — ask the user to approve it first)',
    ]);
    // The same step as data: what remains after it.
    const r = baseResult(issues);
    const doc = enrichCheckJson(buildCheckJson(r), r);
    expect(doc.next?.remaining).toEqual({ needsFix: 2, fillable: 1, needsUser: 0, waitingOnReviewer: 0 });
    expect(doc.next?.then).toBe('yg check --approve  (1 reviewer pair · paid — ask the user to approve it first)');
    expect(doc.suggestedNext).toBe('edit src/a.ts:3  (refused — 2 errors need a code or graph fix)');
  });

  it('an LLM refusal\'s next is never the bare re-run its own fix says changes nothing', () => {
    // The refusal is final for this exact code; `yg check --approve` alone
    // re-records nothing. Its first step is the code (or the rule) — the fill
    // comes after.
    const refused: CheckIssue = {
      severity: 'error', code: 'aspect-violation-enforced', rule: 'aspect-violation-enforced', aspectId: 'y', pairKind: 'llm', nodePath: 'svc/a',
      messageData: llmRefusedMessage({ aspectId: 'y', unitKey: 'svc/a', reason: 'r' }),
    } as CheckIssue;
    const out = render(baseResult([pending('x', 'svc/a'), refused]));
    const [nextLine] = steps(out);
    expect(nextLine).toMatch(/^next: /);
    expect(nextLine).not.toMatch(/^next: yg check --approve\b/);
  });

  it('when every error is a pending pair, the one block\'s fix is the step: no next, and nothing needs a code fix', () => {
    const out = render(baseResult([pending('x', 'svc/a'), pending('y', 'svc/b')]));
    expect(out).toContain('  fix:  yg check --approve  (2 reviewer pairs · paid — ask the user to approve it first)');
    expect(out).not.toContain('next:');
    expect(out).not.toContain('need a code or graph fix');
  });

  it('prints no step on a fully-green run', () => {
    const out = render(baseResult([]));
    expect(out).not.toContain('next:');
    expect(out).not.toContain('then:');
  });
});

// F1: a pair this SAME run's fill already proved cannot run at all (its
// `messageData.next` names the real remedy, never 'yg check --approve' — see
// core/type-visibility.ts's cannotRunUnverifiedMessage) must never be counted
// as something --approve will fill, and its fix must never repeat the command
// that just failed on it.
describe('check render — a pair this run proved cannot run is never counted as fillable (F1)', () => {
  const cannotRunNext =
    'Give the file a component of its own (a yg-node.yaml mapping it), or fix what the reason above names in check.mjs / yg-architecture.yaml — not another --approve.';
  const issues = (): CheckIssue[] => [
    {severity:'error',code:'unverified',rule:'unverified',aspectId:'fillable-x',pairKind:'deterministic',nodePath:'svc/a',messageData:unverifiedMessage({aspectId:'fillable-x',unitKey:'svc/a'})} as CheckIssue,
    {severity:'error',code:'unverified',rule:'unverified',aspectId:'needs-node-context',pairKind:'deterministic',nodePath:undefined,unitKey:'file:src/crashy/a.ts',messageData:{what:'w',why:'y',next:cannotRunNext}} as CheckIssue,
  ];

  it('does not count a "cannot run" pair toward the fillable count — it needs a code or graph fix instead', () => {
    const r = baseResult(issues());
    const doc = enrichCheckJson(buildCheckJson(r), r);
    expect(doc.next?.remaining.fillable).toBe(1);
    expect(doc.next?.remaining.needsFix).toBe(1);
  });

  it('the cannot-run pair gets its own block with the real remedy instead of repeating the shared --approve fix', () => {
    const out = render(baseResult(issues()));
    // The --approve fix appears exactly once — for the fillable member.
    expect((out.match(/fix: {2}yg check --approve/g) ?? []).length).toBe(1);
    expect(out).toContain('  fix:  Give the file a component of its own');
  });

  it('next never names a file the fix only mentions in passing as the place to edit', () => {
    // "edit yg-node.yaml" names no concrete file: the remedy is to create a
    // component, not to edit an existing file of that name.
    const out = render(baseResult(issues()));
    expect(out).not.toContain('next: edit yg-node.yaml');
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

// ── Aspect drill-in view: --aspect <id> ────────────────────────────

describe('check render — --aspect drill-in view', () => {
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


  it('filters to aspect x: the true verdict line naming the view, no y-issue content', () => {
    const out = render(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' });
    // The verdict line keeps the TRUE counts and names the view.
    expect(out.split('\n')[0]).toBe('yg check: FAIL  3 errors   1 node   view: aspect x');
    expect(headings(out)).toEqual(['error[refused] x — refused on 2 nodes']);
    // y-issue content must NOT appear.
    expect(out).not.toContain('node-c');
    expect(out).not.toContain('y issue');
    // Both x-nodes must appear.
    expect(out).toContain('node-a  missing entry A');
    expect(out).toContain('node-b  missing entry B');
    expect(out).toMatch(/\nnext: /);
  });

  it('drill-in shows every member — no cap even when members exceed MEMBER_CAP', () => {
    const manyIssues: CheckIssue[] = Array.from({ length: 15 }, (_, i) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'x',
      pairKind: 'llm',
      nodePath: `node-${i}`,
      messageData: llmRefusedMessage({ aspectId: 'x', unitKey: `node-${i}#x`, reason: `reason-${i}` }),
    } as CheckIssue));
    const out = render(baseResult(manyIssues), { kind: 'aspect', id: 'x' });
    for (let i = 0; i < 15; i++) {
      expect(out).toContain(`node-${i}`);
    }
    expect(out).not.toContain('… +');
  });

  it('exit code logic is outside formatOutput — aspect view does not affect it', () => {
    // This is a contract test: formatOutput must not throw or return empty on aspect view.
    // The actual exit code (derived from full result.issues) is tested at the CLI action layer.
    const out = formatOutput(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' });
    expect(out.length).toBeGreaterThan(0);
  });

  // An aspect with ZERO issues this run, while OTHER errors exist, must still
  // surface the run's next step — never dead-end the agent.
  it('aspect with zero matching issues says so and falls through to the run\'s next step', () => {
    const out = render(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'z' });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  3 errors   1 node   view: aspect z');
    expect(out).toContain("note: rule 'z' has no findings in this run.");
    expect(headings(out)).toHaveLength(0);
    expect(steps(out)).toEqual(steps(render(baseResult(aspectDrillIssues()))));
    expect(out).toMatch(/\nnext: /);
  });

  it('aspect with matching issues takes its step from its own blocks, not the run\'s', () => {
    // A graph-invalid finding elsewhere (tier 0) leads the run's own step.
    const elsewhere: CheckIssue = {
      severity: 'error', code: 'yaml-invalid', rule: 'invalid-node-yaml', nodePath: 'users/missing-service',
      messageData: { what: 'yg-node.yaml in users/missing-service does not parse: x', why: 'not loaded', next: 'Fix the YAML in .yggdrasil/model/users/missing-service/yg-node.yaml.' },
    };
    const issues = [...aspectDrillIssues(), elsewhere];
    expect(steps(render(baseResult(issues)))[0]).toContain('edit .yggdrasil/model/users/missing-service/yg-node.yaml');
    // …the drill-in into x takes its own.
    const out = render(baseResult(issues), { kind: 'aspect', id: 'x' });
    expect(out).toMatch(/\nnext: /);
    expect(steps(out).join('\n')).not.toContain('users/missing-service');
  });

  // The drill-in step must name the HIGHEST-TIER block's step — a code error
  // before a pending pair — NOT the first issue in emission order.
  it('drill-in next points at the highest-tier block, not the first-emitted issue', () => {
    const mixedPriorityIssues: CheckIssue[] = [
      // Emitted FIRST but a lower tier (a pending pair).
      {
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'node-b',
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: 'node-b#x' }),
      } as CheckIssue,
      // Emitted SECOND but a higher tier (a code error: a located script refusal).
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'x',
        pairKind: 'deterministic',
        nodePath: 'node-a',
        messageData: detRefusedMessage({ aspectId: 'x', unitKey: 'node:node-a', reason: 'src/node-a.ts:7: forbidden' }),
      } as CheckIssue,
    ];
    const out = render(baseResult(mixedPriorityIssues), { kind: 'aspect', id: 'x' });
    expect(headings(out)[0]).toBe('error[refused] x — 1 violation in node-a');
    expect(steps(out)).toEqual([
      'next: edit src/node-a.ts:7  (refused)',
      'then: yg check --approve  (1 reviewer pair · paid — ask the user to approve it first)',
    ]);
  });

  // The drill-in verdict line must carry the change-scope segment a project
  // measuring against a reference branch always sees, computed the SAME way
  // (renderChangeScope, the TRUE total) rather than a second, aspect-scoped tally.
  it('reprints the progressive change-scope segment the plain verdict line shows', () => {
    const result: CheckResult = {
      ...baseResult(aspectDrillIssues()),
      outsideCount: 2,
      progressiveReference: 'main',
      changedInputCount: 1,
    };
    const headerLine = render(result, { kind: 'aspect', id: 'x' }).split('\n')[0];
    expect(headerLine).toContain('view: aspect x');
    expect(headerLine).toContain('3 errors');
    expect(headerLine).toContain('2 obligations outside your changes vs main (1 changed input)');
    expect(headerLine.replace('   view: aspect x', '')).toBe(render(result).split('\n')[0]);
  });

  it('stays silent about change scope in the drill-in verdict line when the run measured nothing', () => {
    const out = render(baseResult(aspectDrillIssues()), { kind: 'aspect', id: 'x' });
    expect(out.split('\n')[0]).not.toContain('outside your changes');
  });

  /**
   * The drill-in FOOTER, the counterpart to the header case above.
   *
   * Every other surface already refuses to advise the recording command for a
   * finding the run deliberately declined to hold this change accountable for:
   * the group renderer suppresses the Fix: line on a twin in all four of its
   * shapes, and the run's own bottom line points at the audit instead. This view
   * took the highest-priority filtered finding's `next` verbatim — and a twin's
   * `messageData` is deliberately left untouched by the classifier, so on an
   * all-inherited, warning-only, exit-0 run it printed
   * a group-scoped `yg check --approve`: a repo-wide paid review, advised by
   * a run that had just said none of this was yours, and one a scoped recording
   * run would decline to perform anyway.
   */
  function inheritedOnlyOnAspectX(): CheckResult {
    const twins: CheckIssue[] = [
      {
        severity: 'warning',
        code: 'unverified-outside',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: 'legacy/reporting',
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: 'legacy/reporting#x' }),
      } as CheckIssue,
    ];
    return {
      ...baseResult(twins),
      // What computeSuggestedNext returns for this run — the standing line, not
      // any one finding's own command.
      suggestedNext: computeSuggestedNext(twins),
      outsideCount: 1,
      progressiveReference: 'origin/main',
      changedInputCount: 3,
    };
  }

  it('drill-in on an all-inherited aspect points at the audit, never at the recording command', () => {
    const result = inheritedOnlyOnAspectX();
    const out = render(result, { kind: 'aspect', id: 'x' });
    // The verdict line still names the view and the true totals (0 blocking errors).
    expect(out.split('\n')[0]).toMatch(/^yg check: PASS {2}1 warning {3}.*view: aspect x$/);
    // The finding itself is still listed — never hidden.
    expect(out).toContain('warning[unverified-outside] 1 pair with no verdict yet — outside your changes');
    // The one honest next step, identical to the one the plain view prints.
    expect(steps(out)).toEqual(['next: yg check --full  (1 obligation outside your changes)']);
    expect(steps(out)).toEqual(steps(render(result)));
    // And emphatically not the recording command, anywhere.
    expect(out).not.toContain('yg check --approve');
  });

  // The two surfaces reporting the SAME number have to call it the same thing.
  it('verdict line and next line call the same number by the same name', () => {
    for (const count of [1, 2]) {
      const twins: CheckIssue[] = Array.from({ length: count }, (_, i) => ({
        severity: 'warning',
        code: 'unverified-outside',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: `legacy/n${i}`,
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: `legacy/n${i}#x` }),
      } as CheckIssue));
      const out = render({
        ...baseResult(twins),
        suggestedNext: computeSuggestedNext(twins),
        outsideCount: count,
        progressiveReference: 'origin/main',
        changedInputCount: 1,
      });
      const noun = `${count} obligation${count === 1 ? '' : 's'} outside your changes`;
      const [header] = out.split('\n');
      const footer = out.split('\n').find((l) => l.startsWith('next: '))!;
      expect(header).toContain(noun);
      expect(footer).toContain(noun);
      expect(footer).not.toContain('enforced');
    }
  });

  it('drill-in still shows a genuine finding\'s own fix when the aspect carries one beside inherited debt', () => {
    // Nothing blocks, so the run's step is the audit — but the finding the
    // change IS answerable for keeps its own fix, stated on its block.
    const genuine: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      aspectId: 'x',
      pairKind: 'llm',
      nodePath: 'orders/handler',
      messageData: llmRefusedMessage({ aspectId: 'x', unitKey: 'orders/handler#x', reason: 'style nit' }),
    } as CheckIssue;
    const base = inheritedOnlyOnAspectX();
    const issues = [...base.issues, genuine];
    const out = render({ ...base, issues, suggestedNext: computeSuggestedNext(issues) }, { kind: 'aspect', id: 'x' });
    // The genuine finding comes first, with its fix.
    expect(headings(out)[0]).toBe('warning[refused] x — refused on orders/handler');
    expect(out).toContain(`  fix:  ${genuine.messageData.next.split('\n')[0]}`);
    expect(out).toMatch(/\nnext: /);
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
describe('check render — --top block view', () => {
  it('{kind:top,n:2} renders exactly 2 blocks, the true count, and a next line', () => {
    const out = render(fourGroupErrorResult(), { kind: 'top', n: 2 });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  4 errors   1 node   view: top 2');
    expect(headings(out)).toHaveLength(2);
    expect(out).toContain('… +2 more blocks  (yg check)');
    expect(out).toMatch(/\nnext: /);
  });

  it('{kind:top,n:2} shows the 2 highest-tier blocks (the refusals) and NOT the lower ones', () => {
    const out = render(fourGroupErrorResult(), { kind: 'top', n: 2 });
    expect(headings(out)).toEqual([
      'error[refused] aspect-y — refused on orders/service',
      'error[refused] aspect-z — refused on billing/service',
    ]);
    expect(out).not.toContain('error[relation-undeclared-dependency]');
    expect(out).not.toContain('error[unverified]');
  });

  it('{kind:top,n:0} (defensive) renders zero blocks, counts them, and one next', () => {
    const out = render(fourGroupErrorResult(), { kind: 'top', n: 0 });
    expect(out.split('\n')[0]).toContain('4 errors');
    expect(headings(out)).toHaveLength(0);
    expect(out).toContain('… +4 more blocks  (yg check)');
    expect((out.match(/\nnext: /g) ?? []).length).toBe(1);
  });

  it('{kind:top,n:1} with errors AND warnings: both true counts stay on the verdict line, the hidden blocks are counted', () => {
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
    const out = render({ ...base, issues: [...base.issues, warning] }, { kind: 'top', n: 1 });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  4 errors · 1 warning   1 node   view: top 1');
    expect(headings(out)).toHaveLength(1);
    expect(out).toContain('… +4 more blocks  (yg check)');
    expect(out).toMatch(/\nnext: /);
  });

  it('{kind:top,n:4} renders all 4 blocks when n equals the block count, errors by tier', () => {
    const out = render(fourGroupErrorResult(), { kind: 'top', n: 4 });
    expect(headings(out)).toEqual([
      'error[refused] aspect-y — refused on orders/service',
      'error[refused] aspect-z — refused on billing/service',
      'error[relation-undeclared-dependency] payments/processor depends on billing/service but has no declared relation',
      'error[unverified] 1 pair with no verdict yet',
    ]);
    expect(out).not.toContain('more block');
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

// ── --top coverage block ─────────────────────────────

describe('check render — --top view: coverage findings', () => {
  it('{kind:top,n:1} with an unmapped-files error renders the file-list block', () => {
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
    const out = render(baseResult([issue]), { kind: 'top', n: 1 });
    // The heading counts files, and the file list IS the finding.
    expect(out).toContain('error[unmapped] 2 files belong to no node');
    expect(out).toContain('  at:   src/a.ts');
    expect(out).toContain('        src/b.ts');
    // Never the pair/node framing.
    expect(out).not.toMatch(/\d+ pairs?/);
    expect(out).not.toMatch(/\d+ nodes? ·/);
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
    const out = render(baseResult(issues), { kind: 'top', n: 5 });
    expect(out).toContain('src/in-diff.ts');
    expect(out).toContain('src/inherited-a.ts');
    expect(out).toContain('src/inherited-b.ts');
    // The blocking half keeps its own count…
    expect(out).toContain('error[unmapped] 1 file belongs to no node');
    // …and the two halves never read as the same thing: only one of them is
    // this change's business, and the label says which.
    expect(out).toContain('warning[unmapped-outside] 2 files belong to no node — outside your changes');
  });

  it('keeps each half under its own severity: the blocking half first', () => {
    const out = render(baseResult(halves()), { kind: 'top', n: 5 });
    const errorAt = out.indexOf('error[unmapped]');
    const warningAt = out.indexOf('warning[unmapped-outside]');
    expect(errorAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(errorAt);
    expect(out.indexOf('src/in-diff.ts')).toBeLessThan(warningAt);
    expect(out.indexOf('src/inherited-a.ts')).toBeGreaterThan(warningAt);
  });

  it('renders the reverse order identically — no array-order accident', () => {
    const [inDiff, outside] = halves();
    const forward = render(baseResult([inDiff, outside]), { kind: 'top', n: 5 });
    const reversed = render(baseResult([outside, inDiff]), { kind: 'top', n: 5 });
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
      const out = render(baseResult(inherited()), view);
      expect(out).toContain('src/inherited-a.ts');
      expect(out).toContain('src/inherited-b.ts');
      // …as a coverage block counted in files, marked as the change's
      // inheritance rather than its business — the two halves of one split
      // finding must not share a label.
      expect(out).toContain('warning[unmapped-outside] 2 files belong to no node — outside your changes');
    });
  }

  it('does not call the inherited half "uncovered" — that is the advisory tier', () => {
    const out = render(baseResult(inherited()), { kind: 'full' });
    expect(out).not.toContain('[uncovered');
  });
});
