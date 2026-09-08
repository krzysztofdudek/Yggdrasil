// =============================================================================
// Unit — the `yg-check/1` machine document.
//
// `yg check --json` is the fourth view over one finished run, beside the three
// text views next door. Its whole claim is that it is a PROJECTION: every number
// in it is a number the text header already reports, read a second time rather
// than computed a second way. These tests pin that claim from the outside —
// build a `CheckResult`, project it, and assert the document says exactly what
// the result says — plus the two facts the document adds for a machine that the
// prose deliberately blurs: a pair never judged told apart from one judged over
// code that has since moved, and who answered for each pair.
//
// Nothing here spawns the binary: the projection is pure, so a constructed
// result is the whole input, and a fixture project would only hide which field
// produced which output.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildCheckJson } from '../../../src/core/check-json.js';
import { CHECK_JSON_SCHEMA } from '../../../src/formatters/check-json.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import type { VerifiedPair } from '../../../src/core/verify-lock.js';

/** A result with nothing in it — every case below starts here and adds one fact. */
function emptyResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'demo',
    nodeCount: 3,
    nodeTypeCounts: new Map(),
    aspectCount: 2,
    flowCount: 1,
    coveredFiles: 8,
    totalFiles: 10,
    issues: [],
    suggestedNext: null,
    advisoryWarnings: 0,
    draftSkipped: 0,
    verifiedDet: 0,
    verifiedLlm: 0,
    pairs: [],
    ...overrides,
  };
}

/** One expected pair, verified against a component, unless told otherwise. */
function pair(overrides: Partial<VerifiedPair> = {}): VerifiedPair {
  return {
    pair: {
      aspectId: 'audit-logging',
      kind: 'llm',
      unitKey: 'node:orders/handler',
      nodePath: 'orders/handler',
      status: 'enforced',
      subjectFiles: ['src/orders/handler.ts'],
    },
    state: { kind: 'verified' },
    ...overrides,
  };
}

function issue(overrides: Partial<CheckIssue> = {}): CheckIssue {
  return {
    severity: 'error',
    code: 'aspect-violation',
    rule: 'aspect-violation',
    messageData: { what: 'w', why: 'y', next: 'n' },
    ...overrides,
  };
}

describe('the check document — what the lock says about each pair', () => {
  it('names a verified pair approved, and a refused one refused with its report', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair(),
          pair({
            pair: { ...pair().pair, aspectId: 'input-validation' },
            state: { kind: 'refused', reason: 'no validation on the request body' },
          }),
        ],
      }),
    );

    expect(doc.pairs[0].verdict).toBe('approved');
    expect(doc.pairs[0].report).toBeUndefined();
    expect(doc.pairs[1].verdict).toBe('refused');
    expect(doc.pairs[1].report).toBe('no validation on the request body');
  });

  it('carries a refusal with no stored report as a refusal all the same', () => {
    const doc = buildCheckJson(emptyResult({ pairs: [pair({ state: { kind: 'refused' } })] }));
    expect(doc.pairs[0].verdict).toBe('refused');
    expect('report' in doc.pairs[0]).toBe(false);
  });

  it('tells a pair never judged apart from one judged over code that has since moved', () => {
    // The gate treats both as blocking and the text report says one word for
    // both. A machine consumer scheduling work wants the distinction: a stale
    // pair has a verdict to re-prove, an unverified one has nothing.
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({ state: { kind: 'unverified' } }),
          pair({ state: { kind: 'unverified' }, stale: true, recordedHash: 'a'.repeat(64) }),
        ],
      }),
    );

    expect(doc.pairs[0].verdict).toBe('unverified');
    expect(doc.pairs[0].hash).toBeNull();
    expect(doc.pairs[1].verdict).toBe('stale');
    expect(doc.pairs[1].hash).toBe('a'.repeat(64));
  });

  it('carries the two infrastructure dispositions under their own words', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({ state: { kind: 'prompt-too-large', chars: 90000, limit: 72000, tierName: 'standard' } }),
          pair({
            state: { kind: 'companion-error', messageData: { what: 'w', why: 'y', next: 'n' } },
          }),
        ],
      }),
    );

    expect(doc.pairs.map((p) => p.verdict)).toEqual(['prompt-too-large', 'companion-error']);
  });

  it('counts every verdict word, including the ones no pair reached', () => {
    // The totals map is complete by construction: a consumer reading
    // `verdicts.refused` on a clean run must get 0, never undefined.
    const doc = buildCheckJson(emptyResult({ pairs: [pair(), pair()] }));

    expect(doc.totals.verdicts).toEqual({
      approved: 2,
      refused: 0,
      unverified: 0,
      stale: 0,
      'prompt-too-large': 0,
      'companion-error': 0,
    });
    const summed = Object.values(doc.totals.verdicts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(doc.pairs.length);
  });
});

describe('the check document — who answered for a pair', () => {
  it('answers `deterministic` for a local check, whatever tier is around', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [pair({ pair: { ...pair().pair, kind: 'deterministic' }, tierName: 'standard' })],
      }),
    );
    expect(doc.pairs[0].reviewer).toBe('deterministic');
    expect(doc.pairs[0].kind).toBe('deterministic');
  });

  it('names the outside judge when one recorded the verdict, in preference to the tier', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [pair({ judge: { name: 'staff-architect', provider: 'external' }, tierName: 'standard' })],
      }),
    );
    expect(doc.pairs[0].reviewer).toBe('staff-architect');
  });

  it('names the reviewer tier the rule resolves to when nobody outside judged it', () => {
    const doc = buildCheckJson(emptyResult({ pairs: [pair({ tierName: 'standard' })] }));
    expect(doc.pairs[0].reviewer).toBe('standard');
  });

  it('answers null when no tier resolves and nothing has judged the pair', () => {
    const doc = buildCheckJson(emptyResult({ pairs: [pair({ state: { kind: 'unverified' } })] }));
    expect(doc.pairs[0].reviewer).toBeNull();
  });

  it('tallies each outside judge once, by name, in a stable order', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({ judge: { name: 'staff-architect', provider: 'external' } }),
          pair({ judge: { name: 'claude-code', provider: 'external' } }),
          pair({ judge: { name: 'staff-architect', provider: 'external' } }),
          pair(),
        ],
      }),
    );

    // Sorted by name so two runs over the same lock produce the same document.
    expect(doc.judges).toEqual([
      { name: 'claude-code', pairs: 1 },
      { name: 'staff-architect', pairs: 2 },
    ]);
  });

  it('reports no judges at all on a run the configured reviewer answered alone', () => {
    expect(buildCheckJson(emptyResult({ pairs: [pair()] })).judges).toEqual([]);
  });
});

describe('the check document — what a pair is about', () => {
  it('splits a component unit into its kind and its path', () => {
    const doc = buildCheckJson(emptyResult({ pairs: [pair()] }));
    expect(doc.pairs[0].unit).toEqual({ kind: 'node', path: 'orders/handler' });
    expect(doc.pairs[0].node).toBe('orders/handler');
    expect(doc.pairs[0].status).toBe('enforced');
  });

  it('names a file governed by its architecture type alone, with no component to blame', () => {
    // A type-covered file has no owning component; the document says so with
    // null rather than inventing an owner that does not exist.
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({
            pair: {
              aspectId: 'no-console',
              kind: 'deterministic',
              unitKey: 'file:src/handlers/charge.ts',
              status: 'enforced',
              subjectFiles: ['src/handlers/charge.ts'],
            },
          }),
        ],
      }),
    );

    expect(doc.pairs[0].unit).toEqual({ kind: 'file', path: 'src/handlers/charge.ts' });
    expect(doc.pairs[0].node).toBeNull();
  });

  it('leaves a unit key carrying no prefix whole rather than slicing it blind', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({
            pair: { ...pair().pair, unitKey: 'orders/handler', nodePath: undefined },
          }),
        ],
      }),
    );
    expect(doc.pairs[0].unit).toEqual({ kind: 'file', path: 'orders/handler' });
  });

  it('writes every path with forward slashes, whatever separator the run held', () => {
    const doc = buildCheckJson(
      emptyResult({
        pairs: [
          pair({
            pair: {
              ...pair().pair,
              unitKey: 'file:src\\orders\\handler.ts',
              nodePath: 'orders\\handler',
            },
          }),
        ],
        issues: [issue({ nodePath: 'orders\\handler', unitKey: 'file:src\\orders\\handler.ts' })],
      }),
    );

    expect(doc.pairs[0].unit.path).toBe('src/orders/handler.ts');
    expect(doc.pairs[0].node).toBe('orders/handler');
    expect(doc.issues[0].node).toBe('orders/handler');
    expect(doc.issues[0].unit).toBe('file:src/orders/handler.ts');
  });
});

describe('the check document — findings', () => {
  it('carries each finding as its structured message, never as a rendered block', () => {
    const doc = buildCheckJson(
      emptyResult({
        issues: [
          issue({
            code: 'relation-undeclared-dependency',
            messageData: { what: 'orders depends on payments', why: 'the graph says otherwise', next: 'declare it' },
            nodePath: 'orders',
            aspectId: 'audit-logging',
            unitKey: 'node:orders',
          }),
        ],
      }),
    );

    expect(doc.issues[0]).toEqual({
      code: 'relation-undeclared-dependency',
      severity: 'error',
      what: 'orders depends on payments',
      why: 'the graph says otherwise',
      next: 'declare it',
      aspect: 'audit-logging',
      node: 'orders',
      unit: 'node:orders',
    });
  });

  it('omits the identity fields a finding does not have rather than nulling them', () => {
    const doc = buildCheckJson(emptyResult({ issues: [issue({ severity: 'warning' })] }));
    expect(doc.issues[0].severity).toBe('warning');
    expect('aspect' in doc.issues[0]).toBe(false);
    expect('node' in doc.issues[0]).toBe(false);
    expect('unit' in doc.issues[0]).toBe(false);
  });

  it('counts errors and warnings as the text header counts them', () => {
    const doc = buildCheckJson(
      emptyResult({
        issues: [issue(), issue(), issue({ severity: 'warning' })],
      }),
    );
    expect(doc.totals.errors).toBe(2);
    expect(doc.totals.warnings).toBe(1);
  });
});

describe('the check document — the exit code and the sentence behind it', () => {
  it('fails on a single blocking finding, and says so in the singular', () => {
    const doc = buildCheckJson(emptyResult({ issues: [issue()] }));
    expect(doc.exit).toEqual({ code: 1, status: 'fail', reason: '1 blocking finding.' });
  });

  it('names the warnings alongside the blockers when both are present', () => {
    const doc = buildCheckJson(
      emptyResult({ issues: [issue(), issue(), issue({ severity: 'warning' })] }),
    );
    expect(doc.exit.code).toBe(1);
    expect(doc.exit.reason).toBe('2 blocking findings and 1 warning.');
  });

  it('pluralizes both halves independently', () => {
    const doc = buildCheckJson(
      emptyResult({
        issues: [issue(), issue({ severity: 'warning' }), issue({ severity: 'warning' })],
      }),
    );
    expect(doc.exit.reason).toBe('1 blocking finding and 2 warnings.');
  });

  it('passes on warnings alone, and says plainly that nothing blocks', () => {
    const one = buildCheckJson(emptyResult({ issues: [issue({ severity: 'warning' })] }));
    expect(one.exit).toEqual({
      code: 0,
      status: 'pass',
      reason: 'Nothing blocks this run; 1 warning reported.',
    });

    const two = buildCheckJson(
      emptyResult({ issues: [issue({ severity: 'warning' }), issue({ severity: 'warning' })] }),
    );
    expect(two.exit.reason).toBe('Nothing blocks this run; 2 warnings reported.');
  });

  it('passes silently when there is nothing to report at all', () => {
    const doc = buildCheckJson(emptyResult());
    expect(doc.exit).toEqual({
      code: 0,
      status: 'pass',
      reason: 'Nothing blocks this run, and nothing was reported.',
    });
    expect(doc.suggestedNext).toBeNull();
  });
});

describe('the check document — the project and its coverage', () => {
  it('restates the project counts and the run schema', () => {
    const doc = buildCheckJson(emptyResult({ suggestedNext: 'yg check --approve' }));
    expect(doc.schema).toBe(CHECK_JSON_SCHEMA);
    expect(doc.project).toEqual({ name: 'demo', nodes: 3, aspects: 2, flows: 1 });
    expect(doc.suggestedNext).toBe('yg check --approve');
  });

  it('leaves the type-level split null when the tier is off, so a zero never claims a measurement', () => {
    const doc = buildCheckJson(emptyResult());
    expect(doc.coverage).toEqual({
      files: 10,
      covered: 8,
      nodeOwned: null,
      typeCovered: null,
      excluded: null,
      requiresNothing: false,
    });
  });

  it('reports the three-way split once the type-level tier is on', () => {
    const doc = buildCheckJson(
      emptyResult({
        typeLevel: true,
        nodeOwnedFiles: 5,
        typeCoveredCount: 2,
        excludedFiles: 1,
        coverageRequiresNothing: true,
      }),
    );
    expect(doc.coverage.nodeOwned).toBe(5);
    expect(doc.coverage.typeCovered).toBe(2);
    expect(doc.coverage.excluded).toBe(1);
    expect(doc.coverage.requiresNothing).toBe(true);
  });

  it('reads an unreported half of the split as zero rather than dropping the tier', () => {
    // The tier is on but the coverage scan produced no counts: the split is
    // still a measurement, and 0 is the honest value for each half of it.
    const doc = buildCheckJson(emptyResult({ typeLevel: true }));
    expect(doc.coverage.nodeOwned).toBe(0);
    expect(doc.coverage.typeCovered).toBe(0);
    expect(doc.coverage.excluded).toBe(0);
  });

  it('splits verified pairs by reviewer kind exactly as the header does', () => {
    const doc = buildCheckJson(emptyResult({ verifiedDet: 41, verifiedLlm: 7, draftSkipped: 3 }));
    expect(doc.totals.verified).toEqual({ deterministic: 41, llm: 7 });
    expect(doc.totals.draftSkipped).toBe(3);
  });
});

describe('the check document — what the run stands on that the change never touched', () => {
  it('reports nothing progressive on a project that measures nothing', () => {
    // A zero here would claim a measurement was made against nothing.
    expect(buildCheckJson(emptyResult()).progressive).toBeNull();
  });

  it('reports the measurement in full when the run made one', () => {
    const doc = buildCheckJson(
      emptyResult({
        progressiveReference: 'origin/main',
        changedInputCount: 12,
        outsideCount: 40,
        byteGuardKept: 2,
        byteGuardUnavailable: false,
        baselineNoise: { advisory: 5, enforcedOutside: 40 },
      }),
    );

    expect(doc.progressive).toEqual({
      reference: 'origin/main',
      changedInputs: 12,
      outside: 40,
      byteGuardKept: 2,
      byteGuardUnavailable: false,
      noiseFloor: { advisory: 5, enforcedOutside: 40 },
    });
  });

  it('reports the measurement even when only the outside count survived it', () => {
    const doc = buildCheckJson(emptyResult({ outsideCount: 0 }));
    expect(doc.progressive).not.toBeNull();
    expect(doc.progressive?.outside).toBe(0);
    expect(doc.progressive?.reference).toBeNull();
    expect(doc.progressive?.changedInputs).toBeNull();
    expect(doc.progressive?.byteGuardKept).toBeNull();
    expect(doc.progressive?.noiseFloor).toBeNull();
    expect(doc.progressive?.byteGuardUnavailable).toBe(false);
  });

  it('reports the measurement when only the noise floor survived it', () => {
    const doc = buildCheckJson(emptyResult({ baselineNoise: { advisory: 0, enforcedOutside: 0 } }));
    expect(doc.progressive?.noiseFloor).toEqual({ advisory: 0, enforcedOutside: 0 });
  });

  it('says outright when the content guard could not be applied at all', () => {
    // Without this a repository whose files all legitimately differ from the
    // stored blob is indistinguishable from an ordinary red build.
    const doc = buildCheckJson(
      emptyResult({ progressiveReference: 'origin/main', byteGuardUnavailable: true }),
    );
    expect(doc.progressive?.byteGuardUnavailable).toBe(true);
  });
});
