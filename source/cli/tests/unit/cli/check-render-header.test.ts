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

// ── Type-visibility block: fix round 1 (advisory heading, cap discipline,
// counts-only triage views, singular grammar) — constructed CheckResult, no
// fixture, so every scenario is exact and controllable. ─────────────────────

function typeVisibilityResult(report: TypeVisibilityReport): CheckResult {
  return { ...baseResult([]), typeLevel: true, typeVisibility: report };
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
    chainTermination: { reason: 'no-parents', candidates: ['t'] },
    ...overrides,
  };
}

describe('type-visibility block — advisory heading never claims enforcement (fix round 1)', () => {
  it('an advisory rule is listed under its own heading, never under "Enforced"', () => {
    const report: TypeVisibilityReport = {
      byType: [block({
        advisory: ['warn-only'],
        advisoryCounts: [{ aspectId: 'warn-only', count: 1 }],
      })],
      zeroEnforcement: { count: 0, samples: [] },
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
    // characters even after the fix-round-1 cap (every entry still repeated the
    // full reason phrase).
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

describe('type-visibility block — counts-only under the triage views (fix round 1)', () => {
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

describe('type-visibility block — the zero-enforcement line agrees in number (fix round 1)', () => {
  it('a SINGLE zero-enforcement file reads "it satisfies", never the plural "they satisfy"', () => {
    const report: TypeVisibilityReport = {
      byType: [],
      zeroEnforcement: { count: 1, samples: ['only.ts'] },
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
      rows: [],
    };
    const out = renderTypeVisibilityBlock(typeVisibilityResult(report));
    expect(out).toContain('2 files matched by a type have no rules that apply to them — they satisfy coverage with no enforcement:');
  });
});
