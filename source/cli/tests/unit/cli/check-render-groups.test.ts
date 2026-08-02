import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/cli/check-render-views.js';
import { renderGroup } from '../../../src/cli/check-render-groups.js';
import { groupIssues } from '../../../src/cli/group-issues.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
  promptTooLargeMessage,
} from '../../../src/formatters/lock-issue-messages.js';
import { typeGateForbiddenMessage } from '../../../src/relations/messages.js';

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
 * Unit tests for the `yg check` grouped/--details render layer
 * (check-render-groups.ts): the Errors/Warnings sections, per-group and
 * per-issue blocks, the unmapped-files compact block, and the
 * CAP_NODES/GROUP_CAP truncation logic. These exercise the rendering
 * directly against constructed CheckResult objects — no spawned binary, no
 * build — so they pin the agent-facing OUTPUT contract:
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

  // type-relation-forbidden findings carry no nodePath (a finding is about a
  // (fromType, toType) PAIR, not a graph node), so groupIssues scores them
  // nodeCount === 0 and renderGroup dispatches to renderRepoLevelGroup — which,
  // before this fix, suppressed `next` entirely whenever it diverged across
  // members (no per-member fallback, unlike renderGroup's own emitDivergentDetail),
  // leaving the agent with NO Fix line at all once 2+ distinct forbidden pairs
  // were present in the same run.
  it('TWO distinct forbidden type pairs (repo-level, no nodePath) each render their OWN Fix line', () => {
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
    const [g] = groupIssues(issues);
    expect(g.nodeCount).toBe(0); // confirms the repo-level render path is the one under test
    expect(g.divergentNext).toBe(true); // each pair's Fix names its own fromType/toType
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain("'svc' -> 'owner-type'");
    expect(out).toContain("'web' -> 'db'");
    const fixLines = out.split('\n').filter((l) => /^ {12}Fix: /.test(l));
    expect(fixLines).toHaveLength(2);
  });

  // type-strict-orphan (core/checks/mapping.ts) carries neither nodePath nor
  // unitKey, so many unrelated files satisfying the SAME strict type land in
  // ONE repo-level group. Mix in a second, genuinely different strict type and
  // the group scores divergentWhy/divergentNext true across ALL its members —
  // exactly the shape a real repository hits with two `enforce: strict` types
  // both missing mappings. No `type_level` config is involved anywhere in this
  // fixture: `type-strict-orphan` predates the type-tier feature and fires
  // with the tier off. Before this fix, the per-member fallback added for the
  // (tier-only) type-relation-forbidden gate fired for this code too, printing
  // an identical boilerplate Why/Fix pair after every single orphaned file —
  // a 200-file strict type produced 200 near-duplicate sentences. The fix
  // scopes the per-member fallback to `perMemberReason` codes (today, only the
  // type gate), so a non-gate divergent group renders exactly what it always
  // did: each member's own `what`, and nothing else — the flag-off byte stays
  // untouched by this release for every code that predates it.
  it('a divergent repo-level group OUTSIDE the type gate renders no per-member Why/Fix at all', () => {
    const orphan = (relPath: string, typeId: string): CheckIssue => ({
      severity: 'error', code: 'type-strict-orphan', rule: 'type-strict-orphan',
      messageData: {
        what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\nBut file is not in any node's mapping.`,
        why: `Type '${typeId}' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type '${typeId}'. Otherwise the file looks like a ${typeId} but bypasses ${typeId}-level enforcement.`,
        next: `Create yg-node.yaml with type: ${typeId} and add '${relPath}' to its mapping.`,
      },
    } as CheckIssue);
    const issues: CheckIssue[] = [
      ...Array.from({ length: 5 }, (_, i) => orphan(`src/suite/case-${i}.test.ts`, 'test-suite')),
      orphan('src/other/thing.ts', 'other-type'),
    ];
    const [g] = groupIssues(issues);
    expect(g.nodeCount).toBe(0);
    expect(g.fileCount).toBe(0); // repo-level: no nodePath, no `file:`-prefixed unitKey
    expect(g.divergentWhy).toBe(true); // 'test-suite' text != 'other-type' text
    expect(g.divergentNext).toBe(true);
    expect(g.perMemberReason).toBe(false); // type-strict-orphan is not a FULL_WHAT_CODES code
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    // No Why:/Fix: line anywhere — matches the pre-existing (pre-release)
    // rendering for this divergent case exactly; only the shared-block guards
    // below the loop could still fire, and they are gated on `!divergentWhy`.
    expect(out).not.toMatch(/^ {12}Why: /m);
    expect(out).not.toMatch(/^ {12}Fix: /m);
    // Every member's own `what` (the specific file) still renders — that part
    // of the grouping was never in question.
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`src/suite/case-${i}.test.ts`);
    }
    expect(out).toContain('src/other/thing.ts');
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


// ── Nodeless (type-covered-file) members — two-block rendering ───────────────

describe('renderGroup — nodeless members', () => {
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

  it('a nodeless member renders its FILE, never an empty bullet or the literal word "undefined"', () => {
    const [g] = groupIssues([fileIssue('file:src/leaf/a.ts')]);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('- src/leaf/a.ts');
    expect(out).not.toMatch(/undefined/);
    expect(out).not.toMatch(/^\s*-\s*$/m); // no bare empty bullet line
  });

  it('renders components in one block and files in a SEPARATE block after them', () => {
    const [g] = groupIssues([
      nodeIssue('svc-a'),
      fileIssue('file:src/leaf/a.ts'),
      nodeIssue('svc-b'),
      fileIssue('file:src/leaf/b.ts'),
    ]);
    expect(g.nodeCount).toBe(2);
    expect(g.fileCount).toBe(2);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    const svcAIdx = out.indexOf('- svc-a');
    const svcBIdx = out.indexOf('- svc-b');
    const fileAIdx = out.indexOf('- src/leaf/a.ts');
    const fileBIdx = out.indexOf('- src/leaf/b.ts');
    expect([svcAIdx, svcBIdx, fileAIdx, fileBIdx].every((i) => i >= 0)).toBe(true);
    // Every component bullet precedes every file bullet.
    expect(Math.max(svcAIdx, svcBIdx)).toBeLessThan(Math.min(fileAIdx, fileBIdx));
  });

  it('the group header names BOTH components and files when the group mixes them', () => {
    const [g] = groupIssues([nodeIssue('svc-a'), fileIssue('file:src/leaf/a.ts')]);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('2 pairs  1 nodes, 1 files');
  });

  it('a group that is ALL file-level (zero real components) is not treated as repo-level — it still gets per-file bullets', () => {
    const [g] = groupIssues([fileIssue('file:src/leaf/a.ts'), fileIssue('file:src/leaf/b.ts')]);
    expect(g.nodeCount).toBe(0);
    expect(g.fileCount).toBe(2);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('2 pairs  2 files');
    expect(out).toContain('- src/leaf/a.ts');
    expect(out).toContain('- src/leaf/b.ts');
  });

  it('a file member never consumes the component block’s cap (independent caps, TTY truncation)', () => {
    const nodeMembers = Array.from({ length: 13 }, (_, i) => nodeIssue(`svc-${i}`));
    const fileMembers = [fileIssue('file:src/leaf/only-file.ts')];
    const [g] = groupIssues([...nodeMembers, ...fileMembers]);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: true });
    const out = stripAnsi(lines.join('\n'));
    // 13 components > CAP_NODES(12) → component block truncates ("... and 1 more").
    expect(out).toContain('... and 1 more');
    // The lone file member still renders — it was never displaced by the
    // component overflow, because it lives in its own block with its own cap.
    expect(out).toContain('- src/leaf/only-file.ts');
  });
});
