import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatOutput, type CheckView } from '../../../src/cli/check-render-views.js';
import { buildBlocks, renderBlocks } from '../../../src/cli/check-render-groups.js';
import { MEMBER_CAP } from '../../../src/cli/output.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
  promptTooLargeMessage,
} from '../../../src/formatters/lock-issue-messages.js';
import { typeGateForbiddenMessage } from '../../../src/relations/messages.js';

/** Strip ANSI color codes so line matching is deterministic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** The heading lines of a report: one per block. */
function headings(out: string): string[] {
  return stripAnsi(out).split('\n').filter((l) => /^(error|warning)\[/.test(l));
}

/** Lines of one field (`at`, `why`, `fix`) across a report, continuation lines included. */
function fieldLines(out: string, label: 'at' | 'why' | 'fix'): string[] {
  const lines = stripAnsi(out).split('\n');
  const got: string[] = [];
  let inField = false;
  for (const l of lines) {
    if (/^ {2}[a-z]+: {1,}/.test(l)) inField = l.startsWith(`  ${label}:`);
    else if (!/^ {8}/.test(l)) inField = false;
    if (inField) got.push(l);
  }
  return got;
}

/**
 * Unit tests for the `yg check` finding blocks (check-render-groups.ts): how
 * issues become blocks (`error[label] subject` / `at:` / `why:` / `fix:`), and
 * how the views bound their member lists. These exercise the rendering
 * directly against constructed CheckResult objects — no spawned binary, no
 * build — so they pin the agent-facing OUTPUT contract:
 *   - a refusal renders its FULL detail (reviewer reason / violation list), not
 *     just its first line;
 *   - an advisory finding is a warning block with its fix, never an error.
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

/** A whole report, undecorated. */
function report(issues: CheckIssue[], view: CheckView = { kind: 'full' }): string {
  return stripAnsi(formatOutput(baseResult(issues), view, false, false));
}

/** Just the blocks, undecorated. */
function blocks(issues: CheckIssue[], capMembers = true): string {
  return stripAnsi(renderBlocks(buildBlocks(issues), { capMembers }, false).join('\n'));
}

describe('check render — refusal detail (full what)', () => {
  it('renders a refused block with the reviewer\'s reason for an enforced LLM refusal', () => {
    const reason =
      'The handler does not emit an audit-log entry on the failure branch.\n' +
      'Line 42: catch block returns without logging the rejected request.';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason,
      }),
    };

    const out = report([issue]);

    // Heading: the registry label, the rule, and where it was refused.
    expect(out).toContain('error[refused] audit-logging — refused on orders/handler');
    // The reviewer's whole reason reaches the member line — both of its lines.
    expect(out).toContain('  at:   orders/handler  The handler does not emit an audit-log entry on the failure branch. Line 42: catch block returns without logging the rejected request.');
    // The exits fix must reach the agent — including the yg-suppress exit.
    expect(out).toContain('  fix:  Four exits — the verdict is recorded for this exact code, so re-running the reviewer changes nothing:');
    expect(out).toContain('yg-suppress');
  });

  it('renders a refused block with every violation line for an enforced det refusal', () => {
    const reason =
      'src/a.ts:10: forbidden import of database client\n' +
      'src/b.ts:22: forbidden import of database client';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'ui/page',
      aspectId: 'ui-no-direct-db',
      pairKind: 'deterministic',
      messageData: detRefusedMessage({
        aspectId: 'ui-no-direct-db',
        unitKey: 'ui/page#ui-no-direct-db',
        reason,
      }),
    };

    const out = report([issue]);

    expect(out).toContain('error[refused] ui-no-direct-db — 2 violations in ui/page');
    // The actual violation file:line entries must appear — the actionable
    // detail is never silently dropped.
    expect(out).toContain('  at:   ui/page  src/a.ts:10  forbidden import of database client');
    expect(out).toContain('src/b.ts:22  forbidden import of database client');
    expect(out).toContain('  fix:  Change the code at these lines, then run yg check --approve --only-deterministic (free) to record the new verdict.');
    // The step points at the first violation's line.
    expect(out).toContain('next: edit src/a.ts:10');
  });

  it('renders a prompt-too-large block with its remedies', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'prompt-too-large',
      rule: 'prompt-too-large',
      nodePath: 'big/node',
      aspectId: 'some-aspect',
      pairKind: 'llm',
      messageData: promptTooLargeMessage({
        aspectId: 'some-aspect',
        unitKey: 'big/node#some-aspect',
        tierName: 'standard',
        chars: 99999,
        limit: 40000,
      }),
    };

    const out = report([issue]);
    expect(headings(out)).toHaveLength(1);
    expect(headings(out)[0]).toMatch(/^error\[prompt-too-large\] .*'some-aspect'/);
    expect(out).toContain('  at:   big/node');
    // The safety-ordered remedies from `next` still reach the agent.
    expect(out).toContain('Narrow scope.files');
  });
});

describe('check render — advisory warnings', () => {
  it('renders a warning block for an advisory refusal, with its reason and fix', () => {
    const issue: CheckIssue = {
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

    const out = report([issue]);
    expect(out.split('\n')[0]).toBe('yg check: PASS  1 warning   1 node');
    expect(out).toContain('warning[refused] audit-logging — refused on orders/handler');
    expect(out).toContain('  at:   orders/handler  missing audit entry');
    expect(out).toContain('yg-suppress');
  });

  it('renders a warning block for an advisory unverified pair, with its fix', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      messageData: unverifiedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
      }),
    };

    const out = report([issue]);
    // Unverified groups by CODE (and cause) — the heading names no rule; the
    // member line names the pair.
    expect(out).toContain('warning[unverified] 1 pair with no verdict yet');
    expect(out).toContain('  at:   audit-logging @ orders/handler');
    expect(out).toContain('  fix:  yg check --approve  (1 reviewer pair · paid — ask the user to approve it first)');
  });

  it('a fix with nothing to cost never prints an empty cost', () => {
    // An unverified pair whose kind is not known has no cost to state.
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: 'orders/handler#audit-logging' }),
    };
    expect(report([issue])).not.toContain('()');
  });

  it('an enforced (error-mode) unverified pair is an error block, never an advisory one', () => {
    const issue: CheckIssue = {
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
    };

    const out = report([issue]);
    expect(out).toContain('error[unverified] 1 pair with no verdict yet');
    expect(out).not.toContain('warning[');
    expect(out).not.toContain('advisory');
  });
});

/**
 * A finding put outside the change is rendered by the SAME code paths as the
 * finding it mirrors — grouped block, repo-level block, --details block,
 * coverage block. Two things change deliberately: the label carries the
 * `-outside` suffix every twin label carries (and the subject says "outside
 * your changes"), and the fix: field is left off, because `next` still names
 * the mirrored finding's OWN remedy (messageData is untouched by the
 * classifier) — which would mislead for a finding this change is not
 * accountable for and contradict the run's own standing next step
 * (`yg check --full`) for everything outside the change. why: is unaffected —
 * the rationale is still true regardless of scope.
 */
describe('check render — -outside twins: label and fix suppression', () => {
  function outsideUnverified(nodePath: string, aspectId = 'audit-logging'): CheckIssue {
    return {
      severity: 'warning',
      code: 'unverified-outside',
      rule: 'unverified',
      nodePath,
      aspectId,
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId, unitKey: `${nodePath}#${aspectId}` }),
    } as CheckIssue;
  }

  it('labels the twin exactly like its mirror, plus the outside marker', () => {
    const out = blocks([outsideUnverified('orders/handler')]);
    expect(out).toContain('warning[unverified-outside] 1 pair with no verdict yet — outside your changes');
  });

  it('omits the fix: field for a grouped twin (code-only group, shared next)', () => {
    const [issue] = [outsideUnverified('svc/a')];
    expect(issue.messageData.next).toBe('yg check --approve'); // the mirrored finding's own remedy
    const out = blocks([outsideUnverified('svc/a'), outsideUnverified('svc/b')]);
    expect(headings(out)).toHaveLength(1);
    expect(out).not.toContain('fix:');
    expect(out).not.toContain('yg check --approve');
    // The rationale is unaffected — still present, once.
    expect(fieldLines(out, 'why')).toHaveLength(1);
    expect(out).toContain('The lock holds no entry for this pair');
  });

  it('omits the per-member fix for a divergent twin group', () => {
    // relation-undeclared-dependency carries a node-specific `next` — divergent
    // across members even before scoping. Its twin must suppress ALL of them,
    // not just a shared one.
    const divergent = (nodePath: string): CheckIssue => ({
      severity: 'warning',
      code: 'relation-undeclared-dependency-outside',
      rule: 'relation-undeclared-dependency',
      nodePath,
      messageData: {
        what: `${nodePath} depends on something undeclared.\nsrc/${nodePath}.ts:3 → undeclared dependency on other`,
        why: 'Every statically-resolvable cross-node dependency must be declared as a relation.',
        next: `Add a relation entry in ${nodePath}/yg-node.yaml.`,
      },
    } as CheckIssue);
    const out = blocks([divergent('svc-a'), divergent('svc-b')]);
    expect(out).not.toContain('fix:');
    expect(out).not.toContain('yg-node.yaml');
    // The per-member detail (the actual violation line) still renders.
    expect(out).toContain('src/svc-a.ts:3 → undeclared dependency on other');
    expect(out).toContain('src/svc-b.ts:3 → undeclared dependency on other');
  });

  it('omits the fix: field for a twin in the --details view, and points next at the audit', () => {
    const out = report([outsideUnverified('orders/handler')], { kind: 'details' });
    expect(out).not.toContain('fix:');
    expect(out).toContain('  why:  ');
    expect(out).toContain('next: yg check --full  (1 obligation outside your changes)');
  });

  it('omits the fix: field for the inherited half of a split coverage finding', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'unmapped-files-outside',
      rule: 'unmapped-file',
      uncoveredFiles: ['src/inherited.ts'],
      uncoveredCount: 1,
      messageData: {
        what: '1 source file not covered by any node.\n  src/inherited.ts',
        why: 'Files without graph coverage cannot be modified under the protocol.',
        next: 'Check ownership candidates: yg context --file <path>',
      },
    };
    const out = report([issue]);
    expect(out).toContain('warning[unmapped-outside] 1 file belongs to no node — outside your changes');
    expect(out).not.toContain('fix:');
    expect(out).toContain('  why:  Files without graph coverage');
    expect(out).toContain('  at:   src/inherited.ts');
  });

  it('keeps the fix: field for the SAME code when it is NOT put outside the change', () => {
    // Control: the suppression is keyed on the twin code, not on `unverified`
    // in general — an in-scope unverified pair still gets its fix.
    const inScope: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: 'orders/handler#audit-logging' }),
    };
    expect(report([inScope])).toContain('  fix:  yg check --approve');
  });
});

describe('check render — blocks', () => {
  it('renders ONE block for a rule unverified on many nodes, the rule on its member line', () => {
    const issues: CheckIssue[] = ['svc/a', 'svc/b', 'svc/c'].map((n) => ({
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: n }),
    } as CheckIssue));
    const out = blocks(issues);
    // Unverified collapses by CODE: the heading names no rule...
    expect(headings(out)).toEqual(['error[unverified] 3 pairs with no verdict yet']);
    // ...the member line does, with its count.
    expect(out).toContain('  at:   audit-logging  3 pairs · 3 nodes · reviewer');
    expect((out.match(/fix: {2}yg check --approve/g) ?? []).length).toBe(1);
  });

  it('a refused block names its rule in the heading (per-(code, rule) grouping retained)', () => {
    const issues: CheckIssue[] = ['svc/a', 'svc/b'].map((n) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: llmRefusedMessage({ aspectId: 'audit-logging', unitKey: n, reason: 'missing entry' }),
    } as CheckIssue));
    expect(headings(blocks(issues))).toEqual(['error[refused] audit-logging — refused on 2 nodes']);
  });

  // A finding about repository files, not about any component. Counting a
  // missing node as one printed "1 pair  1 node" and an empty bullet,
  // reporting a component the graph does not contain and, in the web view,
  // linking to a page that cannot exist.
  it('a repo-level issue (no nodePath) renders with no pair/node counts and no member line', () => {
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
    const out = blocks(issues);
    expect(out).not.toMatch(/\d+ pairs?/);
    expect(out).not.toMatch(/\d+ nodes?/);
    expect(out).not.toContain('at:');
    // The finding's own content, its rationale and its fix all still render.
    expect(out).toContain('warning[rules-digest-stale] Committed agent-rules digest is out of sync: .clinerules/yggdrasil.md is missing');
    expect(out).toContain('  why:  Agents read the committed digest');
    expect(out).toContain('  fix:  yg init --upgrade');
  });
});

// ── Divergent per-node `next`/`why` ──────────────────
describe('check render — a per-node fix surfaces EACH node\'s command', () => {
  it('a log-entry-missing block of 2 nodes names a command for EACH node (one templated line), never only the first', () => {
    const issues: CheckIssue[] = ['billing/charge', 'orders/handler'].map((n) => ({
      severity: 'error', code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: n,
      messageData: {
        what: `No fresh log entry for node '${n}' — its source changed but no justification entry exists.`,
        why: "Node type 'command' has log_required: true.",
        next: `yg log add --node ${n} --reason '<justification>', then re-run: yg check --approve`,
      },
    } as CheckIssue));
    const out = report(issues);
    // The two commands differ only by the node path, so ONE templated line
    // stands for both — and says it applies to each node listed above it.
    expect(out).toContain("  fix:  yg log add --node <node> --reason '<justification>', then re-run: yg check --approve  for each node above");
    expect(out).toContain('  at:   billing/charge');
    expect(out).toContain('        orders/handler');
    // A fix: line naming only one node must NOT appear.
    expect(out).not.toContain('fix:  yg log add --node billing/charge');
    expect(out).not.toContain('fix:  yg log add --node orders/handler');
    // next: fills the first node in.
    expect(out).toContain("next: yg log add --node billing/charge --reason '<justification>'");
  });

  it('a relation-target-forbidden pair with divergent why surfaces BOTH why variants and BOTH fixes', () => {
    const issues: CheckIssue[] = [
      {
        severity: 'error', code: 'relation-target-forbidden', rule: 'relation-target-forbidden', nodePath: 'a/x',
        messageData: { what: 'forbidden on a/x', why: "Allowed targets for 'uses' from type 'svc': [repo]", next: 'Change the relation type for a/x.' },
      } as CheckIssue,
      {
        severity: 'error', code: 'relation-target-forbidden', rule: 'relation-target-forbidden', nodePath: 'b/y',
        messageData: { what: 'forbidden on b/y', why: "Type 'svc' denies relation 'uses' by default.", next: "Open 'uses' for type 'svc' (for b/y)." },
      } as CheckIssue,
    ];
    const out = report(issues);
    // Each why is stated once, in a block of its own.
    expect(headings(out)).toHaveLength(2);
    expect(out).toContain("  why:  Allowed targets for 'uses' from type 'svc'");
    expect(out).toContain("  why:  Type 'svc' denies relation 'uses' by default");
    expect(out).toContain('  fix:  Change the relation type for a/x.');
    expect(out).toContain("  fix:  Open 'uses' for type 'svc' (for b/y).");
  });

  it('a SHARED-fix block (LLM refusal, identical next) states its fix ONCE', () => {
    const issues: CheckIssue[] = ['svc/a', 'svc/b', 'svc/c'].map((n) => ({
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: llmRefusedMessage({ aspectId: 'audit-logging', unitKey: n, reason: `reason-${n}` }),
    } as CheckIssue));
    const out = report(issues);
    expect(out.split('\n').filter((l) => l.startsWith('  fix:'))).toHaveLength(1);
    // Each member still shows its own reason.
    expect(out).toContain('  at:   svc/a  reason-svc/a');
    expect(out).toContain('        svc/b  reason-svc/b');
    expect(out).toContain('        svc/c  reason-svc/c');
  });

  // type-relation-forbidden findings carry no nodePath (a finding is about a
  // (fromType, toType) PAIR, not a graph node). Two distinct forbidden pairs
  // in one run carry two different fixes; each must reach the agent with its
  // actual remedy, never only the first, and never only the heading that
  // introduces the remedy list.
  it('TWO distinct forbidden type pairs (repo-level, no nodePath) each render their OWN fix', () => {
    const issues: CheckIssue[] = [
      {
        severity: 'error', code: 'type-relation-forbidden', rule: 'type-relation-forbidden',
        messageData: typeGateForbiddenMessage({
          fromType: 'svc', toType: 'owner-type',
          edges: [{ fromFile: 'src/svc/handler.ts', toFile: 'src/owner/target.ts' }],
        }),
      } as CheckIssue,
      {
        severity: 'error', code: 'type-relation-forbidden', rule: 'type-relation-forbidden',
        messageData: typeGateForbiddenMessage({
          fromType: 'web', toType: 'db',
          edges: [{ fromFile: 'src/web/page.ts', toFile: 'src/db/store.ts' }],
        }),
      } as CheckIssue,
    ];
    const out = blocks(issues);
    expect(out).toContain("from type 'svc' to type 'owner-type'");
    expect(out).toContain("from type 'web' to type 'db'");
    const fix = fieldLines(out, 'fix').join('\n');
    expect(fix).toContain("add a relations entry for 'svc' -> 'owner-type'");
    expect(fix).toContain("add a relations entry for 'web' -> 'db'");
  });

  // type-strict-orphan (core/checks/mapping.ts) carries neither nodePath nor
  // unitKey, so many unrelated files satisfying the SAME strict type land in
  // ONE repo-level block. A per-member fix list for such a block must stay
  // bounded like the member list is: a 200-file strict type once produced
  // 200 near-duplicate sentences.
  it('a divergent repo-level block states its why once and keeps its fix bounded', () => {
    const orphan = (relPath: string, typeId: string): CheckIssue => ({
      severity: 'error', code: 'type-strict-orphan', rule: 'type-strict-orphan',
      messageData: {
        what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\nBut file is not in any node's mapping.`,
        why: `Type '${typeId}' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type '${typeId}'. Otherwise the file looks like a ${typeId} but bypasses ${typeId}-level enforcement.`,
        next: `Create yg-node.yaml with type: ${typeId} and add '${relPath}' to its mapping.`,
      },
    } as CheckIssue);
    const issues: CheckIssue[] = [
      ...Array.from({ length: 20 }, (_, i) => orphan(`src/suite/case-${i}.test.ts`, 'test-suite')),
      orphan('src/other/thing.ts', 'other-type'),
    ];
    const out = blocks(issues);
    // One block per why, each stating it once.
    expect(headings(out)).toHaveLength(2);
    expect(out.split('\n').filter((l) => l.startsWith('  why:'))).toHaveLength(2);
    // The fix never grows with the member count past the cap a member list has.
    expect(fieldLines(out, 'fix').length).toBeLessThanOrEqual(MEMBER_CAP + 2);
    // Every member's own file still renders in the uncapped view.
    const all = blocks(issues, false);
    for (let i = 0; i < 20; i++) expect(all).toContain(`src/suite/case-${i}.test.ts`);
    expect(all).toContain('src/other/thing.ts');
  });
});

describe('check render — counts reconcile', () => {
  it('2 unverified(x) + 1 refused(y) → a verdict line of 3 errors, a refused block of 1 and an unverified block of 2', () => {
    const issues: CheckIssue[] = [
      ...['svc/a', 'svc/b'].map((n) => ({
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
        nodePath: 'svc/a',
        messageData: llmRefusedMessage({ aspectId: 'y', unitKey: 'svc/a', reason: 'r' }),
      } as CheckIssue,
    ];
    const out = report(issues);
    expect(out.split('\n')[0]).toBe('yg check: FAIL  3 errors in 2 blocks   1 node');
    // Code and graph errors (T1) before pending pairs (T3).
    expect(headings(out)).toEqual(['error[refused] y — refused on svc/a', 'error[unverified] 2 pairs with no verdict yet']);
    expect(out).toContain('  at:   x  2 pairs · 2 nodes · reviewer');
  });
});

describe('check render — --details view', () => {
  const three: CheckIssue[] = ['node-a', 'node-b', 'node-c'].map((n) => ({
    severity: 'error',
    code: 'unverified',
    rule: 'unverified',
    aspectId: 'audit-logging',
    pairKind: 'llm',
    nodePath: n,
    messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: `${n}#audit-logging` }),
  } as CheckIssue));

  it('lists every pair of a rule on its own line, where the default view collapses them into one', () => {
    const detailsOut = report(three, { kind: 'details' });
    const fullOut = report(three, { kind: 'full' });
    expect(detailsOut).toContain('  at:   audit-logging @ node-a');
    expect(detailsOut).toContain('        audit-logging @ node-b');
    expect(detailsOut).toContain('        audit-logging @ node-c');
    expect(fullOut).toContain('  at:   audit-logging  3 pairs · 3 nodes · reviewer');
    expect(fullOut).not.toContain('@ node-a');
  });

  it('keeps the true verdict line and the same next: as the default view', () => {
    const forbidden = {
      severity: 'error', code: 'relation-target-forbidden', rule: 'relation-target-forbidden', nodePath: 'a/x',
      messageData: { what: 'forbidden on a/x', why: 'w', next: 'Change the relation type for a/x.' },
    } as CheckIssue;
    const issues = [...three.slice(0, 2), forbidden];
    const out = report(issues, { kind: 'details' });
    expect(out.split('\n')[0]).toBe('yg check: FAIL  3 errors in 2 blocks   1 node   view: details');
    const nextOf = (text: string): string[] => text.split('\n').filter((l) => /^(next|then): /.test(l));
    expect(nextOf(out)).toEqual(nextOf(report(issues)));
    expect(nextOf(out)[0]).toBe('next: Change the relation type for a/x  (relation-target-forbidden)');
  });
});


// ── Nodeless (type-covered-file) members ───────────────

describe('blocks — nodeless members', () => {
  function fileIssue(unitKey: string, aspectId = 'own-file-rule'): CheckIssue {
    return {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId,
      pairKind: 'deterministic',
      nodePath: undefined,
      unitKey,
      messageData: unverifiedMessage({ aspectId, unitKey }),
    } as CheckIssue;
  }
  function nodeIssue(nodePath: string, aspectId = 'own-file-rule'): CheckIssue {
    return {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId,
      pairKind: 'deterministic',
      nodePath,
      unitKey: `node:${nodePath}`,
      messageData: unverifiedMessage({ aspectId, unitKey: `node:${nodePath}` }),
    } as CheckIssue;
  }

  it('a nodeless member renders its FILE, never an empty member or the literal word "undefined"', () => {
    const out = blocks([fileIssue('file:src/leaf/a.ts')]);
    expect(out).toContain('  at:   own-file-rule @ src/leaf/a.ts');
    expect(out).not.toMatch(/undefined/);
    expect(out).not.toMatch(/@ *$/m);
  });

  it('a block mixing components and files counts both, and lists each in the uncapped view', () => {
    const issues = [nodeIssue('svc-a'), fileIssue('file:src/leaf/a.ts'), nodeIssue('svc-b'), fileIssue('file:src/leaf/b.ts')];
    expect(blocks(issues)).toContain('  at:   own-file-rule  4 pairs · 2 nodes · 2 files · script');
    const all = blocks(issues, false);
    for (const u of ['svc-a', 'svc-b', 'src/leaf/a.ts', 'src/leaf/b.ts']) expect(all).toContain(`own-file-rule @ ${u}`);
  });

  it('a block that is ALL file-level (zero components) is not treated as repo-level — it counts and lists its files', () => {
    const issues = [fileIssue('file:src/leaf/a.ts'), fileIssue('file:src/leaf/b.ts')];
    expect(blocks(issues)).toContain('  at:   own-file-rule  2 pairs · 2 files · script');
    const all = blocks(issues, false);
    expect(all).toContain('own-file-rule @ src/leaf/a.ts');
    expect(all).toContain('own-file-rule @ src/leaf/b.ts');
  });

  it('a file member is never hidden behind the component members (counted when capped, listed when not)', () => {
    const issues = [...Array.from({ length: 13 }, (_, i) => nodeIssue(`svc-${i}`)), fileIssue('file:src/leaf/only-file.ts')];
    expect(blocks(issues)).toContain('  at:   own-file-rule  14 pairs · 13 nodes · 1 file · script');
    const all = blocks(issues, false);
    expect(all).toContain('own-file-rule @ src/leaf/only-file.ts');
    expect(all.split('\n').filter((l) => / @ svc-\d+$/.test(l))).toHaveLength(13);
  });
});

// Issue 208 (m12): remedy 4 used to read as if raising the cap re-billed a tier.
describe('prompt-too-large remedy tells the truth about cost (issue 208, m12)', () => {
  it('raising the cap re-verifies nothing; moving tiers re-reviews the aspect', () => {
    const msg = promptTooLargeMessage({ aspectId: 'a', unitKey: 'node:core', tierName: 'standard', chars: 62618, limit: 50000 });
    expect(msg.next).toContain("4. Raise max_prompt_chars on the 'standard' tier (now 50000)");
    expect(msg.next).toContain('raising it re-verifies nothing');
    expect(msg.next).toContain('re-reviews every pair of the aspect, because the tier name is part of each pair\'s hash');
    expect(msg.next).not.toContain('cascade re-verification across every aspect');
  });
});

// ── Grouped headings, whys and fixes state a shared fact once (issue 231) ──
describe('check render — a grouped block never shows a placeholder or a fake path', () => {
  /** Every finding code the engine emits, read from the source that emits it. */
  function emittedCodes(): string[] {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src');
    const codes = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) for (const m of readFileSync(p, 'utf-8').matchAll(/\bcode: '([a-z][a-z0-9-]+)'/g)) codes.add(m[1]);
      }
    };
    walk(root);
    return [...codes].sort();
  }

  /** The words a heading or a why may never carry after grouping. */
  function assertSaidOnce(text: string, nodes: string[]): void {
    expect(text).not.toMatch(/<node>/);
    expect(text).not.toMatch(/each node\/|\/each node|the node\//);
    for (const n of nodes) expect(text).not.toContain(`/${n}/`);
  }

  it('every code: the heading and the why of a block grouped over three nodes carry no <node> and no path with a node substituted into it', () => {
    const nodes = ['billing', 'orders/api', 'shared'];
    const codes = emittedCodes();
    expect(codes.length).toBeGreaterThan(40);
    for (const code of codes) {
      const issues: CheckIssue[] = nodes.map((n) => ({
        severity: 'error', code, rule: code, nodePath: n,
        messageData: {
          what: `yg-node.yaml in ${n} breaks the node schema: yg-node.yaml at /tmp/x/.yggdrasil/model/${n}/yg-node.yaml: mapping is bad`,
          why: `Node '${n}' matters: component '${n}' was not loaded, see .yggdrasil/model/${n}/yg-node.yaml, and ${n} reads as missing.`,
          next: `Correct .yggdrasil/model/${n}/yg-node.yaml.`,
        },
      } as CheckIssue));
      for (const b of buildBlocks(issues)) {
        if (b.members.length < 2) continue;
        assertSaidOnce(b.subject, nodes);
        if (b.why !== undefined) assertSaidOnce(b.why, nodes);
      }
    }
  });

  it('yaml-invalid in three nodes, as the loader words it: one heading with the shared reason, the why about "the component", the fix templated', () => {
    const issues: CheckIssue[] = ['billing', 'orders', 'shared'].map((n) => ({
      severity: 'error', code: 'yaml-invalid', rule: 'yaml-invalid', nodePath: n,
      messageData: {
        what: `yg-node.yaml in ${n} breaks the node schema: mapping must be an array of file/directory paths`,
        why: `The file is valid YAML but does not match the node schema, so component '${n}' was not loaded: a flow or relation naming it reads it as missing, and the files it maps read as unmapped, until it is corrected.`,
        next: `Correct what the reason above names in .yggdrasil/model/${n}/yg-node.yaml (yg schemas read node lists the allowed fields).`,
      },
    } as CheckIssue));
    const out = blocks(issues);
    expect(headings(out)).toEqual(['error[yaml-invalid] 3 nodes: yg-node.yaml in each node breaks the node schema: mapping must be an array of file/directory paths']);
    expect(out).toContain('  why:  The file is valid YAML but does not match the node schema, so the component was not loaded:');
    expect(out).toContain('  fix:  Correct what the reason above names in .yggdrasil/model/<node>/yg-node.yaml (yg schemas read node lists the allowed fields).  for each node above');
  });

  it('a why templated over a node path says "the node\'s <file>", never a path with the node substituted', () => {
    const issues: CheckIssue[] = ['a', 'b'].map((n) => ({
      severity: 'error', code: 'some-code', rule: 'some-code', nodePath: n,
      messageData: { what: `Node '${n}' is broken`, why: `Node '${n}' reads .yggdrasil/model/${n}/yg-node.yaml.`, next: 'Fix it.' },
    } as CheckIssue));
    const out = blocks(issues);
    expect(headings(out)).toEqual(['error[some-code] 2 nodes are broken']);
    expect(out).toContain("  why:  The node reads the node's yg-node.yaml.");
  });

  it('type-undefined-pending over two nodes: ONE templated fix for each node above, each node\'s own path beside it', () => {
    // Worded as core/checks/architecture.ts words it; the golden corpus state
    // grouped-templates runs the real producer end to end.
    const issues: CheckIssue[] = ['billing', 'orders'].map((n) => ({
      severity: 'warning', code: 'type-undefined-pending', rule: 'type-undefined-pending', nodePath: n,
      messageData: {
        what: "Node type 'module' is not defined — yg-architecture.yaml declares no node types yet.",
        why: 'While node_types is empty, node types are not checked. Once any type is declared, every node whose type is missing becomes a blocking type-undefined error, and a type whose nodes map files must declare when:.',
        next: `Define 'module' under node_types in yg-architecture.yaml with a when: predicate matching its files (an architecture change — ask the user to approve it first). yg type-suggest --file src/${n} can help design it.`,
      },
    } as CheckIssue));
    const out = report(issues);
    const fix = fieldLines(out, 'fix');
    expect(fix).toEqual([
      "  fix:  Define 'module' under node_types in yg-architecture.yaml with a when: predicate matching its files (an architecture change — ask the user to approve it first). yg type-suggest --file <path> can help design it.  for each node above, <path> as listed beside it",
    ]);
    expect(out).toContain('  at:   billing  <path> = src/billing');
    expect(out).toContain('        orders   <path> = src/orders');
    expect(out).not.toMatch(/^\s+billing: Define/m);
  });

  it('a fix that differs by more than one path word stays per member', () => {
    const issues: CheckIssue[] = ['a', 'b'].map((n, i) => ({
      severity: 'warning', code: 'some-code', rule: 'some-code', nodePath: n,
      messageData: { what: 'Something is off', why: 'Because.', next: i === 0 ? 'Run yg x --file src/a now.' : 'Run yg y --file src/b now.' },
    } as CheckIssue));
    const out = blocks(issues);
    expect(fieldLines(out, 'fix')).toEqual(['  fix:  a: Run yg x --file src/a now.', '        b: Run yg y --file src/b now.']);
  });

  it('the verdict line says how many blocks hold the findings when the two numbers differ', () => {
    const issues: CheckIssue[] = [
      ...['a', 'b', 'c'].map((n) => ({ severity: 'error', code: 'yaml-invalid', rule: 'yaml-invalid', nodePath: n, messageData: { what: `yg-node.yaml in ${n} does not parse: x`, why: 'w', next: 'f' } } as CheckIssue)),
      ...['d', 'e'].map((n) => ({ severity: 'error', code: 'description-missing', rule: 'description-missing', nodePath: n, messageData: { what: 'Node has no description', why: 'w', next: 'f' } } as CheckIssue)),
      { severity: 'warning', code: 'some-warning', rule: 'some-warning', nodePath: 'a', messageData: { what: 'One thing', why: 'w', next: 'f' } } as CheckIssue,
    ];
    expect(report(issues).split('\n')[0]).toBe('yg check: FAIL  5 errors in 2 blocks · 1 warning   1 node');
  });
});
