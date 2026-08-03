import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/cli/check-render-views.js';
import { useEmoji, renderTypeVisibilityBlock } from '../../../src/cli/check-render-header.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import type { TypeVisibilityReport } from '../../../src/core/type-visibility.js';

/** Strip ANSI color codes so block-line counting is deterministic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Unit tests for the `yg check` header render layer (check-render-header.ts):
 * the verdict/metrics header line (PASS/FAIL, node count, coverage split,
 * aspect/flow counts, verified-pair split, draft count) and the `useEmoji`
 * accessibility gate every render file reads. These exercise the rendering
 * directly against constructed CheckResult objects — no spawned binary, no
 * build — so they pin the agent-facing OUTPUT contract.
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

  // The existing cases above never combine typeLevel: true with errors.length
  // > 0 (FAIL) — only exercised by the flag-less 'PASS (auto-filled) header
  // marker' describe block above, which never sets typeLevel. Since
  // renderHeader computes the verdict prefix and the files-metric split from
  // the SAME result object in one pass, an interaction bug (e.g. the
  // type-level split accidentally suppressing the FAIL colour) is exactly
  // the kind of thing neither existing block can catch alone. This case also
  // passes autoFilled=true (not just typeLevel: true) — the pre-existing FAIL
  // + autoFilled test above never sets typeLevel, so it cannot see a
  // regression where the marker's guard reads BOTH flags together instead of
  // the error count alone; this is the only test in the suite exercising
  // that exact combination.
  it('flag ON + FAIL (errors present) + autoFilled=true: verdict reads plain FAIL — never "(auto-filled)" — and the three-term split still renders in full', () => {
    const errorIssue: CheckIssue = {
      severity: 'error', code: 'ambiguous-node-type', rule: 'ambiguous-node-type',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const result: CheckResult = {
      ...baseResult([errorIssue]),
      coveredFiles: 1, totalFiles: 5, typeLevel: true,
      typeCoveredCount: 1, classifyingTypeCount: 1, nodeOwnedFiles: 0, excludedFiles: 1,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }, /* autoFilled */ true));
    expect(out).toContain('yg check: FAIL');
    expect(out).not.toContain('auto-filled');
    expect(out).toContain('2/5 files (0 node-owned, 1 type-covered, 1 excluded)');
  });

  it('flag ON + autoFilled=true, no errors: PASS (auto-filled) coexists with the three-term split', () => {
    const result: CheckResult = {
      ...baseResult([]),
      coveredFiles: 3, totalFiles: 5, typeLevel: true,
      typeCoveredCount: 1, classifyingTypeCount: 2, nodeOwnedFiles: 2, excludedFiles: 0,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }, /* autoFilled */ true));
    expect(out).toContain('yg check: PASS (auto-filled)');
    expect(out).toContain('3/5 files (2 node-owned, 1 type-covered, 0 excluded)');
  });

  it('flag ON + autoFilled=true + warnings present: PASS (auto-filled, N warnings) coexists with the split', () => {
    const warnIssue: CheckIssue = {
      severity: 'warning', code: 'coverage-required-shadowed', rule: 'coverage-required-shadowed',
      messageData: { what: 'x', why: 'y', next: 'z' },
    };
    const result: CheckResult = {
      ...baseResult([warnIssue]),
      coveredFiles: 3, totalFiles: 5, typeLevel: true,
      typeCoveredCount: 1, classifyingTypeCount: 2, nodeOwnedFiles: 2, excludedFiles: 0,
    };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }, true));
    expect(out).toContain('yg check: PASS (auto-filled, 1 warning)');
    expect(out).toContain('3/5 files (2 node-owned, 1 type-covered, 0 excluded)');
  });

  // Every existing flag-off case above uses a non-full ratio (coveredFiles <
  // totalFiles, the percentage arm). The else arm — 100% covered, flag off,
  // plain "N/N files" with no percentage and no split — is not pinned at the
  // string level anywhere in the suite; this composition is unchanged by
  // whatever split the file went through.
  it('flag OFF, fully covered (coveredFiles === totalFiles): plain "N/N files", no percentage, no split — the else arm of the pre-type-level branch', () => {
    const result: CheckResult = { ...baseResult([]), coveredFiles: 5, totalFiles: 5 };
    const out = stripAnsi(formatOutput(result, { kind: 'full' }));
    expect(out).toContain('5/5 files');
    expect(out).not.toContain('5/5 files (');   // no trailing percentage parenthetical
    expect(out).not.toContain('node-owned');
    expect(out).not.toContain('type-covered');
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

// ── Type-visibility block: advisory heading, cap discipline, counts-only
// triage views, singular grammar — constructed CheckResult, no fixture, so
// every scenario is exact and controllable. ─────────────────────

function typeVisibilityResult(report: TypeVisibilityReport, issues: CheckIssue[] = []): CheckResult {
  return { ...baseResult(issues), typeLevel: true, typeVisibility: report };
}

/** A plain `unverified` CheckIssue for a nodeless (type-covered) pair, matching what core/check.ts's emitPairIssue actually produces for one. */
function unverifiedFileIssue(file: string, aspectId: string): CheckIssue {
  return {
    severity: 'error',
    code: 'unverified',
    rule: 'unverified',
    aspectId,
    unitKey: `file:${file}`,
    messageData: { what: `No valid verdict for aspect '${aspectId}' on file:${file}.`, why: 'w', next: 'yg check --approve' },
  };
}

function block(overrides: Partial<TypeVisibilityReport['byType'][number]> = {}): TypeVisibilityReport['byType'][number] {
  return {
    typeId: 't',
    files: ['a.ts'],
    enforced: [],
    enforcedCounts: [],
    advisory: [],
    advisoryCounts: [],
    dropped: [],
    halfExpandedBundles: [],
    uncomputable: [],
    chainTermination: { reason: 'no-parents', candidates: ['t'] },
    ...overrides,
  };
}

/** Every report literal below leaves this empty — the uncomputable-group render itself is pinned separately, in its own describe block. */
const NO_UNCOMPUTABLE = { count: 0, groups: [] };

describe('type-visibility block — advisory heading never claims enforcement', () => {
  it('an advisory rule is listed under its own heading, never under "Enforced"', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        advisory: ['warn-only'],
        advisoryCounts: [{ aspectId: 'warn-only', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('Enforced: (none)');
    expect(out).not.toMatch(/Enforced:.*warn-only/);
    expect(out).toMatch(/Advisory.*warn-only \(1\)/);
  });

  it('a type with no advisory rules never renders an Advisory line', () => {
    const report: TypeVisibilityReport = {
      byType: [block({ enforced: ['own-rule'], enforcedCounts: [{ aspectId: 'own-rule', count: 1 }] })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).not.toContain('Advisory');
  });
});

describe('type-visibility block — the attached-but-not-enforced line is grouped by reason, not capped duplicates', () => {
  it('states a shared reason ONCE, followed by every aspect id it applies to, capped at 12 with a count of the rest', () => {
    const dropped = Array.from({ length: 20 }, (_, i) => ({
      aspectId: `rule-${String(i).padStart(2, '0')}`,
      reason: 'whole-unit-rule' as const,
      count: 1,
    }));
    const report: TypeVisibilityReport = {
      byType: [block({ dropped })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    const lines = out.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('Attached but not enforced'));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    // Exactly one reason present among all 20 drops -> exactly one reason line beneath the header.
    const reasonLine = lines[headerIdx + 1];
    expect(reasonLine).toContain('rule-00');
    expect(reasonLine).toContain('rule-11');
    expect(reasonLine).not.toContain('rule-12');
    expect(reasonLine).toContain('... and 8 more');
    // The (long) reason phrase is stated ONCE on this one line, never once per aspect.
    expect((reasonLine.match(/no component to run it on/g) ?? []).length).toBe(1);
    // Grouping must actually shrink the render, not merely re-cap the same flat
    // list: this exact 20-aspect/one-reason shape previously rendered ~1072
    // characters even after capping the flat list (every entry still repeated
    // the full reason phrase).
    expect(out.length).toBeLessThan(500);
  });

  it('two distinct reasons among the drops each get their own line, the reason stated once per line', () => {
    const dropped = [
      { aspectId: 'a1', reason: 'draft' as const, count: 1 },
      { aspectId: 'a2', reason: 'draft' as const, count: 2 },
      { aspectId: 'b1', reason: 'unreadable' as const, count: 1 },
    ];
    const report: TypeVisibilityReport = {
      byType: [block({ dropped })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    const draftLine = out.split('\n').find((l) => l.includes('still draft'))!;
    const unreadableLine = out.split('\n').find((l) => l.includes('could not be read'))!;
    expect(draftLine).not.toBe(unreadableLine);
    expect(draftLine).toContain('a1 (1)');
    expect(draftLine).toContain('a2 (2)');
    expect(draftLine).not.toContain('b1');
    expect(unreadableLine).toContain('b1 (1)');
    expect(unreadableLine).not.toContain('a1');
    // Each reason phrase appears exactly once across the whole block.
    expect((out.match(/still draft/g) ?? []).length).toBe(1);
    expect((out.match(/could not be read/g) ?? []).length).toBe(1);
  });
});

describe('type-visibility block — counts-only under the triage views', () => {
  function reportWithDetail(): TypeVisibilityReport {
    return {
      byType: [block({
        enforced: ['own-rule'],
        enforcedCounts: [{ aspectId: 'own-rule', count: 1 }],
        advisory: ['warn-only'],
        advisoryCounts: [{ aspectId: 'warn-only', count: 1 }],
        dropped: [{ aspectId: 'dead-rule', reason: 'whole-unit-rule', count: 1 }],
        halfExpandedBundles: [{ bundleId: 'bundle', enforced: ['own-rule'], dropped: ['dead-rule'] }],
      })],
      zeroEnforcement: { count: 1, samples: ['z.ts'] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
  }

  it('the full view shows the per-aspect reason breakdown, bundle name, chain line, and zero-enforcement samples', () => {
    const out = renderTypeVisibilityBlock(typeVisibilityResult(reportWithDetail()));
    expect(out).toContain('own-rule (1)');
    expect(out).toContain('warn-only (1)');
    // The reason is grouped: stated once, followed by the aspect id it applies to.
    expect(out).toMatch(/whole-unit.*dead-rule \(1\)/);
    expect(out).toContain('bundle: file-level part applies');
    expect(out).toContain("inherited rules stop at 't'");
    expect(out).toContain('z.ts');
  });

  it('--summary / --top keep this block to counts only — never the per-aspect reason text, bundle names, chain line, or file samples', () => {
    const out = renderTypeVisibilityBlock(typeVisibilityResult(reportWithDetail()), { countsOnly: true });
    expect(out).toContain('1 rule enforced');
    expect(out).toContain('1 advisory');
    expect(out).toContain('1 attached-but-not-enforced instance');
    expect(out).not.toContain('dead-rule');
    expect(out).not.toContain('bundle:');
    expect(out).not.toContain("inherited rules stop at");
    expect(out).not.toContain('z.ts');
  });

  it('formatOutput wires countsOnly for --summary and --top, but not for --details / full', () => {
    const report = reportWithDetail();
    const summaryOut = formatOutput(typeVisibilityResult(report), { kind: 'summary' });
    const topOut = formatOutput(typeVisibilityResult(report), { kind: 'top', n: 1 });
    const fullOut = formatOutput(typeVisibilityResult(report));
    const detailsOut = formatOutput(typeVisibilityResult(report), { kind: 'details' });
    expect(summaryOut).not.toContain('dead-rule');
    expect(topOut).not.toContain('dead-rule');
    expect(fullOut).toContain('dead-rule');
    expect(detailsOut).toContain('dead-rule');
  });
});

describe('type-visibility block — the zero-enforcement line agrees in number', () => {
  it('a SINGLE zero-enforcement file reads "it satisfies", never the plural "they satisfy"', () => {
    const report: TypeVisibilityReport = {
      byType: [],
      zeroEnforcement: { count: 1, samples: ['only.ts'] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('1 file matched by a type has no rules that apply to it — it satisfies coverage with no enforcement:');
    expect(out).not.toContain('they satisfy');
  });

  it('multiple zero-enforcement files keep the plural "they satisfy"', () => {
    const report: TypeVisibilityReport = {
      byType: [],
      zeroEnforcement: { count: 2, samples: ['a.ts', 'b.ts'] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('2 files matched by a type have no rules that apply to them — they satisfy coverage with no enforcement:');
  });
});

describe('type-visibility block — an uncomputable file is never folded into the zero-enforcement line', () => {
  it('names the cycle in its own section, distinct from (and never inside) "Attached but not enforced" or the zero-enforcement line', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'cyclic',
        files: ['src/cyclic/z.ts'],
        uncomputable: [{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: { count: 1, groups: [{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }] },
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('Rules could not be worked out:');
    expect(out).toMatch(/src\/cyclic\/z\.ts.*implies cycle at 'cyclic-a'/);
    expect(out).toContain('1 file matched by a type could not have its rules worked out:');
    // Never counted as "zero applicable rules" — that would claim resolution
    // ran and found nothing, which is false: it never ran at all.
    expect(out).not.toMatch(/no rules that apply/);
    expect(out).not.toContain('Attached but not enforced');
    // Still honestly "Enforced: (none)" (a true statement — no pair exists),
    // never fabricated as enforced just because it is unresolved.
    expect(out).toContain('Enforced: (none)');
  });

  it('the plural rollup sentence agrees in number with multiple uncomputable files', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'cyclic',
        files: ['a.ts', 'b.ts'],
        uncomputable: [{ aspectId: 'cyclic-a', files: ['a.ts', 'b.ts'] }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: { count: 2, groups: [{ aspectId: 'cyclic-a', files: ['a.ts', 'b.ts'] }] },
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('2 files matched by a type could not have their rules worked out:');
  });

  it('--summary / --top still count an unresolved file honestly, never silently as zero', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'cyclic',
        files: ['src/cyclic/z.ts'],
        uncomputable: [{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: { count: 1, groups: [{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }] },
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report), { countsOnly: true });
    expect(out).toContain('1 file could not have its rules worked out (aspect implies cycle)');
    // The counts-only posture holds: no file name, no cycle-naming sentence.
    expect(out).not.toContain('src/cyclic/z.ts');
    expect(out).not.toContain('Rules could not be worked out:');
  });

  // The single-file case above cannot distinguish a FILE count from a RULE
  // count — both read "1" regardless of which the number means. This type has
  // one declared rule (cyclic-a) but TWO files whose cascade cycled on it: the
  // number of rules left unresolved is unknowable (resolution never ran), so
  // only a file count is honest here — "2" must read as files, never rules.
  it('--summary / --top count files, never rules, when one rule leaves several files unresolved', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'cyclic',
        files: ['src/cyclic/y.ts', 'src/cyclic/z.ts'],
        uncomputable: [{ aspectId: 'cyclic-a', files: ['src/cyclic/y.ts', 'src/cyclic/z.ts'] }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: { count: 2, groups: [{ aspectId: 'cyclic-a', files: ['src/cyclic/y.ts', 'src/cyclic/z.ts'] }] },
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report), { countsOnly: true });
    expect(out).toContain('2 files could not have their rules worked out (aspect implies cycle)');
    expect(out).not.toMatch(/\d+ rules? unresolved/);
  });
});

// ── The Enforced count never stands unqualified when it has no confirmed
// verdict behind it (an aspect can be effective-status 'enforced' — the
// architecture says it should block — without a single pair having ever
// produced a real verdict; that is exactly the shape a rule that structurally
// cannot run on a type-covered file takes: every fill infra-errors, so the
// pair sits unverified forever, yet the type-coverage block named it
// "enforced" with no caveat). This cross-references the SAME `unverified`
// issues plain `yg check` already lists in its Errors section — no new
// computation, no re-running check.mjs — so the count can never itself drift
// from what the rest of the same report says. ─────────────────────

describe('type-visibility block — an "enforced" count with no confirmed verdict says so', () => {
  it('every file behind an enforced aspect is still unverified: the count names it plainly', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts', 'b.ts', 'c.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 3 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const issues = ['a.ts', 'b.ts', 'c.ts'].map((f) => unverifiedFileIssue(f, 'validates-input'));
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Enforced: validates-input \(3, 3 unverified\)/);
  });

  it('only SOME files behind an enforced aspect are unverified: the count is the unverified subset, not the total', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts', 'b.ts', 'c.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 3 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    // Only a.ts and b.ts are unverified — c.ts has a confirmed verdict (no
    // matching issue for it), so it must NOT count toward the caveat.
    const issues = [unverifiedFileIssue('a.ts', 'validates-input'), unverifiedFileIssue('b.ts', 'validates-input')];
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Enforced: validates-input \(3, 2 unverified\)/);
  });

  it('every file behind an enforced aspect has a confirmed verdict: the plain count renders exactly as before, no caveat', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, []));
    expect(out).toContain('Enforced: validates-input (1)');
    expect(out).not.toContain('unverified');
  });

  it('an unverified issue for a DIFFERENT aspect on the same file never bleeds into this one\'s count', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts'],
        enforced: ['validates-input', 'other-rule'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 1 }, { aspectId: 'other-rule', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const issues = [unverifiedFileIssue('a.ts', 'other-rule')];
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toContain('validates-input (1)');
    expect(out).not.toMatch(/validates-input \(1, \d+ unverified\)/);
    expect(out).toMatch(/other-rule \(1, 1 unverified\)/);
  });

  it('advisory counts get the same honest caveat as enforced ones', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts'],
        advisory: ['warn-only'],
        advisoryCounts: [{ aspectId: 'warn-only', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [],
    };
    const issues = [unverifiedFileIssue('a.ts', 'warn-only')];
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Advisory.*warn-only \(1, 1 unverified\)/);
  });
});

// ── A run that FILLED and watched the disposition happen (yg check --approve,
// core/fill.ts's in-process handoff) reports it by name instead of the bare
// "unverified" caveat above — the same reason phrase "Attached but not
// enforced" already uses for a static drop, via the same
// describeTypeVisibilityReason function, never a second vocabulary. A row
// naming a file's disposition is never ALSO rendered under "Attached but not
// enforced": that heading would then claim the opposite of "Enforced" for the
// identical file, and the row's own existence proves a real pair was produced
// (status enforced/advisory) — the exact situation none of the other reasons
// in that bucket can ever be in. A run with no row for a file (a plain read
// that never filled, or a disposition this module cannot name) keeps the
// original "K unverified" wording untouched — the required fallback. ────────

describe('type-visibility block — a run that watched the disposition happen names it, not "unverified"', () => {
  it('every unverified file behind the aspect has a matching row: the reason replaces the bare caveat', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts', 'b.ts', 'c.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 3 }],
        dropped: [{ aspectId: 'validates-input', reason: 'node-context-required', count: 3 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: ['a.ts', 'b.ts', 'c.ts'].map((file) => ({ file, aspectId: 'validates-input', reason: 'node-context-required' as const })),
    };
    const issues = ['a.ts', 'b.ts', 'c.ts'].map((f) => unverifiedFileIssue(f, 'validates-input'));
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Enforced: validates-input \(3, 3 cannot run — it needs component context \(ctx\.node \/ ctx\.graph\) that a type-covered file does not have\)/);
    expect(out).not.toContain('3 unverified');
    // Never ALSO under "Attached but not enforced" — the file IS enforced; the
    // caveat above already says plainly why it never produces a verdict.
    expect(out).not.toContain('Attached but not enforced');
  });

  it('only SOME of the unverified files have a matching row: both clauses appear, neither double-counts', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts', 'b.ts', 'c.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 3 }],
        dropped: [{ aspectId: 'validates-input', reason: 'node-context-required', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [{ file: 'a.ts', aspectId: 'validates-input', reason: 'node-context-required' }],
    };
    const issues = ['a.ts', 'b.ts', 'c.ts'].map((f) => unverifiedFileIssue(f, 'validates-input'));
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Enforced: validates-input \(3, 1 cannot run — it needs component context \(ctx\.node \/ ctx\.graph\) that a type-covered file does not have; 2 unverified\)/);
  });

  it('a row for a DIFFERENT aspect on the same files never bleeds into this one\'s caveat', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [{ file: 'a.ts', aspectId: 'other-rule', reason: 'node-context-required' }],
    };
    const issues = [unverifiedFileIssue('a.ts', 'validates-input')];
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toMatch(/Enforced: validates-input \(1, 1 unverified\)/);
    expect(out).not.toContain('cannot run');
  });

  it('a static drop for a DIFFERENT aspect still renders under "Attached but not enforced" alongside a named runtime reason', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        typeId: 'handler',
        files: ['a.ts'],
        enforced: ['validates-input'],
        enforcedCounts: [{ aspectId: 'validates-input', count: 1 }],
        dropped: [
          { aspectId: 'validates-input', reason: 'node-context-required', count: 1 },
          { aspectId: 'other-static-rule', reason: 'whole-unit-rule', count: 1 },
        ],
      })],
      zeroEnforcement: { count: 0, samples: [] },
      uncomputable: NO_UNCOMPUTABLE,
      rows: [{ file: 'a.ts', aspectId: 'validates-input', reason: 'node-context-required' }],
    };
    const issues = [unverifiedFileIssue('a.ts', 'validates-input')];
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report, issues));
    expect(out).toContain('Attached but not enforced');
    expect(out).toMatch(/no component to run it on.*other-static-rule \(1\)/);
    expect(out).not.toMatch(/component context.*validates-input/);
  });
});
