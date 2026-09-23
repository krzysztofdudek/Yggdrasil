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

  it('the default view caps a group at 12 rows even when stdout is not a terminal, and names the drill', () => {
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const out = stripAnsi(formatOutput(result(many)));
      const rows = out.split('\n').filter((l) => /^ {12}- app\/svc-\d\d {2}aspect 'readable-names'$/.test(l));
      expect(rows).toHaveLength(12);
      expect(out).toContain('            ... and 12 more (yg check --aspect readable-names)');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    }
  });

  it('--top caps the members of the blocks it shows', () => {
    const out = stripAnsi(formatOutput(result(many), { kind: 'top', n: 1 }));
    expect(out.split('\n').filter((l) => /^ {12}- app\/svc-/.test(l))).toHaveLength(12);
    expect(out).toContain('... and 12 more (yg check --aspect readable-names)');
  });

  it('the drill-in view shows every member', () => {
    const out = stripAnsi(formatOutput(result(many), { kind: 'aspect', id: 'readable-names' }));
    expect(out.split('\n').filter((l) => /^ {12}- app\/svc-/.test(l))).toHaveLength(24);
    expect(out).not.toContain('more (yg check');
  });

  it('--summary is bounded: the busiest rows, then one counted line', () => {
    const wide = Array.from({ length: 30 }, (_, i) => unverified(`n${pad(i)}`, 'r'));
    const out = stripAnsi(formatOutput(result(wide), { kind: 'summary' }));
    expect(out.split('\n').filter((l) => /^ {2}n\d\d {2}/.test(l))).toHaveLength(24);
    expect(out).toContain('  ... and 6 more rows with 6 findings (yg check --details)');
  });

  it('a code-only group spanning several rules drills into the per-issue view', () => {
    const mixed = Array.from({ length: 14 }, (_, i) => unverified(`n${pad(i)}`, i % 2 === 0 ? 'a' : 'b'));
    const out = stripAnsi(formatOutput(result(mixed)));
    expect(out).toContain('... and 2 more (yg check --details)');
  });
});

describe('per-file pairs carry their file, and no member line repeats', () => {
  it('collapses one rule\'s per-file pairs on one node into "N files", and names a single file', () => {
    const issues = [
      unverified('app/a', 'self-contained', 'file:src/a/one.ts', 'deterministic'),
      unverified('app/a', 'self-contained', 'file:src/a/two.ts', 'deterministic'),
      unverified('app/a', 'self-contained', 'file:src/a/three.ts', 'deterministic'),
      unverified('app/b', 'self-contained', 'file:src/b/only.ts', 'deterministic'),
      unverified('app/b', 'no-todo', 'node:app/b', 'deterministic'),
    ];
    const out = stripAnsi(formatOutput(result(issues)));
    expect(out).toContain("            - app/a  aspect 'self-contained'  3 files");
    expect(out).toContain("            - app/b  aspect 'self-contained'  src/b/only.ts");
    expect(out).toContain("            - app/b  aspect 'no-todo'");
    const members = out.split('\n').filter((l) => /^ {12}- /.test(l));
    expect(new Set(members).size).toBe(members.length);
  });
});

describe('every line of a finding is rendered', () => {
  it('a grouped finding with a multi-line what keeps its continuation lines', () => {
    const issue = {
      severity: 'error',
      code: 'type-without-when-with-mapping',
      rule: 'type-without-when-with-mapping',
      nodePath: 'app/x',
      messageData: {
        what: "Node 'app/x' has type 'service' but mapping is not empty:\n  mapping:\n  - src/x.ts",
        why: 'Types without when are organizational.',
        next: 'Add a when predicate.',
      },
    } as CheckIssue;
    const out = stripAnsi(formatOutput(result([issue])));
    expect(out).toContain("- app/x  Node 'app/x' has type 'service' but mapping is not empty:");
    expect(out).toContain('              - src/x.ts');
  });

  it('the per-issue view shows every line of what for every code', () => {
    const issue = {
      severity: 'error',
      code: 'yaml-invalid',
      rule: 'invalid-node-yaml',
      nodePath: 'app/y',
      messageData: { what: 'yg-node.yaml in app/y does not parse: bad indentation\nbad: [unclosed\n^', why: 'not loaded', next: 'Fix the YAML.' },
    } as CheckIssue;
    const out = stripAnsi(formatOutput(result([issue]), { kind: 'details' }));
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
    const out = stripAnsi(formatOutput(result([issue])));
    expect(out).toContain('Then: add to an existing node mapping, or create a new node.');
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

  it('renders the graph-invalid group first, under a partial-result banner, and Next names its fix', () => {
    const issues = [unverified('a', 'r'), flowBroken, yamlInvalid];
    const out = stripAnsi(formatOutput(result(issues)));
    expect(out).toContain('Partial result: 1 component file did not parse (model/cart), so that component was left out.');
    expect(out.indexOf('  yaml-invalid')).toBeLessThan(out.indexOf('  unverified'));
    expect(out.indexOf('  yaml-invalid')).toBeLessThan(out.indexOf('  flow-node-broken'));
    expect(out).toContain('Next: Fix the YAML in .yggdrasil/model/model/cart/yg-node.yaml.');
  });

  it('a config that does not parse outranks everything else in Next', () => {
    const configInvalid = { severity: 'error', code: 'config-invalid', rule: 'invalid-config', messageData: { what: 'yg-config.yaml does not parse: x', why: 'defaults used', next: 'Fix the syntax error in .yggdrasil/yg-config.yaml.' } } as CheckIssue;
    expect(computeSuggestedNext([unverified('a', 'r'), yamlInvalid, configInvalid])).toBe('Fix the syntax error in .yggdrasil/yg-config.yaml.');
  });

  it('prints no banner on an ordinary run', () => {
    expect(stripAnsi(formatOutput(result([unverified('a', 'r')])))).not.toContain('Partial result');
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

  it('heads it with an ABORTED verdict line, groups the findings with one templated fix, and keeps the user\'s flags in Next', () => {
    const out = stripAnsi(formatAbort({ stage: 'log-gate', issues, retry: 'yg check --approve --only-deterministic' }));
    expect(out.split('\n')[0]).toBe('yg check: ABORTED  nothing recorded — 14 nodes need a log entry first');
    expect(out).toContain("Fix: yg log add --node <node> --reason '<why this change was made>', then re-run: yg check --approve --only-deterministic  (for each node below)");
    expect(out.split('\n').filter((l) => /^ {12}- app\/svc-/.test(l))).toHaveLength(12);
    expect(out).toContain('... and 2 more (yg check --details)');
    expect(out).toContain("Next: yg log add --node app/svc-01 --reason '<why this change was made>', then re-run: yg check --approve --only-deterministic");
  });

  it('a structural abort names the re-run with the user\'s flags', () => {
    const structural = { severity: 'error', code: 'config-reviewer-missing', rule: 'config-reviewer-missing', messageData: { what: 'No reviewer.', why: 'w', next: 'yg init --provider <name>' } } as CheckIssue;
    const out = stripAnsi(formatAbort({ stage: 'structural', issues: [structural], retry: 'yg check --approve --dry-run' }));
    expect(out.split('\n')[0]).toBe('yg check: ABORTED  nothing ran — 1 problem must be fixed first');
    expect(out).toContain('Next: yg init --provider <name>\n  then re-run: yg check --approve --dry-run');
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
  it('singular header segments and group counts', () => {
    const out = stripAnsi(formatOutput(result([unverified('a', 'r')])));
    expect(out.split('\n')[0]).toContain('1 node · 1 aspect · 1 flow');
    expect(out).toContain('  unverified (not yet reviewed)  1 pair  1 node');
  });

  it('the unverified group\'s fill says what it costs', () => {
    const out = stripAnsi(formatOutput(result([unverified('a', 'r'), unverified('b', 's', 'node:b', 'deterministic')])));
    expect(out).toContain('Fix: yg check --approve  (1 script pair free, 1 reviewer pair paid)');
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
    expect(doc.issues[0].label).toBe('enforced');
    expect(doc.issues[1].files).toHaveLength(15);
    expect(doc.issues[1].label).toBe('unmapped');
    expect(doc.groups?.map((g) => g.code)).toEqual(['aspect-violation-enforced', 'unmapped-files']);
    expect(doc.groups?.[0].members).toEqual([0]);
    expect(doc.groups?.[0].why).toBe(refused.messageData.why);
    expect(doc.banner).toBeNull();
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
