import { describe, it, expect } from 'vitest';
import { formatOutput, resolveTopValue, renderGroup, useEmoji } from '../../../src/cli/check.js';
import type { CheckView } from '../../../src/cli/check.js';
import { groupIssues } from '../../../src/cli/group-issues.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
  promptTooLargeMessage,
} from '../../../src/formatters/lock-issue-messages.js';

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
 * Unit tests for the `yg check` render layer (formatOutput / renderIssueBlock).
 * These exercise the rendering directly against constructed CheckResult objects
 * — no spawned binary, no build — so they pin the agent-facing OUTPUT contract:
 *   - refusal issues must render their FULL `what` (reviewer reason / violation
 *     list), not just line 1;
 *   - advisory warnings (aspect-violation AND unverified) must carry the
 *     "(advisory — not blocking)" hint and a next pointer.
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
  };
}

describe('check render — refusal detail (full what)', () => {
  it('renders grouped block with reviewer reason line for an enforced LLM refusal', () => {
    const reason =
      'The handler does not emit an audit-log entry on the failure branch.\n' +
      'Line 42: catch block returns without logging the rejected request.';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));

    // Grouped grammar: group header with label, pair/node counts, aspect id.
    expect(out).toContain("enforced  1 pairs  1 nodes  aspect 'audit-logging'");
    // perMemberReason: the first detail line of `what` (line 1) appears on the member.
    expect(out).toContain('Reviewer reason: The handler does not emit an audit-log entry on the failure branch.');
    // The three-exits Fix block must reach the agent — including the yg-suppress exit.
    expect(out).toContain('yg-suppress');
    // Member line for the node.
    expect(out).toContain('- orders/handler');
  });

  it('renders grouped block with violation header for an enforced det refusal', () => {
    const reason =
      'src/a.ts:10 — forbidden import of database client\n' +
      'src/b.ts:22 — forbidden import of database client';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'ui/page',
      aspectId: 'ui-no-direct-db',
      messageData: detRefusedMessage({
        aspectId: 'ui-no-direct-db',
        unitKey: 'ui/page#ui-no-direct-db',
        reason,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));

    // Group header present.
    expect(out).toContain("enforced  1 pairs  1 nodes  aspect 'ui-no-direct-db'");
    // perMemberReason: what line 1 ('Violations:') appears on the member.
    expect(out).toContain('Violations:');
    // The actual violation file:line entries must appear — the fix ensures lines 2+ of
    // messageData.what (the actionable src:line detail) are NOT silently dropped.
    expect(out).toContain('src/a.ts:10 — forbidden import of database client');
    expect(out).toContain('src/b.ts:22 — forbidden import of database client');
    // Fix line present.
    expect(out).toContain('Fix: Fix the listed violations');
    // Member line for the node.
    expect(out).toContain('- ui/page');
  });

  it('renders a grouped block for a prompt-too-large issue with Fix: remedies', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'prompt-too-large',
      rule: 'prompt-too-large',
      nodePath: 'big/node',
      aspectId: 'some-aspect',
      messageData: promptTooLargeMessage({
        aspectId: 'some-aspect',
        unitKey: 'big/node#some-aspect',
        tierName: 'standard',
        chars: 99999,
        limit: 40000,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Group header present with correct label and aspect.
    expect(out).toContain("prompt-too-large  1 pairs  1 nodes  aspect 'some-aspect'");
    // The safety-ordered remedies from `next` still reach the agent.
    expect(out).toContain('Narrow scope.files');
    // Member line for the node.
    expect(out).toContain('- big/node');
  });
});

describe('check render — advisory warning hints', () => {
  it('renders a grouped warning block for an advisory aspect-violation warning with fix pointer', () => {
    const issue: CheckIssue = {
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

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Grouped grammar: group header with advisory label and aspect.
    expect(out).toContain("advisory  1 pairs  1 nodes  aspect 'audit-logging'");
    // Reason appears in member detail (perMemberReason: true for aspect-violation-advisory).
    expect(out).toContain('missing audit entry');
    // Fix block must include the three-exits next.
    expect(out).toContain('yg-suppress');
  });

  it('renders a grouped warning block for an advisory unverified warning with Fix pointer', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: unverifiedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Grouped grammar: unverified groups by CODE ONLY — no aspect in the header.
    expect(out).toContain("unverified (not yet reviewed)  1 pairs  1 nodes");
    // The aspect appears on the member body line, not the header.
    expect(out).toContain("- orders/handler  aspect 'audit-logging'");
    // The header does NOT carry an aspect segment (unverified spans aspects).
    expect(out).not.toContain("unverified (not yet reviewed)  1 pairs  1 nodes  aspect 'audit-logging'");
    // The next pointer must be present so the agent knows how to clear it.
    expect(out).toContain('yg check --approve');
  });

  it('does NOT add the advisory hint to an enforced (error-mode) unverified issue', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: unverifiedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
      }),
    };

    const out = formatOutput(baseResult([issue]));
    expect(out).not.toContain('(advisory — not blocking)');
  });
});

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
});

describe('check render — renderGroup', () => {
  it('renders ONE grouped block for an aspect failing on many nodes', () => {
    const issues: CheckIssue[] = ['a', 'b', 'c'].map((n) => ({
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: n }),
    } as CheckIssue));
    const [g] = groupIssues(issues);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    // Unverified collapses by CODE ONLY: no aspect in group header.
    expect(out).toContain("unverified (not yet reviewed)  3 pairs  3 nodes");
    expect(out).not.toContain("unverified (not yet reviewed)  3 pairs  3 nodes  aspect 'audit-logging'");
    // Aspect appears on each member body line.
    expect(out).toContain("- a  aspect 'audit-logging'");
    expect(out).toContain("- b  aspect 'audit-logging'");
    expect(out).toContain("- c  aspect 'audit-logging'");
    expect((out.match(/Fix: yg check --approve/g) ?? []).length).toBe(1);
  });

  it('refused group STILL shows aspect in header (per-(code,aspectId) grouping retained)', () => {
    const issues: CheckIssue[] = ['a', 'b'].map((n) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: llmRefusedMessage({ aspectId: 'audit-logging', unitKey: n, reason: 'missing entry' }),
    } as CheckIssue));
    const [g] = groupIssues(issues);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    // Refused groups group by (code, aspectId) — aspect still in header.
    expect(out).toContain("enforced  2 pairs  2 nodes  aspect 'audit-logging'");
  });

  // A finding about repository files, not about any component. Counting a
  // missing node as one printed "1 pairs  1 nodes" and an empty `- ` bullet,
  // reporting a component the graph does not contain and, in the web view,
  // linking to a page that cannot exist.
  it('a repo-level issue (no nodePath) renders with no pair/node counts and no node bullet', () => {
    const issues: CheckIssue[] = [{
      severity: 'warning',
      code: 'rules-digest-stale',
      rule: 'rules-digest-stale',
      messageData: {
        what: 'Committed agent-rules digest is out of sync: .clinerules/yggdrasil.md is missing.',
        why: 'Agents read the committed digest before running yg prime.',
        next: 'yg init --upgrade',
      },
    } as CheckIssue];
    const [g] = groupIssues(issues);
    expect(g.nodeCount).toBe(0);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).not.toMatch(/\d+ pairs/);
    expect(out).not.toMatch(/\d+ nodes/);
    expect(out).not.toMatch(/^\s+- /m);
    // The finding's own content, its rationale and its fix all still render.
    expect(out).toContain('  rules-digest-stale');
    expect(out).toContain('.clinerules/yggdrasil.md is missing');
    expect(out).toContain('Why: Agents read the committed digest');
    expect(out).toContain('Fix: yg init --upgrade');
  });
});

// ── Fix 4: divergent per-node `next`/`why` renders per-member ──────────────────
describe('check render — Fix 4: divergent per-node fix surfaces EACH node\'s command', () => {
  it('a log-entry-missing group of 2 nodes renders BOTH yg log add commands (not just the first)', () => {
    const issues: CheckIssue[] = [
      {
        severity: 'error', code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: 'billing/charge',
        messageData: {
          what: "No fresh log entry for node 'billing/charge' — its source changed but no justification entry exists.",
          why: "Node type 'command' has log_required: true.",
          next: "yg log add --node billing/charge --reason '<justification>', then re-run: yg check --approve",
        },
      } as CheckIssue,
      {
        severity: 'error', code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: 'orders/handler',
        messageData: {
          what: "No fresh log entry for node 'orders/handler' — its source changed but no justification entry exists.",
          why: "Node type 'command' has log_required: true.",
          next: "yg log add --node orders/handler --reason '<justification>', then re-run: yg check --approve",
        },
      } as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    // BOTH nodes' own commands must appear — not just the alphabetically-first one.
    expect(out).toContain('yg log add --node billing/charge');
    expect(out).toContain('yg log add --node orders/handler');
    // The misleading SINGLE shared "Fix:" line naming only the first node must NOT appear.
    // (A single shared Fix line would render exactly one of the two commands.)
    const sharedFixLines = out.split('\n').filter((l) => /^ {12}Fix: yg log add/.test(l));
    expect(sharedFixLines.length).toBe(0);
  });

  it('a relation-target-forbidden group with divergent why surfaces BOTH why variants', () => {
    const issues: CheckIssue[] = [
      {
        severity: 'error', code: 'relation-target-forbidden', rule: 'relation-target-forbidden', nodePath: 'a/x',
        messageData: { what: 'forbidden on a/x', why: "Allowed targets for 'uses' from type 'svc': [repo]", next: "Change the relation type for a/x." },
      } as CheckIssue,
      {
        severity: 'error', code: 'relation-target-forbidden', rule: 'relation-target-forbidden', nodePath: 'b/y',
        messageData: { what: 'forbidden on b/y', why: "Type 'svc' denies relation 'uses' by default.", next: "Open 'uses' for type 'svc' (for b/y)." },
      } as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    // Both distinct why variants reach the agent.
    expect(out).toContain("Allowed targets for 'uses' from type 'svc'");
    expect(out).toContain("Type 'svc' denies relation 'uses' by default");
    // Both distinct next commands reach the agent.
    expect(out).toContain('Change the relation type for a/x.');
    expect(out).toContain("Open 'uses' for type 'svc' (for b/y).");
  });

  it('a SHARED-fix group (LLM refusal, identical next) still collapses to ONE Fix line', () => {
    const issues: CheckIssue[] = ['a', 'b', 'c'].map((n) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: llmRefusedMessage({ aspectId: 'audit-logging', unitKey: n, reason: `reason-${n}` }),
    } as CheckIssue));
    const out = stripAnsi(formatOutput(baseResult(issues)));
    // The shared three-exits Fix block renders exactly once (collapsed).
    const fixLineCount = out.split('\n').filter((l) => /^ {12}Fix: /.test(l)).length;
    expect(fixLineCount).toBe(1);
    // Per-member reason still shows each node's distinct reason (FULL_WHAT path).
    expect(out).toContain('reason-a');
    expect(out).toContain('reason-b');
    expect(out).toContain('reason-c');
  });
});

describe('check render — grouped full view (task 1.3)', () => {
  it('header counts reconcile: 2 unverified(x) + 1 refused(y) → Errors (3) in 2 groups:', () => {
    const issues: CheckIssue[] = [
      ...['a', 'b'].map((n) => ({
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: n,
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: n }),
      } as CheckIssue)),
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'y',
        pairKind: 'llm',
        nodePath: 'a',
        messageData: llmRefusedMessage({ aspectId: 'y', unitKey: 'a', reason: 'r' }),
      } as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    expect(out).toContain('Errors (3) in 2 groups:');
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
    };
    const out = stripAnsi(formatOutput(green));
    expect(out).not.toContain('Next:');
    expect(out).not.toContain('fills');
  });
});

describe('check render — --details view (task 2.1)', () => {
  it('produces THREE separate per-issue blocks for 3 unverified issues on the same aspect across 3 nodes', () => {
    const issues: CheckIssue[] = ['node-a', 'node-b', 'node-c'].map((n) => ({
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: `${n}#audit-logging` }),
    } as CheckIssue));

    const detailsOut = stripAnsi(formatOutput(baseResult(issues), { kind: 'details' }));
    const fullOut    = stripAnsi(formatOutput(baseResult(issues), { kind: 'full' }));

    // --details must render THREE individual blocks (one per issue), not one grouped block.
    expect(countBlocks(detailsOut)).toBe(3);
    // Each node appears in its own "unverified … <node>" block.
    expect(detailsOut).toContain('unverified  node-a');
    expect(detailsOut).toContain('unverified  node-b');
    expect(detailsOut).toContain('unverified  node-c');
    // The default grouped view collapses these into ONE block.
    expect(countBlocks(fullOut)).toBe(1);
  });

  it('still renders the true Errors(N) header and Next line in --details view', () => {
    const issues: CheckIssue[] = ['node-a', 'node-b'].map((n) => ({
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: `${n}#audit-logging` }),
    } as CheckIssue));

    const out = stripAnsi(formatOutput(baseResult(issues), { kind: 'details' }));
    expect(out).toContain('Errors (2):');
    expect(out).toMatch(/\nNext: /);
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

// ── PASS (auto-filled) header marker (task 3.4) ────────────────────────────────

describe('check render — PASS (auto-filled) header marker (task 3.4)', () => {
  function greenResult(): CheckResult {
    return {
      projectName: 'test',
      nodeCount: 2,
      nodeTypeCounts: new Map(),
      aspectCount: 3,
      flowCount: 1,
      coveredFiles: 5,
      totalFiles: 5,
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
      draftSkipped: 0,
      verifiedDet: 0,
      verifiedLlm: 0,
    };
  }
  function warningsOnlyGreenResult(): CheckResult {
    const w: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'missing audit', why: 'required', next: 'fix it' },
    };
    return {
      projectName: 'test',
      nodeCount: 1,
      nodeTypeCounts: new Map(),
      aspectCount: 1,
      flowCount: 0,
      coveredFiles: 0,
      totalFiles: 0,
      issues: [w],
      suggestedNext: 'fix it',
      advisoryWarnings: 1,
      draftSkipped: 0,
      verifiedDet: 0,
      verifiedLlm: 0,
    };
  }

  it('autoFilled=false, no errors, no warnings → plain PASS (no marker)', () => {
    const out = stripAnsi(formatOutput(greenResult(), { kind: 'full' }, false));
    expect(out).toContain('yg check: PASS');
    expect(out).not.toContain('auto-filled');
  });

  it('autoFilled=true, no errors, no warnings → PASS (auto-filled)', () => {
    const out = stripAnsi(formatOutput(greenResult(), { kind: 'full' }, true));
    expect(out).toContain('PASS (auto-filled)');
    expect(out).not.toContain('FAIL');
  });

  it('autoFilled=true, warnings present → PASS (auto-filled, N warnings)', () => {
    const out = stripAnsi(formatOutput(warningsOnlyGreenResult(), { kind: 'full' }, true));
    expect(out).toContain('PASS (auto-filled, 1 warning)');
    expect(out).not.toContain('FAIL');
  });

  it('autoFilled=false, warnings present → plain PASS (N warnings) no marker', () => {
    const out = stripAnsi(formatOutput(warningsOnlyGreenResult(), { kind: 'full' }, false));
    expect(out).toContain('PASS (1 warning)');
    expect(out).not.toContain('auto-filled');
  });

  it('FAIL result with autoFilled=true does NOT say (auto-filled) on the FAIL line', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'unverified', why: 'why', next: 'fix' },
    };
    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'full' }, true));
    expect(out).toContain('yg check: FAIL');
    expect(out).not.toContain('auto-filled');
  });
});

// ── Header: verified-pair split (deterministic vs LLM) ───────────────────────

describe('check render — header verified-pair split', () => {
  // Every other render test leaves verifiedDet/verifiedLlm at 0, so the header's
  // `verifiedTotal > 0` branch (which appends `N verified (X deterministic, Y LLM)`)
  // was never exercised. This pins that split, and that a zero total omits it.
  it('appends "N verified (X deterministic, Y LLM)" when at least one pair is verified', () => {
    const result: CheckResult = { ...baseResult([]), verifiedDet: 5, verifiedLlm: 3 };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    // Total (5 + 3 = 8) and the deterministic/LLM split all appear in the header.
    expect(out).toContain('8 verified (5 deterministic, 3 LLM)');
  });

  it('omits the verified metric entirely when the total is zero', () => {
    const result: CheckResult = { ...baseResult([]), verifiedDet: 0, verifiedLlm: 0 };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).not.toContain('verified (');
  });
});

// ── Header: type-covered split (coverage.type_level) ─────────────────────────

describe('check render — header type-covered split (coverage.type_level)', () => {
  // Same coveredFiles/totalFiles either way (1/5) — only `typeLevel` differs —
  // so these two tests isolate the flag as the sole cause of the format change.
  it('flag OFF: byte-identical to the pre-type-level header (ratio + percentage, no split)', () => {
    const result: CheckResult = { ...baseResult([]), coveredFiles: 1, totalFiles: 5 };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain('1/5 files (20%)');
    expect(out).not.toContain('node-owned');
    expect(out).not.toContain('type-covered');
  });

  it('flag ON: the files metric names the node-owned/type-covered/excluded split — "node-owned" comes from nodeOwnedFiles, NOT the conflated coveredFiles', () => {
    const result: CheckResult = {
      ...baseResult([]),
      // coveredFiles (1) deliberately does NOT equal nodeOwnedFiles (0) here —
      // this is the excluded-root case the header must never mislabel: a file
      // sitting under coverage.excluded, in a graph with ZERO nodes, must never
      // read as "node-owned" just because it is folded into the pre-existing
      // conflated coveredFiles count.
      coveredFiles: 1,
      totalFiles: 5,
      typeLevel: true,
      typeCoveredCount: 1,
      classifyingTypeCount: 1,
      nodeOwnedFiles: 0,
      excludedFiles: 1,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    // The old plain-percentage rendering is gone...
    expect(out).not.toContain('(20%)');
    // ...replaced by the named three-term split. The numerator counts every
    // satisfied file (0 node-owned + 1 type-covered + 1 excluded = 2/5) —
    // but "node-owned" itself names only the truly node-mapped file (zero).
    expect(out).toContain('2/5 files (0 node-owned, 1 type-covered, 1 excluded)');
  });

  it('flag ON, fully covered: the split still renders (composition stays informative at 100%)', () => {
    const result: CheckResult = {
      ...baseResult([]),
      coveredFiles: 1,
      totalFiles: 2,
      typeLevel: true,
      typeCoveredCount: 1,
      classifyingTypeCount: 1,
      nodeOwnedFiles: 0,
      excludedFiles: 1,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain('2/2 files (0 node-owned, 1 type-covered, 1 excluded)');
  });

  it('flag ON, a real node mapping owns a file: "node-owned" names it, distinct from type-covered and excluded', () => {
    const result: CheckResult = {
      ...baseResult([]),
      coveredFiles: 4,
      totalFiles: 6,
      typeLevel: true,
      typeCoveredCount: 1,
      classifyingTypeCount: 1,
      nodeOwnedFiles: 3,
      excludedFiles: 1,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    // Numerator: 3 node-owned + 1 type-covered + 1 excluded = 5/6.
    expect(out).toContain('5/6 files (3 node-owned, 1 type-covered, 1 excluded)');
  });

  it('flag ON, zero excluded AND zero type-covered files: all three terms still print (always-three-term, not conditional)', () => {
    const result: CheckResult = {
      ...baseResult([]),
      coveredFiles: 3,
      totalFiles: 5,
      typeLevel: true,
      typeCoveredCount: 0,
      classifyingTypeCount: 1,
      nodeOwnedFiles: 3,
      excludedFiles: 0,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain('3/5 files (3 node-owned, 0 type-covered, 0 excluded)');
  });

  it('sum invariant: node-owned + type-covered + excluded === coveredFiles (the pre-existing conflated total)', () => {
    // nodeOwnedFiles + excludedFiles must reconstitute coveredFiles exactly —
    // this is the algebraic identity the split is built on (core/check.ts).
    const result: CheckResult = {
      ...baseResult([]),
      coveredFiles: 4,
      totalFiles: 7,
      typeLevel: true,
      typeCoveredCount: 2,
      classifyingTypeCount: 1,
      nodeOwnedFiles: 1,
      excludedFiles: 3,
    };
    expect((result.nodeOwnedFiles ?? 0) + (result.excludedFiles ?? 0)).toBe(result.coveredFiles);
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain('6/7 files (1 node-owned, 2 type-covered, 3 excluded)');
  });
});

// ── Zero-classifying-types notice (coverage.type_level on, no `when:` anywhere) ──

describe('check render — zero-classifying-types notice', () => {
  const NOTICE =
    "Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — every file still needs an explicit node until you add classifying types.";

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

// ── Emoji decoration (accessibility invariant) ────────────────────────────────

describe('check render — emoji decoration', () => {
  // In the vitest environment (non-TTY), chalk.level is 0 → useEmoji is false.
  // Tests for the emoji-ON path pass `emoji = true` explicitly so they run
  // correctly regardless of the terminal environment.

  it('useEmoji gate: exported value is a boolean', () => {
    expect(typeof useEmoji).toBe('boolean');
  });

  // ── emoji OFF (byte-identity with pre-emoji output) ──

  it('emoji OFF: FAIL verdict has no emoji prefix', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'full' }, false, false));
    // Must start with the raw text, no emoji prefix.
    expect(out.startsWith('yg check: FAIL')).toBe(true);
    expect(out).toContain('yg check: FAIL');
    expect(out).not.toContain('❌');
    expect(out).not.toContain('✅');
  });

  it('emoji OFF: PASS verdict has no emoji prefix', () => {
    const out = stripAnsi(formatOutput(baseResult([]), { kind: 'full' }, false, false));
    expect(out.startsWith('yg check: PASS')).toBe(true);
    expect(out).toContain('yg check: PASS');
    expect(out).not.toContain('✅');
    expect(out).not.toContain('❌');
  });

  it('emoji OFF: Errors subheader has no emoji prefix (full view)', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'full' }, false, false));
    expect(out).toContain('Errors (1):');
    expect(out).not.toContain('❌');
  });

  it('emoji OFF: Warnings subheader has no emoji prefix (full view)', () => {
    const warning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([warning]), { kind: 'full' }, false, false));
    expect(out).toContain('Warnings (1):');
    expect(out).not.toContain('⚠');
  });

  // ── emoji ON ──

  it('emoji ON: FAIL verdict is prefixed with the cross-mark emoji', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'full' }, false, true));
    expect(out.startsWith('❌ yg check: FAIL')).toBe(true);
    // Text label must still be present (emoji is decoration only).
    expect(out).toContain('yg check: FAIL');
  });

  it('emoji ON: PASS verdict is prefixed with the check-mark emoji', () => {
    const out = stripAnsi(formatOutput(baseResult([]), { kind: 'full' }, false, true));
    expect(out.startsWith('✅ yg check: PASS')).toBe(true);
    // Text label must still be present.
    expect(out).toContain('yg check: PASS');
  });

  it('emoji ON: PASS with warnings is prefixed with the check-mark emoji', () => {
    const warning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const result: CheckResult = {
      ...baseResult([warning]),
      suggestedNext: null,
      advisoryWarnings: 1,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }, false, true));
    expect(out.startsWith('✅ yg check: PASS')).toBe(true);
    expect(out).toContain('yg check: PASS');
    expect(out).not.toContain('❌');
  });

  it('emoji ON: Errors subheader is prefixed with the cross-mark emoji (full view)', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'full' }, false, true));
    expect(out).toContain('❌ Errors (1):');
    // Text label still present.
    expect(out).toContain('Errors (1):');
  });

  it('emoji ON: Warnings subheader is prefixed with the warning emoji (full view)', () => {
    const warning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([warning]), { kind: 'full' }, false, true));
    // ⚠️ is U+26A0 + U+FE0F (variation selector); just check the warning sign present
    expect(out).toContain('⚠');
    expect(out).toContain('Warnings (1):');
  });

  it('emoji ON: Errors subheader is prefixed with the cross-mark emoji (summary/top views)', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const outSummary = stripAnsi(formatOutput(baseResult([issue]), { kind: 'summary' }, false, true));
    expect(outSummary).toContain('❌ Errors (1):');

    const outTop = stripAnsi(formatOutput(baseResult([issue]), { kind: 'top', n: 1 }, false, true));
    expect(outTop).toContain('❌ Errors (1):');
  });

  it('emoji ON: Errors/Warnings subheaders are prefixed in details view', () => {
    const error: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const warning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const out = stripAnsi(formatOutput(baseResult([error, warning]), { kind: 'details' }, false, true));
    expect(out).toContain('❌ Errors (1):');
    expect(out).toContain('⚠');
    expect(out).toContain('Warnings (1):');
  });
});
