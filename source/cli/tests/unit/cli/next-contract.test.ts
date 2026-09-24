/**
 * The Next contract, as the 6.1.0 release-readiness run found it broken
 * (issue 228): the step a report names first is runnable and whole, says what
 * running it costs — the whole command, never one block's share — and never
 * hands an agent a paid run or a user's decision as a command to run blindly;
 * the counts of what remains say what clears each error; headings never show a
 * raw `<node>`; the step for a fresh repository is not a type for its README;
 * and the machine document carries every fact the text states, in a compact
 * form on request.
 */
import { describe, it, expect } from 'vitest';
import { formatOutput, enrichCheckJson, previewCheckJson, formatAbort, THREE_WORD_GROUPS } from '../../../src/cli/check-render-views.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import { unverifiedCauseMessage, unverifiedMessage } from '../../../src/formatters/lock-issue-messages.js';
import { buildCheckJson } from '../../../src/core/check-json.js';
import { formatCheckJson, formatCompactCheckJson } from '../../../src/formatters/check-json.js';
import { renderHeader } from '../../../src/cli/check-render-header.js';

function result(issues: CheckIssue[], extra: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'test', nodeCount: 3, nodeTypeCounts: new Map(), aspectCount: 2, flowCount: 0,
    coveredFiles: 0, totalFiles: 0, issues, suggestedNext: null, advisoryWarnings: 0, draftSkipped: 0,
    verifiedDet: 0, verifiedLlm: 0, pairs: [], ...extra,
  } as CheckResult;
}

const render = (r: CheckResult): string => formatOutput(r, { kind: 'full' }, false, false);
const steps = (out: string): string[] => out.split('\n').filter((l) => /^(next|then): /.test(l));
const doc = (r: CheckResult) => enrichCheckJson(buildCheckJson(r), r);

const pending = (aspect: string, node: string, kind: 'llm' | 'deterministic', cause: 'stale' | 'never-reviewed' | 'deterministic-not-run'): CheckIssue => ({
  severity: 'error', code: 'unverified', rule: 'unverified', aspectId: aspect, nodePath: node, pairKind: kind, unitKey: `node:${node}`,
  unverifiedCause: cause,
  messageData: cause === 'deterministic-not-run' || cause === 'stale' || cause === 'never-reviewed'
    ? unverifiedCauseMessage({ aspectId: aspect, unitKey: node, cause })
    : unverifiedMessage({ aspectId: aspect, unitKey: node }),
} as CheckIssue);

const reviewerMissing = (): CheckIssue => ({
  severity: 'error', code: 'config-reviewer-missing', rule: 'config-reviewer-missing',
  messageData: {
    what: 'A judgment rule has no judge: yg-config.yaml has no reviewer: section.',
    why: "Configuring a reviewer is the user's decision: it sends code to that provider, on their account.",
    next: 'yg init --provider <name> [--model <m>] (an installed agent CLI needs no API key), or set the judgment rule to status: draft until a reviewer is chosen.',
  },
} as CheckIssue);

const waitingPair = (node: string, cause: 'reviewer-missing' | 'reviewer-unreachable', next: string): CheckIssue => ({
  severity: 'error', code: 'unverified', rule: 'unverified', aspectId: 'readable-names', nodePath: node, pairKind: 'llm', unitKey: `node:${node}`,
  unverifiedCause: cause,
  messageData: { what: `No verdict for readable-names on ${node}.`, why: 'The reviewer could not judge it.', next },
} as CheckIssue);

describe('M6: a fill step states what the whole command costs', () => {
  // One stale script pair, two reviewer pairs never reviewed: `yg check
  // --approve` would bill both reviewer pairs, so it is never labelled free.
  const r = result([pending('no-todo', 'app/svc-01', 'deterministic', 'stale'), pending('readable-names', 'app/svc-01', 'llm', 'never-reviewed'), pending('readable-names', 'app/svc-02', 'llm', 'never-reviewed')]);

  it('names the free lane first, and the paid run after it with the ask', () => {
    expect(steps(render(r))).toEqual([
      'next: yg check --approve --only-deterministic  (unverified — 1 script pair · free)',
      'then: yg check --approve  (2 reviewer pairs · paid — ask the user first)',
    ]);
  });

  it('a script-only block names the free lane in its own fix', () => {
    expect(render(r)).toContain('  fix:  yg check --approve --only-deterministic  (1 script pair · free)');
    expect(render(r)).toContain('  fix:  yg check --approve  (2 reviewer pairs · paid — ask the user first)');
  });

  it('JSON: next.cost is the cost of running next.command', () => {
    const next = doc(r).next!;
    expect(next.command).toEqual(['yg', 'check', '--approve', '--only-deterministic']);
    expect(next.cost).toEqual({ free: 1, reviewerPairs: 0 });
    expect(next.requiresUser).toBe(false);
  });

  it('a paid step states the whole cost and needs the user', () => {
    const paid = result([pending('readable-names', 'app/svc-01', 'llm', 'stale'), pending('readable-names', 'app/svc-02', 'llm', 'never-reviewed'), pending('no-todo', 'app/svc-03', 'deterministic', 'deterministic-not-run')]);
    const next = doc(paid).next!;
    expect(next.text).toBe('yg check --approve');
    expect(next.cost).toEqual({ free: 1, reviewerPairs: 2 });
    expect(next.requiresUser).toBe(true);
    expect(doc(paid).suggestedNext).toBe('yg check --approve  (unverified — 1 script pair · free + 2 reviewer pairs · paid — ask the user first)');
  });
});

describe('C1: a three-word command is never cut to two', () => {
  const statusMoved: CheckIssue = {
    severity: 'warning', code: 'aspect-status-changed-outside-cli', rule: 'aspect-status-changed-outside-cli', aspectId: 'no-todo',
    messageData: {
      what: "Rule 'no-todo' now stands at advisory; the last standing recorded for it was enforced.",
      why: 'A standing moved without a word about why.',
      next: "Record why it moved: yg aspects log add --aspect no-todo --status advisory --evidence '<what justified it>' --reason '<why it moved>'. The next yg check --approve otherwise writes the bare fact.",
    },
  } as CheckIssue;
  const other: CheckIssue = { severity: 'warning', code: 'uncovered-advisory', rule: 'uncovered-advisory', uncoveredFiles: ['docs/a.md'], uncoveredCount: 1, messageData: { what: 'x', why: 'y', next: 'Map these files to a node.' } } as CheckIssue;

  it('keeps `yg aspects log add` whole', () => {
    const [next] = steps(render(result([statusMoved, other])));
    expect(next).toMatch(/^next: yg aspects log add --aspect no-todo --status advisory /);
  });

  it('the three-word groups are the ones the e2e command-tree walk pins (tests/e2e/cli-next-contract.test.ts)', () => {
    expect([...THREE_WORD_GROUPS]).toEqual(['aspects log']);
  });
});

describe('C2/F6/C4: configuring a reviewer is asked for, and the counts say what clears each error', () => {
  const r = result([
    reviewerMissing(),
    waitingPair('app/svc-01', 'reviewer-missing', "yg init --provider <name> [--model <m>] — the user's decision, since it sends code to that provider — or set the judgment aspect to status: draft"),
    waitingPair('app/svc-02', 'reviewer-missing', "yg init --provider <name> [--model <m>] — the user's decision, since it sends code to that provider — or set the judgment aspect to status: draft"),
  ]);

  it('next asks the user, keeps --model and the draft alternative, and claims no code fix', () => {
    const [next] = steps(render(r));
    expect(next).toBe('next: ask the user first: yg init --provider <name> [--model <m>] configures a reviewer, or set the reviewer rules to status: draft  (config-reviewer-missing)');
    expect(render(r)).not.toContain('need a code or graph fix');
  });

  it('JSON: no command to run blindly, and the user and the reviewer each have their own count', () => {
    const next = doc(r).next!;
    expect(next.command).toBeNull();
    expect(next.requiresUser).toBe(true);
    expect(next.remaining).toEqual({ needsFix: 0, fillable: 0, needsUser: 1, waitingOnReviewer: 2 });
  });

  it('the gate abort names the same asked-for step', () => {
    const out = formatAbort({ stage: 'structural', issues: [reviewerMissing()], retry: 'yg check --approve' }, false);
    expect(steps(out)[0]).toBe('next: ask the user first: yg init --provider <name> [--model <m>] configures a reviewer, or set the reviewer rules to status: draft');
  });
});

describe('F2/C3: an unreachable reviewer: its cause is in the report, and the step is the cause', () => {
  const fix = "Make the reviewer reachable: no Ollama server answered at http://127.0.0.1:1 — start it with `ollama serve`.\nThen re-run: yg check --approve. For the provider's full output, set `debug: true` in .yggdrasil/yg-config.yaml and re-run; it is written to .yggdrasil/.debug.log.";
  const r = result([waitingPair('app/svc-01', 'reviewer-unreachable', fix), waitingPair('app/svc-02', 'reviewer-unreachable', fix)]);

  it('prints the cause in the stdout block, and next is the cause then the re-run — never the debug hint', () => {
    const out = render(r);
    expect(out).toContain('  fix:  Make the reviewer reachable: no Ollama server answered at http://127.0.0.1:1');
    expect(out).not.toContain('the cause above');
    expect(steps(out)).toEqual(['next: Make the reviewer reachable: no Ollama server answered at http://127.0.0.1:1 — start it with `ollama serve`, then yg check --approve']);
    const next = doc(r).next!;
    expect(next.target).toEqual({ node: 'app/svc-01' });
    expect(next.remaining).toEqual({ needsFix: 0, fillable: 0, needsUser: 0, waitingOnReviewer: 2 });
  });
});

describe('C5/F7: a heading every member shares is said once, never with a raw <node>', () => {
  const relation = (node: string): CheckIssue => ({
    severity: 'error', code: 'relation-undeclared-dependency', rule: 'relation-undeclared-dependency', nodePath: node,
    messageData: {
      what: `Node '${node}' has undeclared dependencies on other nodes:\n  src/${node}/index.ts:2 → app/lib`,
      why: 'A dependency on another component must be a declared relation.',
      next: `Declare the missing relation(s) in .yggdrasil/model/${node}/yg-node.yaml (or remove the dependency if it is not legitimate):\n  app/lib: Add to .yggdrasil/model/${node}/yg-node.yaml:\n  relations:\n    - target: app/lib\n      type: uses`,
    },
  } as CheckIssue);
  const cycle = (node: string): CheckIssue => ({
    severity: 'warning', code: 'log-cycle-open', rule: 'log-cycle-open', nodePath: node,
    messageData: { what: `The log requirement on node '${node}' is not measuring changes: its source moved past the last recorded baseline.`, why: 'w', next: 'yg check --approve' },
  } as CheckIssue);

  it('relation block: counted subject, one templated fix, next edits the first node\'s file', () => {
    const out = render(result([relation('app/a'), relation('app/b')]));
    expect(out).toContain('error[relation-undeclared-dependency] 2 nodes have undeclared dependencies on other nodes\n');
    expect(out).toContain('  fix:  Declare the missing relation(s) in .yggdrasil/model/<node>/yg-node.yaml (or remove the dependency if it is not legitimate) — for each node above:');
    expect(out.match(/Declare the missing relation/g)).toHaveLength(1);
    expect(steps(out)[0]).toBe('next: edit .yggdrasil/model/app/a/yg-node.yaml');
  });

  it('any other shared sentence names each node', () => {
    const out = render(result([cycle('app/a'), cycle('app/b')]));
    expect(out).toContain('warning[log-cycle-open] 2 nodes: the log requirement on each node is not measuring changes: its source moved past the last recorded baseline\n');
    expect(out.split('\n').filter((l) => /^(error|warning)\[/.test(l)).join('\n')).not.toContain('<node>');
  });
});

describe('F9/C11: a coverage step names a code file, never a placeholder or the README', () => {
  const uncovered = (files: string[]): CheckIssue => ({
    severity: 'warning', code: 'uncovered-advisory', rule: 'uncovered-advisory', uncoveredFiles: files, uncoveredCount: files.length,
    messageData: { what: 'uncovered', why: 'w', next: 'Map these files to a node, or add their root to coverage.required to make this an error. Or design an architecture type that covers files like it: yg type-suggest --file <path>.' },
  } as CheckIssue);

  it('skips README.md and package.json for the first code file', () => {
    expect(steps(render(result([uncovered(['README.md', 'package.json', 'src/x.ts'])])))).toEqual(['next: yg type-suggest --file src/x.ts']);
  });

  it('with no code file the step is the sentence, never a type for a document', () => {
    const [next] = steps(render(result([uncovered(['README.md', 'package.json']), uncovered(['LICENSE.md'])])));
    expect(next).not.toContain('type-suggest');
    expect(next).not.toContain('<path>');
  });

  it('an unmapped fix about one file names the file', () => {
    const unmapped: CheckIssue = {
      severity: 'error', code: 'unmapped-files', rule: 'unmapped-files', uncoveredFiles: ['src/tools/gen.ts'], uncoveredCount: 1,
      messageData: { what: 'u', why: 'w', next: "Add each file to a node's mapping, or create a new node for it — yg context --file <path> lists candidate owners." },
    } as CheckIssue;
    const out = render(result([unmapped]));
    expect(out).toContain('yg context --file src/tools/gen.ts lists candidate owners');
    expect(out).not.toContain('<path>');
  });
});

describe('C8/C9/C10: the document carries every fact, a preview says what the process does, and a compact form exists', () => {
  it('notes are in yg-check/1', () => {
    const r = result([], { typeLevel: true, classifyingTypeCount: 0 } as Partial<CheckResult>);
    expect(render(r)).toContain("note: Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:'");
    expect(doc(r).notes).toEqual([expect.stringContaining("Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:'")]);
  });

  it('a dry-run document exits 0 with status preview, keeping what the tree says', () => {
    const r = result([pending('readable-names', 'app/svc-01', 'llm', 'never-reviewed')]);
    const preview = previewCheckJson(doc(r), { pairs: 1, nodes: 1, files: 0, deterministic: 0, reviewerCalls: 1 });
    expect(preview.exit.code).toBe(0);
    expect(preview.exit.status).toBe('preview');
    expect(preview.exit.reason).toMatch(/^A cost preview: nothing was filled or written\. The tree as it stands: /);
  });

  it('the verdict line counts draft rules as rules', () => {
    expect(renderHeader(result([], { draftSkipped: 1 }), 0, 0, false, false)).toContain('1 draft rule skipped');
  });

  it('compact JSON leaves out approved pairs and the why/next its group states, and is much smaller', () => {
    const issues = Array.from({ length: 30 }, (_, i) => pending('readable-names', `app/svc-${String(i).padStart(2, '0')}`, 'llm', 'never-reviewed'));
    const pairs = Array.from({ length: 60 }, (_, i) => ({ aspect: 'no-todo', unit: { kind: 'node', path: `app/svc-${i}` }, node: `app/svc-${i}`, kind: 'deterministic', status: 'enforced', verdict: 'approved', reviewer: 'deterministic', hash: 'a'.repeat(64), filled: null }));
    const full = doc(result(issues));
    full.pairs = [...pairs, { ...pairs[0], verdict: 'unverified', hash: null }] as typeof full.pairs;
    const compactText = formatCompactCheckJson(full);
    const compact = JSON.parse(compactText);
    expect(compact.compact).toBe(true);
    expect(compact.pairs).toHaveLength(1);
    expect(compact.issues).toHaveLength(30);
    expect(compact.issues[0].why).toBeUndefined();
    expect(compact.issues[0].next).toBeUndefined();
    expect(compact.groups[0].why).toBe(full.issues[0].why);
    expect(compact.totals).toEqual(full.totals);
    expect(compactText.length * 3).toBeLessThan(formatCheckJson(full).length);
  });
});
