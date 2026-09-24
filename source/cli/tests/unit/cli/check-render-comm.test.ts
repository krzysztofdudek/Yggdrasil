/**
 * The communication fixes to the `yg check` report (renderer and machine
 * document): member lists bounded by the view in every sink, file units and
 * collapsed per-file rows, every line of a finding rendered, graph-invalid
 * findings first under a partial-result banner, the gate abort as a report,
 * templated fixes, cost on the fill command, agreeing counts, and the additive
 * yg-check/1 fields (label, unitRef, violations, edges, files, groups, banner,
 * aborted).
 */
import { describe, it, expect } from 'vitest';
import { formatOutput, formatAbort, enrichCheckJson, abortCheckJson } from '../../../src/cli/check-render-views.js';
import { buildCheckJson, checkJsonIssueOf } from '../../../src/core/check-json.js';
import { computeSuggestedNext } from '../../../src/core/check-suggested-next.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import { unverifiedMessage, detRefusedMessage } from '../../../src/formatters/lock-issue-messages.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function result(issues: CheckIssue[], extra: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'test',
    nodeCount: 1,
    nodeTypeCounts: new Map(),
    aspectCount: 1,
    flowCount: 1,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: computeSuggestedNext(issues),
    advisoryWarnings: 0,
    draftSkipped: 0,
    verifiedDet: 0,
    verifiedLlm: 0,
    pairs: [],
    ...extra,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

function unverified(node: string, aspect: string, unit = `node:${node}`, kind: 'llm' | 'deterministic' = 'llm'): CheckIssue {
  return {
    severity: 'error',
    code: 'unverified',
    rule: 'unverified',
    nodePath: node,
    aspectId: aspect,
    unitKey: unit,
    pairKind: kind,
    messageData: unverifiedMessage({ aspectId: aspect, unitKey: unit }),
  } as CheckIssue;
}

describe('member lists are bounded by the view, in every sink', () => {
  const many = Array.from({ length: 24 }, (_, i) => unverified(`app/svc-${pad(i + 1)}`, 'readable-names'));
  // 15 rules × 2 nodes: more `at:` lines than the cap in the capped views.
  const wideRules = Array.from({ length: 30 }, (_, i) => unverified(`app/svc-${pad(i)}`, `rule-${pad(i % 15)}`));
  const atRows = (out: string): string[] => out.split('\n').filter((l) => /^ {2}at: {3}| {8}\S/.test(l) && !/^ {8}… \+/.test(l));

  it('the default view caps a block at 12 lines even when stdout is not a terminal, and names the drill', () => {
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const out = stripAnsi(formatOutput(result(wideRules), { kind: 'full' }, false, false));
      expect(out.split('\n').filter((l) => /rule-\d\d {2}2 pairs · 2 nodes · reviewer$/.test(l))).toHaveLength(12);
      expect(out).toContain('        … +6 more  (yg check --details)');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    }
  });

  it('the default view states one rule\'s pairs as one line, with their count', () => {
    const out = stripAnsi(formatOutput(result(many), { kind: 'full' }, false, false));
    expect(out).toContain('  at:   readable-names  24 pairs · 24 nodes · reviewer');
    expect(out).not.toContain('readable-names @ app/svc-');
  });

  it('--top caps the members of the blocks it shows', () => {
    const out = stripAnsi(formatOutput(result(wideRules), { kind: 'top', n: 1 }, false, false));
    expect(out.split('\n').filter((l) => /rule-\d\d {2}2 pairs/.test(l))).toHaveLength(12);
    expect(out).toContain('… +6 more  (yg check --details)');
  });

  it('the drill-in view shows every member', () => {
    const out = stripAnsi(formatOutput(result(many), { kind: 'aspect', id: 'readable-names' }, false, false));
    expect(out.split('\n').filter((l) => /readable-names @ app\/svc-\d\d$/.test(l))).toHaveLength(24);
    expect(out).not.toContain('more  (yg check');
    expect(atRows(out)).toHaveLength(24);
  });

  it('--summary by node is bounded: the busiest rows, then one counted line', () => {
    const wide = Array.from({ length: 30 }, (_, i) => unverified(`n${pad(i)}`, 'r'));
    const out = stripAnsi(formatOutput(result(wide), { kind: 'summary', by: 'nodes' }, false, false));
    expect(out.split('\n').filter((l) => /^n\d\d {2}unverified 1$/.test(l))).toHaveLength(24);
    expect(out).toContain('… +6 more rows with 6 findings  (yg check --details)');
  });

  it('--summary rolls every finding into one line per severity', () => {
    const wide = Array.from({ length: 30 }, (_, i) => unverified(`n${pad(i)}`, 'r'));
    const out = stripAnsi(formatOutput(result(wide), { kind: 'summary' }, false, false));
    expect(out).toContain('errors    unverified 30 (30 reviewer)');
  });

  it('a code-only block spanning several rules drills into the per-issue view', () => {
    const out = stripAnsi(formatOutput(result(wideRules), { kind: 'full' }, false, false));
    expect(out).toContain('… +6 more  (yg check --details)');
  });
});

describe('per-file pairs carry their file, and no member line repeats', () => {
  const issues = [
    unverified('app/a', 'self-contained', 'file:src/a/one.ts', 'deterministic'),
    unverified('app/a', 'self-contained', 'file:src/a/two.ts', 'deterministic'),
    unverified('app/a', 'self-contained', 'file:src/a/three.ts', 'deterministic'),
    unverified('app/b', 'self-contained', 'file:src/b/only.ts', 'deterministic'),
    unverified('app/b', 'no-todo', 'node:app/b', 'deterministic'),
  ];

  it('the capped view collapses one rule\'s pairs into one counted line, and names a lone pair', () => {
    const out = stripAnsi(formatOutput(result(issues), { kind: 'full' }, false, false));
    expect(out).toContain('  at:   self-contained  4 pairs · 2 nodes · script');
    expect(out).toContain('        no-todo @ app/b');
  });

  it('the details view names each pair by its file, and no member line repeats', () => {
    const out = stripAnsi(formatOutput(result(issues), { kind: 'details' }, false, false));
    for (const f of ['src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'src/b/only.ts']) expect(out).toContain(`self-contained @ ${f}`);
    expect(out).toContain('no-todo @ app/b');
    const members = out.split('\n').filter((l) => / @ /.test(l));
    expect(members).toHaveLength(5);
    expect(new Set(members).size).toBe(members.length);
  });
});

describe('every line of a finding is rendered', () => {
  const typeIssue = (node: string): CheckIssue => ({
    severity: 'error',
    code: 'type-without-when-with-mapping',
    rule: 'type-without-when-with-mapping',
    nodePath: node,
    messageData: {
      what: `Node '${node}' has type 'service' but mapping is not empty:\n  mapping:\n  - src/${node.split('/').pop()}.ts`,
      why: 'Types without when are organizational.',
      next: 'Add a when predicate.',
    },
  } as CheckIssue);

  it('a finding with a multi-line what keeps its continuation lines', () => {
    const out = stripAnsi(formatOutput(result([typeIssue('app/x')]), { kind: 'full' }, false, false));
    expect(out).toContain("error[type-without-when-with-mapping] Node 'app/x' has type 'service' but mapping is not empty:");
    expect(out).toContain('  at:   app/x');
    expect(out).toContain('          - src/x.ts');
  });

  it('a block of several members that say the same thing about their own node still says it once', () => {
    // The members' first lines differ only by the node, so each entry lists
    // only its node — the heading must then carry what they all say, or the
    // finding's sentence is on no line of the report at all.
    const out = stripAnsi(formatOutput(result([typeIssue('app/x'), typeIssue('app/z')]), { kind: 'full' }, false, false));
    expect(out).toContain("has type 'service' but mapping is not empty");
    expect(out).toContain('          - src/x.ts');
    expect(out).toContain('          - src/z.ts');
  });

  it('the per-issue view shows every line of what for every code', () => {
    const issue = {
      severity: 'error',
      code: 'yaml-invalid',
      rule: 'invalid-node-yaml',
      nodePath: 'app/y',
      messageData: { what: 'yg-node.yaml in app/y does not parse: bad indentation\nbad: [unclosed\n^', why: 'not loaded', next: 'Fix the YAML.' },
    } as CheckIssue;
    const out = stripAnsi(formatOutput(result([issue]), { kind: 'details' }, false, false));
    expect(out).toContain('bad: [unclosed');
  });

  it('a coverage block renders every line of its fix', () => {
    const issue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-file',
      uncoveredFiles: ['src/a.ts'],
      uncoveredCount: 1,
      messageData: { what: '1 file.\n  src/a.ts', why: 'No node maps it.', next: 'Map it to a node.\nThen: add to an existing node mapping, or create a new node.' },
    } as CheckIssue;
    const out = stripAnsi(formatOutput(result([issue]), { kind: 'full' }, false, false));
    expect(out).toContain('  fix:  Map it to a node.');
    expect(out).toContain('        Then: add to an existing node mapping, or create a new node.');
  });
});

describe('a graph that did not load as written leads the report', () => {
  const yamlInvalid = {
    severity: 'error',
    code: 'yaml-invalid',
    rule: 'invalid-node-yaml',
    nodePath: 'model/cart',
    messageData: { what: 'yg-node.yaml in model/cart does not parse: x', why: 'not loaded', next: 'Fix the YAML in .yggdrasil/model/model/cart/yg-node.yaml.' },
  } as CheckIssue;
  const flowBroken = {
    severity: 'error',
    code: 'flow-node-broken',
    rule: 'broken-flow-ref',
    messageData: { what: "Flow 'Checkout' names node 'model/cart', whose yg-node.yaml did not parse.", why: 'symptom', next: 'Fix the YAML.' },
  } as CheckIssue;

  it('renders the graph-invalid block first, under a partial-result banner, and next names its fix', () => {
    const issues = [unverified('app/a', 'r'), flowBroken, yamlInvalid];
    const out = stripAnsi(formatOutput(result(issues), { kind: 'full' }, false, false));
    const lines = out.split('\n');
    // The banner comes right after the verdict line, before any finding.
    expect(lines[2]).toBe('partial: 1 component file did not parse (model/cart), so that component was left out — the findings below were computed without it and may be symptoms of it; fix it first.');
    expect(out.indexOf('error[yaml-invalid]')).toBeLessThan(out.indexOf('error[unverified]'));
    expect(out.indexOf('error[yaml-invalid]')).toBeLessThan(out.indexOf('error[flow-node-broken]'));
    expect(out).toContain('next: edit .yggdrasil/model/model/cart/yg-node.yaml  (yaml-invalid — 2 errors need a code or graph fix)');
    expect(out).toContain('then: yg check --approve  (1 reviewer pair · paid)');
  });

  it('a config that does not parse outranks everything else in Next', () => {
    const configInvalid = { severity: 'error', code: 'config-invalid', rule: 'invalid-config', messageData: { what: 'yg-config.yaml does not parse: x', why: 'defaults used', next: 'Fix the syntax error in .yggdrasil/yg-config.yaml.' } } as CheckIssue;
    expect(computeSuggestedNext([unverified('app/a', 'r'), yamlInvalid, configInvalid])).toBe('Fix the syntax error in .yggdrasil/yg-config.yaml.');
  });

  it('prints no banner on an ordinary run', () => {
    expect(stripAnsi(formatOutput(result([unverified('app/a', 'r')]), { kind: 'full' }, false, false))).not.toContain('partial:');
  });
});

describe('the gate abort is a report', () => {
  const gate = (node: string): CheckIssue => ({
    severity: 'error',
    code: 'log-entry-missing',
    rule: 'log-entry-missing',
    nodePath: node,
    messageData: {
      what: `No log entry for node '${node}' — mandatory before its first verdicts are recorded.`,
      why: "Node type 'service' has log_required: true.",
      next: `yg log add --node ${node} --reason '<why this change was made>', then re-run: yg check --approve --only-deterministic`,
    },
  } as CheckIssue);
  const issues = Array.from({ length: 14 }, (_, i) => gate(`app/svc-${pad(i + 1)}`));

  it('heads it with an ABORTED verdict line, groups the findings with one templated fix, and keeps the user\'s flags in then', () => {
    const out = stripAnsi(formatAbort({ stage: 'log-gate', issues, retry: 'yg check --approve --only-deterministic' }, false));
    expect(out.split('\n')[0]).toBe('yg check: ABORTED  nothing recorded — 14 nodes need a log entry first');
    expect(out).toContain('error[log-entry-missing] 14 nodes have no log entry yet — one is owed before their first verdicts are recorded');
    expect(out).toContain("  fix:  yg log add --node <node> --reason '<why this change was made>', then re-run: yg check --approve --only-deterministic  for each node above");
    expect(out.split('\n').filter((l) => /^ {2}at: {3}app\/svc-|^ {8}app\/svc-/.test(l))).toHaveLength(12);
    expect(out).toContain('… +2 more  (yg check --details)');
    expect(out).toContain("next: yg log add --node app/svc-01 --reason '<why this change was made>'");
    expect(out).toContain('then: yg check --approve --only-deterministic');
  });

  it('a structural abort names the re-run with the user\'s flags', () => {
    const structural = { severity: 'error', code: 'config-reviewer-missing', rule: 'config-reviewer-missing', messageData: { what: 'No reviewer.', why: 'w', next: 'yg init --provider <name>' } } as CheckIssue;
    const out = stripAnsi(formatAbort({ stage: 'structural', issues: [structural], retry: 'yg check --approve --dry-run' }, false));
    expect(out.split('\n')[0]).toBe('yg check: ABORTED  nothing ran — 1 problem must be fixed first');
    expect(out).toContain('next: yg init --provider <name>\nthen: yg check --approve --dry-run');
  });

  it('writes a yg-check/1 document with exit.status "aborted" and the gating findings', () => {
    const doc = abortCheckJson(buildCheckJson(result([])), { stage: 'log-gate', issues }, checkJsonIssueOf);
    expect(doc.exit.status).toBe('aborted');
    expect(doc.exit.code).toBe(1);
    expect(doc.aborted?.stage).toBe('log-gate');
    expect(doc.aborted?.issues).toHaveLength(14);
    expect(doc.aborted?.issues[0].code).toBe('log-entry-missing');
  });
});

describe('counts agree with their nouns, and the fill command names its cost', () => {
  it('singular verdict-line segments and block counts', () => {
    const out = stripAnsi(formatOutput(result([unverified('app/a', 'r')]), { kind: 'full' }, false, false));
    expect(out.split('\n')[0]).toBe('yg check: FAIL  1 error   1 node');
    expect(out).toContain('error[unverified] 1 pair with no verdict yet');
    expect(out).toContain('  fix:  yg check --approve  (1 reviewer pair · paid)');
  });

  it('the unverified block\'s fill says what it costs, free and paid apart', () => {
    const out = stripAnsi(formatOutput(result([unverified('app/a', 'r'), unverified('app/b', 's', 'node:app/b', 'deterministic')]), { kind: 'full' }, false, false));
    expect(out).toContain('error[unverified] 2 pairs with no verdict yet');
    expect(out).toContain('  fix:  yg check --approve  (1 script pair · free + 1 reviewer pair · paid)');
  });
});

describe('yg-check/1 carries the structure next to the prose', () => {
  it('violations, files, unitRef, label, groups and banner', () => {
    const refused = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'app',
      aspectId: 'no-todo',
      unitKey: 'node:app',
      messageData: detRefusedMessage({ aspectId: 'no-todo', unitKey: 'node:app', reason: 'src/a.ts:3: TODO left\nsrc/b.ts:9: TODO left' }),
    } as CheckIssue;
    const unmapped = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-file',
      uncoveredFiles: Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`),
      uncoveredCount: 15,
      messageData: { what: '15 files.', why: 'w', next: 'n' },
    } as CheckIssue;
    const r = result([refused, unmapped]);
    const doc = enrichCheckJson(buildCheckJson(r), r);
    expect(doc.issues[0].violations).toEqual([
      { file: 'src/a.ts', line: 3, message: 'TODO left' },
      { file: 'src/b.ts', line: 9, message: 'TODO left' },
    ]);
    expect(doc.issues[0].unitRef).toEqual({ kind: 'node', path: 'app' });
    expect(doc.issues[0].label).toBe('refused');
    expect(doc.issues[1].files).toHaveLength(15);
    expect(doc.issues[1].label).toBe('unmapped');
    expect(doc.groups?.map((g) => g.code)).toEqual(['aspect-violation-enforced', 'unmapped-files']);
    expect(doc.groups?.[0].members).toEqual([0]);
    expect(doc.groups?.[0].why).toBe(refused.messageData.why);
    expect(doc.groups?.[0].label).toBe('refused');
    expect(doc.groups?.[0].subject).toBe('no-todo — 2 violations in app');
    expect(doc.groups?.[1].subject).toBe('15 files belong to no node');
    expect(doc.banner).toBeNull();
    // suggestedNext is the text of the report's own next: line, and next the same step as data.
    expect(doc.suggestedNext).toBe('edit src/a.ts:3  (refused — 2 errors need a code or graph fix)');
    expect(doc.next?.text).toBe('edit src/a.ts:3');
    expect(doc.next?.target).toEqual({ node: 'app', file: 'src/a.ts' });
    expect(doc.next?.remaining).toEqual({ needsFix: 2, fillable: 0 });
  });

  it('the undeclared-dependency edges', () => {
    const rel = {
      severity: 'error',
      code: 'relation-undeclared-dependency',
      rule: 'relation-undeclared-dependency',
      nodePath: 'web',
      messageData: { what: "Node 'web' has undeclared dependencies on other nodes:\nsrc/web/h.ts:5 → data", why: 'w', next: 'n' },
    } as CheckIssue;
    const doc = buildCheckJson(result([rel]));
    expect(doc.issues[0].edges).toEqual([{ file: 'src/web/h.ts', line: 5, target: 'data' }]);
  });
});
