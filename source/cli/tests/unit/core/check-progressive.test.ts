import { describe, it, expect } from 'vitest';
import {
  applyChangeScope,
  countOutside,
  issueIsInScope,
} from '../../../src/core/check-progressive.js';
import type { BurnSet } from '../../../src/core/progressive-scope.js';
import { progressivePairKey } from '../../../src/core/progressive-scope.js';
import { OUTSIDE_CODES, SCOPED_CODES, outsideTwin } from '../../../src/core/check-codes.js';
import type { CheckIssue } from '../../../src/core/check-contract.js';
import type { VerifiedPair } from '../../../src/core/verify-lock.js';

/**
 * The classification step: for each finding a check produced, decide whether the
 * current change is accountable for it. In scope ⇒ untouched. Outside ⇒ re-coded
 * to its `-outside` twin at warning severity.
 *
 * The asymmetry these tests defend: an error wrongly DOWNGRADED is a real
 * violation shipping green; an error wrongly KEPT is merely noisy. So every
 * negative case below (identity absent, identity unrecognized, a global burn
 * set) asserts the finding stays a blocking error.
 */

const md = (next = 'NEXT') => ({ what: 'what', why: 'why', next });

function burn(overrides: Partial<BurnSet> = {}): BurnSet {
  const files = overrides.files ?? new Set<string>();
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(),
    logOnlyNodePaths: new Set(),
    changedInputCount: files.size,
    ...overrides,
    files,
  };
}

/** A pair this run really enumerated — what tells "outside" from "unrecognized". */
function knownPair(aspectId: string, unitKey: string): VerifiedPair {
  return {
    pair: { aspectId, kind: 'llm', unitKey, status: 'enforced', subjectFiles: [] },
    state: { kind: 'verified' },
  };
}

const pairIssue = (aspectId: string, unitKey: string, over: Partial<CheckIssue> = {}): CheckIssue => ({
  severity: 'error',
  code: 'unverified',
  rule: 'unverified',
  messageData: md('yg check --approve'),
  aspectId,
  unitKey,
  ...over,
});

// ── Rule 1: a code outside SCOPED_CODES is never touched ────────────────────

describe('applyChangeScope — codes outside the scoped tier', () => {
  it('leaves a blocking structural error untouched even when nothing was changed', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'lock-invalid',
      rule: 'lock-invalid',
      messageData: md(),
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });

  it('leaves a non-scoped error carrying a node path untouched', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'relation-target-forbidden',
      rule: 'relation-target-forbidden',
      messageData: md(),
      nodePath: 'a/b',
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });

  it('never re-twins a finding that is already an outside twin', () => {
    const twin: CheckIssue = {
      severity: 'warning',
      code: outsideTwin('unverified'),
      rule: 'unverified',
      messageData: md(),
      aspectId: 'a',
      unitKey: 'node:x',
    };
    const [out] = applyChangeScope([twin], burn(), []);
    expect(out.code).toBe('unverified-outside');
    expect(out).toEqual(twin);
  });

  it('holds the structural precondition that makes re-twinning impossible', () => {
    for (const code of OUTSIDE_CODES) expect(SCOPED_CODES.has(code)).toBe(false);
  });
});

// ── Rule 2: an existing warning is never touched ────────────────────────────

describe('applyChangeScope — findings already at warning severity', () => {
  it('leaves an advisory unverified warning alone even though its code is scoped', () => {
    const issue = pairIssue('a', 'node:x', { severity: 'warning' });
    expect(applyChangeScope([issue], burn(), [knownPair('a', 'node:x')])).toEqual([issue]);
  });
});

// ── Rule 3: pair-keyed findings ────────────────────────────────────────────

describe('applyChangeScope — pair-keyed findings', () => {
  const key = progressivePairKey('audit', 'node:svc');

  it('keeps a blocking error when its pair key is in the burn set', () => {
    const issue = pairIssue('audit', 'node:svc');
    const out = applyChangeScope([issue], burn({ pairKeys: new Set([key]) }), [knownPair('audit', 'node:svc')]);
    expect(out).toEqual([issue]);
  });

  it('downgrades a known pair the change never reached', () => {
    const issue = pairIssue('audit', 'node:svc');
    const [out] = applyChangeScope([issue], burn(), [knownPair('audit', 'node:svc')]);
    expect(out.code).toBe('unverified-outside');
    expect(out.severity).toBe('warning');
  });

  it('keeps the error when the pair is not one this run enumerated', () => {
    const issue = pairIssue('audit', 'node:svc');
    const [out] = applyChangeScope([issue], burn(), [knownPair('other', 'node:svc')]);
    expect(out.code).toBe('unverified');
    expect(out.severity).toBe('error');
  });

  it('derives the pair key exactly as the burn set does', () => {
    // A re-spelled key produces a set that silently never matches.
    const issue = pairIssue('audit', 'node:svc');
    const wrong = burn({ pairKeys: new Set(['audit/node:svc']) });
    expect(applyChangeScope([issue], wrong, [knownPair('audit', 'node:svc')])[0].severity).toBe('warning');
    const right = burn({ pairKeys: new Set([progressivePairKey('audit', 'node:svc')]) });
    expect(applyChangeScope([issue], right, [knownPair('audit', 'node:svc')])[0].severity).toBe('error');
  });

  it('downgrades every pair-derived code the same way', () => {
    const codes = ['unverified', 'aspect-violation-enforced', 'prompt-too-large', 'aspect-companion-runtime-error'];
    const issues = codes.map((code) => pairIssue('audit', 'node:svc', { code, rule: code }));
    const out = applyChangeScope(issues, burn(), [knownPair('audit', 'node:svc')]);
    expect(out.map((i) => i.code)).toEqual(codes.map(outsideTwin));
    expect(out.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('leaves messageData byte-identical on a downgraded finding', () => {
    const issue = pairIssue('audit', 'node:svc');
    const [out] = applyChangeScope([issue], burn(), [knownPair('audit', 'node:svc')]);
    expect(out.messageData).toEqual(issue.messageData);
    expect(out.aspectId).toBe('audit');
    expect(out.unitKey).toBe('node:svc');
  });
});

// ── Rule 4: node-keyed findings, with the log carve-out ─────────────────────

describe('applyChangeScope — node-keyed findings', () => {
  const nodeIssue = (code: string): CheckIssue => ({
    severity: 'error',
    code,
    rule: code,
    messageData: md(),
    nodePath: 'cli/core/check',
  });

  it('keeps the error when the node is in the burn set', () => {
    const issue = nodeIssue('type-when-mismatch');
    expect(applyChangeScope([issue], burn({ nodePaths: new Set(['cli/core/check']) }), [])).toEqual([issue]);
  });

  it('downgrades when the node is not in the burn set', () => {
    const [out] = applyChangeScope([nodeIssue('type-when-mismatch')], burn(), []);
    expect(out.code).toBe('type-when-mismatch-outside');
    expect(out.severity).toBe('warning');
  });

  it('keeps a log finding whose node had only its log file changed', () => {
    const scope = burn({ logOnlyNodePaths: new Set(['cli/core/check']) });
    for (const code of ['log-entry-missing', 'log-integrity', 'log-format', 'log-conflict']) {
      const [out] = applyChangeScope([nodeIssue(code)], scope, []);
      expect(out.code).toBe(code);
      expect(out.severity).toBe('error');
    }
  });

  it('does NOT let the log-only carve-out rescue a non-log finding on the same node', () => {
    const scope = burn({ logOnlyNodePaths: new Set(['cli/core/check']) });
    const [out] = applyChangeScope([nodeIssue('relation-undeclared-dependency')], scope, []);
    expect(out.code).toBe('relation-undeclared-dependency-outside');
  });

  it('downgrades a log finding on a node that is in neither set', () => {
    const [out] = applyChangeScope([nodeIssue('log-entry-missing')], burn(), []);
    expect(out.code).toBe('log-entry-missing-outside');
    expect(out.severity).toBe('warning');
  });
});

// ── Rule 5: file-keyed findings ─────────────────────────────────────────────

describe('applyChangeScope — file-keyed findings', () => {
  const fileIssue = (code: string, file: string): CheckIssue => ({
    severity: 'error',
    code,
    rule: code,
    messageData: md(),
    unitKey: `file:${file}`,
  });

  it('keeps the error when the named file is part of the change', () => {
    const issue = fileIssue('ambiguous-node-type', 'src/a.ts');
    expect(applyChangeScope([issue], burn({ files: new Set(['src/a.ts']) }), [])).toEqual([issue]);
  });

  it('downgrades when the named file is not part of the change', () => {
    const [out] = applyChangeScope([fileIssue('tracked-file-gitignored', 'src/b.ts')], burn({ files: new Set(['src/a.ts']) }), []);
    expect(out.code).toBe('tracked-file-gitignored-outside');
    expect(out.severity).toBe('warning');
  });

  it('classifies a strict-mapping orphan by its own file', () => {
    const issue = fileIssue('type-strict-orphan', 'src/c.ts');
    expect(applyChangeScope([issue], burn({ files: new Set(['src/c.ts']) }), [])[0].severity).toBe('error');
    expect(applyChangeScope([issue], burn(), [])[0].severity).toBe('warning');
  });
});

// ── Rule 6: the two aggregated, edge-list findings ──────────────────────────

describe('applyChangeScope — aggregate findings carrying an edge list', () => {
  const edgeIssue = (code: string, edges: Array<{ fromFile: string; toFile: string }>): CheckIssue => ({
    severity: 'error',
    code,
    rule: code,
    messageData: md(),
    relationEdges: edges,
  });

  it('keeps the error when ANY attached file is part of the change', () => {
    const issue = edgeIssue('type-relation-forbidden', [
      { fromFile: 'src/x.ts', toFile: 'src/y.ts' },
      { fromFile: 'src/p.ts', toFile: 'src/q.ts' },
    ]);
    expect(applyChangeScope([issue], burn({ files: new Set(['src/q.ts']) }), [])).toEqual([issue]);
  });

  it('downgrades only when NO attached file is part of the change', () => {
    const issue = edgeIssue('type-relation-forbidden', [{ fromFile: 'src/x.ts', toFile: 'src/y.ts' }]);
    const [out] = applyChangeScope([issue], burn({ files: new Set(['src/z.ts']) }), []);
    expect(out.code).toBe('type-relation-forbidden-outside');
  });

  it('reads the self-referencing edges a strict-overlap conflict carries', () => {
    const issue = edgeIssue('strict-overlap-conflict', [{ fromFile: 'src/m.ts', toFile: 'src/m.ts' }]);
    expect(applyChangeScope([issue], burn({ files: new Set(['src/m.ts']) }), [])[0].severity).toBe('error');
    expect(applyChangeScope([issue], burn(), [])[0].code).toBe('strict-overlap-conflict-outside');
  });

  it('keeps the error when the edge list is empty — nothing to attribute by', () => {
    const [out] = applyChangeScope([edgeIssue('type-relation-forbidden', [])], burn(), []);
    expect(out.code).toBe('type-relation-forbidden');
    expect(out.severity).toBe('error');
  });
});

// ── Rule 7: missing / unrecognized identity stays an ERROR ──────────────────

describe('applyChangeScope — findings with no identity the burn set can be probed with', () => {
  it('keeps a description-missing error that names only an aspect', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'description-missing',
      rule: 'missing-description',
      messageData: md(),
      aspectId: 'audit-log',
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });

  it('keeps a description-missing error that names only a flow', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'description-missing',
      rule: 'missing-description',
      messageData: md(),
      flowName: 'checkout',
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });

  it('keeps a scoped error carrying no identity at all', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      messageData: md(),
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });
});

// ── Rule 8: the aggregate coverage finding is SPLIT, not re-coded ───────────

describe('applyChangeScope — the aggregate coverage finding', () => {
  const coverage = (files: string[]): CheckIssue => ({
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    messageData: md(),
    uncoveredFiles: files,
    uncoveredCount: files.length,
  });

  it('splits into a blocking in-diff half and a warning inherited half', () => {
    const issue = coverage(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    const out = applyChangeScope([issue], burn({ files: new Set(['src/a.ts', 'src/b.ts']) }), []);
    expect(out).toHaveLength(2);
    expect(out[0].code).toBe('unmapped-files');
    expect(out[0].severity).toBe('error');
    expect(out[0].uncoveredFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out[0].uncoveredCount).toBe(2);
    expect(out[1].code).toBe('unmapped-files-outside');
    expect(out[1].severity).toBe('warning');
    expect(out[1].uncoveredFiles).toEqual(['src/c.ts', 'src/d.ts', 'src/e.ts']);
    expect(out[1].uncoveredCount).toBe(3);
  });

  it('regenerates each half\'s message from its own file list only', () => {
    const issue = coverage(['src/a.ts', 'src/c.ts']);
    const out = applyChangeScope([issue], burn({ files: new Set(['src/a.ts']) }), []);
    expect(out[0].messageData.what).toContain('src/a.ts');
    expect(out[0].messageData.what).not.toContain('src/c.ts');
    expect(out[1].messageData.what).toContain('src/c.ts');
    expect(out[1].messageData.what).not.toContain('src/a.ts');
  });

  it('yields the blocking half alone when every uncovered file is in the change', () => {
    const out = applyChangeScope([coverage(['src/a.ts'])], burn({ files: new Set(['src/a.ts']) }), []);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('unmapped-files');
    expect(out[0].severity).toBe('error');
  });

  it('yields the inherited half alone when no uncovered file is in the change', () => {
    const out = applyChangeScope([coverage(['src/a.ts'])], burn(), []);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('unmapped-files-outside');
    expect(out[0].severity).toBe('warning');
  });

  it('keeps a coverage error carrying no file list as a blocking error', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-file',
      messageData: md(),
    };
    expect(applyChangeScope([issue], burn(), [])).toEqual([issue]);
  });
});

// ── Rule 9: a global burn set is the identity function ──────────────────────

describe('applyChangeScope — a global burn set', () => {
  it('changes nothing at all, coverage split included', () => {
    const issues: CheckIssue[] = [
      pairIssue('audit', 'node:svc'),
      {
        severity: 'error',
        code: 'unmapped-files',
        rule: 'unmapped-file',
        messageData: md(),
        uncoveredFiles: ['src/a.ts', 'src/b.ts'],
        uncoveredCount: 2,
      },
    ];
    const out = applyChangeScope(issues, burn({ global: true }), [knownPair('audit', 'node:svc')]);
    expect(out).toBe(issues);
  });
});

// ── Order ──────────────────────────────────────────────────────────────────

describe('applyChangeScope — list shape', () => {
  it('preserves the order of the findings it was handed', () => {
    const first = pairIssue('audit', 'node:a');
    const second: CheckIssue = { severity: 'error', code: 'lock-invalid', rule: 'lock-invalid', messageData: md() };
    const third = pairIssue('audit', 'node:b');
    const out = applyChangeScope([first, second, third], burn(), [
      knownPair('audit', 'node:a'),
      knownPair('audit', 'node:b'),
    ]);
    expect(out.map((i) => i.code)).toEqual(['unverified-outside', 'lock-invalid', 'unverified-outside']);
  });
});

// ── The singleton branch (forward-looking; see the module's own note) ───────

describe('issueIsInScope — findings whose whole input is one fixed project file', () => {
  it('is in scope when one of those fixed files is part of the change', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'incident-ledger-out-of-order',
      rule: 'incident-ledger-out-of-order',
      messageData: md(),
    };
    expect(issueIsInScope(issue, burn({ files: new Set(['.yggdrasil/incidents.md']) }), new Set())).toBe(true);
  });

  it('is outside when none of them is', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'coverage-required-shadowed',
      rule: 'coverage-required-shadowed',
      messageData: md(),
    };
    expect(issueIsInScope(issue, burn({ files: new Set(['src/a.ts']) }), new Set())).toBe(false);
  });

  it('answers from the fixed inputs even when the finding also names a node', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'rules-digest-stale',
      rule: 'rules-digest-stale',
      messageData: md(),
      nodePath: 'cli/core/check',
    };
    expect(issueIsInScope(issue, burn({ nodePaths: new Set(['cli/core/check']) }), new Set())).toBe(false);
    expect(issueIsInScope(issue, burn({ files: new Set(['AGENTS.md']) }), new Set())).toBe(true);
  });
});

// ── countOutside ───────────────────────────────────────────────────────────

describe('countOutside', () => {
  it('is zero when nothing was downgraded', () => {
    expect(countOutside([pairIssue('audit', 'node:svc')])).toBe(0);
  });

  it('counts each produced twin once, and the coverage half by its file count', () => {
    const issues: CheckIssue[] = [
      pairIssue('audit', 'node:a'),
      pairIssue('audit', 'node:b'),
      {
        severity: 'error',
        code: 'unmapped-files',
        rule: 'unmapped-file',
        messageData: md(),
        uncoveredFiles: ['src/x.ts', 'src/y.ts', 'src/z.ts'],
        uncoveredCount: 3,
      },
      { severity: 'error', code: 'lock-invalid', rule: 'lock-invalid', messageData: md() },
    ];
    const out = applyChangeScope(issues, burn(), [knownPair('audit', 'node:a'), knownPair('audit', 'node:b')]);
    // Two plain twins, plus a coverage half standing for three uncovered files.
    expect(countOutside(out)).toBe(5);
  });

  it('counts nothing when the burn set is global', () => {
    const issues = [pairIssue('audit', 'node:a')];
    expect(countOutside(applyChangeScope(issues, burn({ global: true }), [knownPair('audit', 'node:a')]))).toBe(0);
  });
});
