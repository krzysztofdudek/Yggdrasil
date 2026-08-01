import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck, type CheckResult } from '../../src/core/check.js';
import { runFill } from '../../src/core/fill.js';
import { computeExpectedPairs, type ExpectedPair } from '../../src/core/pairs.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { readRulesArtifacts } from '../../src/cli/rules-artifacts.js';
import { extractPortalData, buildCounts } from '../../src/portal/extract.js';
import {
  computePortalBoundary,
  scanPortalSuppressions,
} from '../../src/portal/engine-api.js';
import type { PortalData } from '../../src/portal/contract.js';
import type { VerifiedPair, PairState } from '../../src/core/verify-lock.js';
import type { Graph } from '../../src/model/graph.js';
import { nodeUnit } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// The acceptance invariant (the count-parity GATE): every count the portal emits is
// DERIVED by reusing the CLI's own read-only functions — never a literal, never a
// re-implementation — so it can never diverge from `yg check`. Asserted on the REAL
// repo graph: this is an integration test against a real .yggdrasil/ + real source.
// runCheck over the whole repo (parse + relation pass) is heavy, so the extraction and
// the independent recomputation are each done once and shared.
//
// The independent recomputation calls runCheck with the SAME boundary inputs the
// `yg check` CLI boundary passes (CHECK_BOUNDARY_OPTIONS below), not with none. That
// distinction is load-bearing: core SKIPS a boundary-injected check outright when its
// input is absent, so an oracle built from a bare runCheck silently agrees with a portal
// that forgot to inject the same input — the two would match at zero, and the whole class
// of "the portal shows fewer warnings than the command line" would pass unnoticed. The
// oracle must be the CLI boundary, not a subset of it.

describe('portal extraction — count parity with yg check (the trust core)', () => {
  let data: PortalData;
  let errors: number;
  let warnings: number;
  let checkCovered: number;
  let checkTotal: number;
  let expectedPairCount: number;
  let nodeCount: number;
  let aspectCount: number;
  let flowCount: number;
  // Independent live boundary + suppression inventory, recomputed via the SAME facade
  // functions the pipeline reuses — never hardcoded counts.
  let liveBoundary: Awaited<ReturnType<typeof computePortalBoundary>>;
  let liveSuppressionCount: number;

  beforeAll(async () => {
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });

    // Independent recomputation via the SAME read-only functions the portal reuses, driven
    // with the CLI boundary's OWN option set (see the note above) so an input the portal
    // fails to inject shows up as a mismatch instead of matching a matching omission.
    const graph = await loadGraph(REPO_ROOT);
    const gitFiles = await walkRepoFiles(REPO_ROOT);
    const check = await runCheck(graph, gitFiles, {
      nowUtc: () => new Date(),
      rulesArtifacts: await readRulesArtifacts(REPO_ROOT),
    });
    const expected = await computeExpectedPairs(graph);

    errors = check.issues.filter((i) => i.severity === 'error').length;
    warnings = check.issues.filter((i) => i.severity === 'warning').length;
    checkCovered = check.coveredFiles;
    checkTotal = check.totalFiles;
    expectedPairCount = expected.pairs.length;
    nodeCount = graph.nodes.size;
    aspectCount = graph.aspects.length;
    flowCount = graph.flows.length;

    // The live boundary + suppression inventory, derived from the SAME facade functions
    // the pipeline calls — so the asserted counts come from the engine, not a literal.
    liveBoundary = await computePortalBoundary(graph, REPO_ROOT);
    const liveMarkers = await scanPortalSuppressions(graph, REPO_ROOT, gitFiles);
    liveSuppressionCount = liveMarkers.length;
  }, 180_000);

  it('severities equal yg check', () => {
    expect(data.meta.counts.errors).toBe(errors);
    expect(data.meta.counts.warnings).toBe(warnings);
  });

  it('coverage equals yg check', () => {
    expect(data.meta.counts.coveredFiles).toBe(checkCovered);
    expect(data.meta.counts.totalFiles).toBe(checkTotal);
  });

  it('verified + refused + unverified + advisoryRefused covers every expected pair', () => {
    // The count-parity identity is status-adjusted: a refused verdict on an ADVISORY aspect
    // leaves the `refused` bucket for `advisoryRefused` (it renders as a non-blocking warning,
    // never a blocking refusal), so the identity now folds that fourth bucket back in. The
    // ledger still accounts for EVERY expected pair without ever showing an advisory refusal
    // as a blocking refused.
    expect(
      data.meta.counts.verified +
        data.meta.counts.refused +
        data.meta.counts.unverified +
        data.meta.counts.advisoryRefused,
    ).toBe(expectedPairCount);
    expect(data.meta.counts.pairsTotal).toBe(expectedPairCount);
    expect(data.meta.counts.pairsLLM + data.meta.counts.pairsDet).toBe(expectedPairCount);
  });

  it('verifiedDet + verifiedLlm split sums back to verified — the deterministic-vs-LLM tally never drifts', () => {
    // Same identity CheckResult.verifiedDet/verifiedLlm must hold: both are read off the
    // identical pairs loop that produces `verified` here, so the split can never diverge
    // from the total it splits.
    expect(data.meta.counts.verifiedDet + data.meta.counts.verifiedLlm).toBe(data.meta.counts.verified);
  });

  it('the blocking refused count is ENFORCED refusals only (this repo: 0); advisory refusals never block', () => {
    // Blocking `refused` counts ENFORCED refusals only. This repo has none, so it is exactly 0,
    // matching `yg check` (0 errors). The honesty invariant: an ADVISORY aspect's refusal renders
    // as a non-blocking `warning` — it lands in `advisoryRefused`, never in the blocking `refused`
    // bucket, and never reddens its node. Asserted here as a live-repo invariant across every
    // advisory row (the concrete advisory-refused-unit rendering is exercised synthetically in the
    // catalogue derivation tests), so it does not depend on any one coincidental refusal existing.
    expect(data.meta.counts.refused).toBe(0);
    // The portal's blocking truth equals `yg check`.
    expect(data.meta.counts.errors).toBe(errors);
    expect(data.meta.counts.warnings).toBe(warnings);
    // No advisory aspect row on any node renders as a blocking `refused`, and no node is reddened
    // to `refused` by an advisory aspect — an advisory refusal is a warning, never a blocking "no".
    for (const node of data.nodes) {
      for (const row of node.effectiveAspects) {
        if (row.status === 'advisory') {
          expect(row.pairState).not.toBe('refused');
        }
      }
    }
  });

  it('catalogue counts are derived, not literals', () => {
    expect(data.meta.counts.nodes).toBe(nodeCount);
    expect(data.meta.counts.aspects).toBe(aspectCount);
    expect(data.meta.counts.flows).toBe(flowCount);
  });

  it('stamps generatedAt after generation (ISO, non-empty)', () => {
    expect(data.meta.generatedAt).not.toBe('');
    expect(Number.isNaN(Date.parse(data.meta.generatedAt))).toBe(false);
  });

  it('reflects writeEnabled and a derived schemaSupported / projectName', () => {
    expect(data.meta.writeEnabled).toBe(false);
    expect(data.meta.schemaSupported.length).toBeGreaterThan(0);
    expect(data.meta.projectName.length).toBeGreaterThan(0);
  });

  // ── Live FULL boundary — derived from the SAME facade/engine functions ──────
  //
  // The portal now carries a LIVE boundary computed by the facade (computePortalBoundary):
  // phantom (undeclared dependency), declared-only (declared relation with no static code
  // backing), and forbidden-type (a dependency the architecture matrix forbids by type).
  // We assert the portal's boundary equals an INDEPENDENT run of the same facade function —
  // never a hardcoded count — so the audit boundary can never drift from the engine.

  it('carries a live FULL boundary (not unknown) on the real repo', () => {
    expect(liveBoundary).not.toBeNull();
    expect(data.boundary.unknown).toBe(false);
  });

  it('boundary phantom/declared-only/forbidden-type counts equal an independent facade run', () => {
    // Dedupe the independent run the same way buildBoundary does, then compare lengths.
    const dedupe = (edges: Array<{ source: string; target: string }>): number => {
      const seen = new Set<string>();
      for (const e of edges) seen.add(`${e.source} ${e.target}`);
      return seen.size;
    };
    expect(data.boundary.phantom.length).toBe(dedupe(liveBoundary!.phantom));
    expect(data.boundary.declaredOnly.length).toBe(dedupe(liveBoundary!.declaredOnly));
    expect(data.boundary.forbiddenType.length).toBe(dedupe(liveBoundary!.forbiddenType));
  });

  it('phantom equals yg check relation errors (zero when the build has none)', () => {
    // The relation-conformance check is the phantom source; on a green repo it is zero, and
    // the portal must report zero phantom edges — never fabricate an undeclared dependency.
    const relationErrors = data.worklist
      .filter((g) => g.rule === 'relation-undeclared-dependency')
      .reduce((n, g) => n + g.nodes.length, 0);
    expect(data.boundary.phantom.length).toBe(relationErrors);
  });

  it('forbidden-type equals zero when the architecture has no relation violations', () => {
    // forbidden-type is a detected edge the matrix forbids; on a graph with no
    // relation-target-forbidden errors, a detected edge that resolved cleanly is always
    // type-allowed (a forbidden code edge would already be an undeclared phantom OR a
    // declared, validator-rejected relation — neither is silently green here).
    expect(data.boundary.forbiddenType.length).toBe(0);
  });

  // ── Live suppression inventory — same scan the command runs ─────────────────

  it('carries a live suppression inventory derived from the same facade scan', () => {
    expect(data.suppressions.length).toBe(liveSuppressionCount);
    // Each entry is well-formed (file + 1-based line + aspect id), never fabricated.
    for (const s of data.suppressions) {
      expect(s.file.length).toBeGreaterThan(0);
      expect(s.line).toBeGreaterThanOrEqual(1);
      expect(typeof s.aspectId).toBe('string');
    }
  });

  it('suppression inventory is sorted by file then line', () => {
    for (let i = 1; i < data.suppressions.length; i++) {
      const prev = data.suppressions[i - 1];
      const cur = data.suppressions[i];
      const byFile = prev.file.localeCompare(cur.file, 'en');
      expect(byFile <= 0).toBe(true);
      if (byFile === 0) expect(prev.line <= cur.line).toBe(true);
    }
  });

  it('per-node suppressions are a subset of the flat inventory keyed by mapped files', () => {
    const flatKeys = new Set(data.suppressions.map((s) => `${s.file}:${s.line}:${s.aspectId}`));
    for (const node of data.nodes) {
      for (const s of node.suppressions) {
        expect(flatKeys.has(`${s.file}:${s.line}:${s.aspectId}`)).toBe(true);
        // The suppression's file must be one the node maps.
        expect(node.mapping.includes(s.file)).toBe(true);
      }
    }
  });
});

// ── buildCounts bucketing — synthetic, exhaustive over every pair-state kind ──────
//
// The integration tests above prove count parity on the REAL repo, but the real lock
// happens to be all-green, so the bucketing SWITCH in buildCounts (verified / refused /
// advisory-warning / default→unverified) is exercised only on its `verified` arm. This
// unit-level block drives buildCounts directly with a SYNTHETIC pair list carrying AT LEAST
// ONE of EACH PairState.kind — including the two fail-closed gate states (prompt-too-large,
// companion-error) that must never read as green and never as a code "no", AND a refused
// verdict on an ADVISORY aspect that must land in `advisoryRefused` (a non-blocking warning),
// never in the blocking `refused` bucket. It pins the invariant the portal's honesty rests on:
// every expected pair lands in exactly one of verified / refused / advisoryRefused / unverified,
// the two gate states fall into unverified, and an advisory refusal never reads as a blocking
// refused.

/** One ExpectedPair per synthetic state; unitKey is unique so they are distinct pairs. */
function expectedPair(
  aspectId: string,
  kind: 'llm' | 'deterministic',
  i: number,
  status: ExpectedPair['status'] = 'enforced',
): ExpectedPair {
  const nodePath = `synthetic/node-${i}`;
  return {
    aspectId,
    kind,
    unitKey: nodeUnit(nodePath),
    nodePath,
    status,
    subjectFiles: [`source/synthetic/file-${i}.ts`],
  };
}

function verifiedPair(pair: ExpectedPair, state: PairState): VerifiedPair {
  return { pair, state };
}

/** A minimal Graph carrying only the three catalogue sizes buildCounts reads. */
function syntheticGraph(nodes: number, aspects: number, flows: number): Graph {
  return {
    nodes: new Map(Array.from({ length: nodes }, (_, i) => [`n${i}`, {} as never])),
    aspects: Array.from({ length: aspects }, () => ({}) as never),
    flows: Array.from({ length: flows }, () => ({}) as never),
  } as unknown as Graph;
}

/** A minimal CheckResult carrying only the severity + coverage fields buildCounts reads. */
function syntheticCheck(opts: {
  errors: number;
  warnings: number;
  coveredFiles: number;
  totalFiles: number;
  draftSkipped: number;
  typeCoveredCount?: number;
  excludedFiles?: number;
}): CheckResult {
  const issues = [
    ...Array.from({ length: opts.errors }, () => ({ severity: 'error' as const })),
    ...Array.from({ length: opts.warnings }, () => ({ severity: 'warning' as const })),
  ];
  return {
    projectName: 'synthetic',
    coveredFiles: opts.coveredFiles,
    totalFiles: opts.totalFiles,
    draftSkipped: opts.draftSkipped,
    typeCoveredCount: opts.typeCoveredCount,
    excludedFiles: opts.excludedFiles,
    issues,
  } as unknown as CheckResult;
}

describe('buildCounts — pair-state bucketing over every kind (the honesty switch)', () => {
  // One pair per bucket. The two gate states carry their full payload so we are exercising
  // the REAL state shapes, not a stripped stand-in. The 6th pair is a refused verdict on an
  // ADVISORY aspect (status carried on the pair) — it must land in `advisoryRefused`, never in
  // the blocking `refused` bucket. Each tuple is (verdict state, effective aspect status).
  const cases: Array<{ state: PairState; status: ExpectedPair['status'] }> = [
    { state: { kind: 'verified' }, status: 'enforced' },
    { state: { kind: 'refused', reason: 'a reviewer said no' }, status: 'enforced' },
    { state: { kind: 'unverified' }, status: 'enforced' },
    { state: { kind: 'prompt-too-large', chars: 99_999, limit: 40_000, tierName: 'default' }, status: 'enforced' },
    {
      state: { kind: 'companion-error', messageData: { what: 'companion hook threw', why: 'infra', next: 'fix the hook' } },
      status: 'enforced',
    },
    // Advisory refusal — status-adjusted to a non-blocking warning, NOT a blocking refused.
    { state: { kind: 'refused', reason: 'advisory cap exceeded' }, status: 'advisory' },
  ];

  // Distinct expected pairs (alternating kind so the LLM/det split is also non-trivial),
  // and a verified-pair list of the same length keyed 1:1 to the synthetic states.
  const expected: ExpectedPair[] = cases.map((c, i) =>
    expectedPair(`synthetic/aspect-${i}`, i % 2 === 0 ? 'llm' : 'deterministic', i, c.status),
  );
  const pairs: VerifiedPair[] = cases.map((c, i) => verifiedPair(expected[i], c.state));

  const graph = syntheticGraph(7, 3, 2);
  const check = syntheticCheck({ errors: 4, warnings: 1, coveredFiles: 9, totalFiles: 11, draftSkipped: 6 });
  const counts = buildCounts(graph, check, pairs, expected);

  it('verified + refused + unverified + advisoryRefused === total expected pairs (identity holds)', () => {
    expect(
      counts.verified + counts.refused + counts.unverified + counts.advisoryRefused,
    ).toBe(expected.length);
    expect(counts.pairsTotal).toBe(expected.length);
    expect(counts.pairsLLM + counts.pairsDet).toBe(expected.length);
  });

  it('verifiedDet + verifiedLlm === verified (the split never over/under-counts the total)', () => {
    // Case 0 is the sole verified pair and is `llm` (i % 2 === 0), so the split is 0 det / 1 llm.
    expect(counts.verifiedDet).toBe(0);
    expect(counts.verifiedLlm).toBe(1);
    expect(counts.verifiedDet + counts.verifiedLlm).toBe(counts.verified);
  });

  it('the two fail-closed gate states land in UNVERIFIED — not refused, not dropped', () => {
    // cases: 1 verified, 1 enforced refused, and 3 unverified-bucket (unverified + the two gates).
    expect(counts.verified).toBe(1);
    expect(counts.refused).toBe(1);
    // prompt-too-large AND companion-error each fall into unverified (the default arm),
    // alongside the plain unverified pair → 3 total. They are NOT green and NOT a code "no".
    expect(counts.unverified).toBe(3);
  });

  it('an ADVISORY refusal lands in advisoryRefused, never in the blocking refused bucket', () => {
    // The honesty switch: a `refused` verdict on an advisory aspect is non-blocking signal — it
    // is bucketed as `advisoryRefused` (a warning), so `refused` counts ONLY the enforced
    // refusal. This is the unit-level proof of the same status-adjustment the real-repo parity
    // test asserts end-to-end.
    expect(counts.advisoryRefused).toBe(1);
    expect(counts.refused).toBe(1); // the enforced refusal only — the advisory one did NOT inflate it
  });

  it('derives catalogue, coverage, and severity counts off the engine results, not literals', () => {
    expect(counts.nodes).toBe(7);
    expect(counts.aspects).toBe(3);
    expect(counts.flows).toBe(2);
    expect(counts.errors).toBe(4);
    expect(counts.warnings).toBe(1);
    expect(counts.coveredFiles).toBe(9);
    expect(counts.totalFiles).toBe(11);
    expect(counts.uncoveredFiles).toBe(2);
    expect(counts.draft).toBe(6);
    // pairs alternate llm/det across 6 synthetic pairs → 3 llm, 3 det.
    expect(counts.pairsLLM).toBe(3);
    expect(counts.pairsDet).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// A type-covered file (satisfied by the type-level lattice, no node of its own)
// must never be double-counted as "uncovered" on top of an aspect actually
// checking it. `PortalCounts.coveredFiles` keeps its pre-existing conflated
// meaning (nodeOwnedFiles + excludedFiles) — it is not redefined here — but
// `uncoveredFiles` must subtract the type-covered files too, and the two new
// fields must read straight off CheckResult's own honest split.
// ---------------------------------------------------------------------------
describe('buildCounts — type-covered files leave uncoveredFiles, coveredFiles keeps its legacy meaning', () => {
  const graph = syntheticGraph(1, 1, 0);
  const check = syntheticCheck({
    errors: 0,
    warnings: 0,
    coveredFiles: 2, // legacy conflated total: 1 node-owned + 1 excluded-root
    totalFiles: 4, // + 1 type-covered + 1 genuinely unmapped
    draftSkipped: 0,
    typeCoveredCount: 1,
    excludedFiles: 1,
  });
  const counts = buildCounts(graph, check, [], []);

  it('typeCoveredCount and excludedFiles read straight off CheckResult, unmodified', () => {
    expect(counts.typeCoveredCount).toBe(1);
    expect(counts.excludedFiles).toBe(1);
  });

  it('coveredFiles keeps its legacy conflated meaning (nodeOwned + excluded) — NOT redefined', () => {
    expect(counts.coveredFiles).toBe(2);
  });

  it('uncoveredFiles subtracts the type-covered files too, leaving only the genuinely unmapped one', () => {
    // totalFiles(4) - coveredFiles(2) - typeCoveredCount(1) = 1 — the one file
    // neither a node, nor the type lattice, nor an exclusion accounts for.
    expect(counts.uncoveredFiles).toBe(1);
  });

  it('a CheckResult with no type-coverage fields at all (flag-off) keeps the pre-existing formula', () => {
    const flagOff = syntheticCheck({ errors: 0, warnings: 0, coveredFiles: 9, totalFiles: 11, draftSkipped: 0 });
    const flagOffCounts = buildCounts(syntheticGraph(1, 1, 0), flagOff, [], []);
    expect(flagOffCounts.typeCoveredCount).toBe(0);
    expect(flagOffCounts.excludedFiles).toBe(0);
    expect(flagOffCounts.uncoveredFiles).toBe(2); // unchanged: totalFiles - coveredFiles - 0
  });
});

// ---------------------------------------------------------------------------
// The nested-project boundary cache must be re-read on every extraction, not
// carried over from an earlier one in the same long-lived `yg portal` process.
// `extractPortalData` calls `resetNestedProjectRootsCache()` at the top of
// every run for exactly this reason (io/repo-scanner.ts). Proven here by
// calling it TWICE against the SAME on-disk project root within one test
// process — the shape a real portal server refresh takes — with a separate
// project appearing on disk between the two calls. Without the reset, the
// second call would silently reuse the first call's (now-stale) empty
// boundary set and count the newly-appeared separate project's file as this
// graph's own.
// ---------------------------------------------------------------------------
describe('extractPortalData re-reads the nested-project boundary on every call (portal refresh)', () => {
  const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');

  it('a separate project appearing between two extractions is excluded on the SECOND call too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-extract-nested-'));
    cpSync(FIXTURE_ROOT, dir, { recursive: true });
    try {
      const before = await extractPortalData(dir, { writeEnabled: false });

      // A separate project appears on disk — a real, independent `.git` checkout
      // — with one ordinary source file inside it. Its subtree must never be
      // walked in as this graph's own source.
      mkdirSync(path.join(dir, 'vendored-dep', '.git'), { recursive: true });
      writeFileSync(path.join(dir, 'vendored-dep', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
      writeFileSync(path.join(dir, 'vendored-dep', 'extra.ts'), 'export const extra = 1;\n', 'utf-8');

      const after = await extractPortalData(dir, { writeEnabled: false });

      expect(after.meta.counts.totalFiles).toBe(before.meta.counts.totalFiles);
      expect(after.meta.counts.coveredFiles).toBe(before.meta.counts.coveredFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The heart of it: a type-covered file that a real deterministic aspect just
// refused must never ALSO read as "unmapped (unguarded)" in the same payload —
// and a type-covered file whose matched type carries NO rule at all must never
// read as "satisfied" either. portal-type-coverage is the one committed
// fixture with coverage.type_level on: one node-owned file, one type-covered
// file carrying a genuine refused verdict (a live deterministic check, no lock
// committed), one type-covered file matched by a type with zero rules (zero
// enforcement), one excluded-root file. Every count and the residue ledger are
// asserted against real, independently-derived numbers — never a literal.
// ---------------------------------------------------------------------------
describe('extractPortalData over a real tier-on fixture — a checked file is never called unguarded, and an unchecked one is never called satisfied', () => {
  const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-type-coverage');

  async function extractWithRealRefusal(): Promise<{ data: PortalData; dir: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-extract-typecov-'));
    cpSync(FIXTURE_ROOT, dir, { recursive: true });
    // Fill the one deterministic pair LIVE (no committed lock) — the fixture's
    // FIXME comment makes this a genuine refusal, not a fabricated state.
    const graph = await loadGraph(dir);
    const gitFiles = await walkRepoFiles(dir);
    await runFill(graph, { coverageVisibleFiles: gitFiles, trackedFiles: gitFiles, onlyDeterministic: true, write: () => {} });
    const data = await extractPortalData(dir, { writeEnabled: false });
    return { data, dir };
  }

  it('the type-covered file carries a real refused pair (the fixture is doing its job)', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.meta.counts.refused).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts reconcile with the four honest terms: 1 node-owned + 2 type-covered (1 enforced, 1 not) + 1 excluded, 0 genuinely uncovered', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.meta.counts.totalFiles).toBe(4);
      expect(data.meta.counts.typeCoveredCount).toBe(2);
      expect(data.meta.counts.typeCoveredUnenforced).toBe(1);
      expect(data.meta.counts.excludedFiles).toBe(1);
      expect(data.meta.counts.coveredFiles).toBe(2); // legacy: nodeOwned(1) + excluded(1)
      expect(data.meta.counts.uncoveredFiles).toBe(0); // nothing left over — every file is spoken for
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the refused type-covered file is absent from residue.uncoveredFiles — it is checked, not unguarded', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.uncoveredFiles).not.toContain('src/svc/handler.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the unenforced type-covered file is ALSO absent from residue.uncoveredFiles — it is not "no node maps it" the way a genuinely unmapped file is', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.uncoveredFiles).not.toContain('src/lib/util.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the excluded-root file is ALSO absent from residue.uncoveredFiles — it is deliberately skipped, not unguarded either', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.uncoveredFiles).not.toContain('vendor/tool.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('residue.uncoveredFiles.length agrees with counts.uncoveredFiles — the chip and the export list can never disagree', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.uncoveredFiles.length).toBe(data.meta.counts.uncoveredFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('residue.typeCovered names BOTH type-covered files, each with its matched type and real enforcement state — the checked one and the unchecked one are never rendered the same way', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.typeCovered).toEqual([
        { path: 'src/lib/util.ts', type: 'lib', enforced: false },
        { path: 'src/svc/handler.ts', type: 'svc', enforced: true },
      ]);
      // The post-pass count is derived from this SAME list, so the two can never disagree.
      expect(data.meta.counts.typeCoveredUnenforced).toBe(
        data.residue.typeCovered.filter((f) => !f.enforced).length,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('residue.excludedFiles names the excluded-root file by path — it has somewhere to be found by name, not only a number', async () => {
    const { data, dir } = await extractWithRealRefusal();
    try {
      expect(data.residue.excludedFiles).toEqual(['vendor/tool.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A type whose rules an aspect `implies` cycle stopped from being resolved at
// all is a THIRD state, distinct from both "enforced" and "matched a type
// with zero applicable rules". `yg check`, `yg context --file`, and `yg owner
// --file` all say so plainly and name the cycle, rather than reporting the
// file as satisfying coverage with no enforcement — the exact sentence
// docs/configuration.md forbids for this case. The portal must agree: a file
// whose cascade never ran must never be folded into the same "no rule
// applies" bucket as a file whose cascade ran and found nothing.
// ---------------------------------------------------------------------------
describe('extractPortalData over a fixture with a real aspect implies cycle — a file whose rules could not be worked out is never called "no rule applies"', () => {
  const BASE_FIXTURE = path.resolve(__dirname, '../fixtures/type-level-engine');
  const CYCLIC_OVERLAY = path.resolve(__dirname, '../fixtures/type-level-engine/variants/cyclic-type');

  async function extractWithCycle(): Promise<{ data: PortalData; dir: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-extract-cyclic-'));
    cpSync(BASE_FIXTURE, dir, { recursive: true });
    cpSync(CYCLIC_OVERLAY, dir, { recursive: true });
    const data = await extractPortalData(dir, { writeEnabled: false });
    return { data, dir };
  }

  // Ground truth, independently confirmed against `yg check` on this exact fixture
  // combination: 7 type-covered files total, of which 5 are genuinely enforced
  // (consumer, forked, classifying-parent, leaf, underStrict each have at least one
  // rule that actually runs), 1 has a matched type with literally no aspects at all
  // (emptyparents — the zero-enforcement case), and 1 hit the aspect `implies` cycle
  // (cyclic — cyclic-a <-> cyclic-b) before resolution ever ran.

  it('counts.typeCoveredUncomputable is 1 and typeCoveredUnenforced is 1 — never conflated into 2', async () => {
    const { data, dir } = await extractWithCycle();
    try {
      expect(data.meta.counts.typeCoveredCount).toBe(7);
      expect(data.meta.counts.typeCoveredUncomputable).toBe(1);
      expect(data.meta.counts.typeCoveredUnenforced).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('residue.typeCovered excludes the uncomputable file entirely — it is neither enforced nor unenforced, it is unresolved', async () => {
    const { data, dir } = await extractWithCycle();
    try {
      expect(data.residue.typeCovered.map((f) => f.path)).not.toContain('src/cyclic/z.ts');
      expect(data.residue.typeCovered).toHaveLength(6);
      const unenforced = data.residue.typeCovered.filter((f) => !f.enforced);
      expect(unenforced).toEqual([{ path: 'src/ep/e.ts', type: 'emptyparents', enforced: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('residue.typeCoveredUncomputable names the cycle file, its type, and the SAME cycle sentence yg check/yg context --file/yg owner --file already print', async () => {
    const { data, dir } = await extractWithCycle();
    try {
      expect(data.residue.typeCoveredUncomputable).toHaveLength(1);
      const entry = data.residue.typeCoveredUncomputable[0];
      expect(entry.path).toBe('src/cyclic/z.ts');
      expect(entry.type).toBe('cyclic');
      expect(entry.why).toMatch(/implies cycle/);
      expect(entry.why).toContain('cyclic-a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts.typeCoveredCount partitions exactly into enforced + unenforced + uncomputable, with nothing double-counted or dropped', async () => {
    const { data, dir } = await extractWithCycle();
    try {
      const enforcedCount = data.residue.typeCovered.filter((f) => f.enforced).length;
      const unenforcedCount = data.residue.typeCovered.filter((f) => !f.enforced).length;
      const uncomputableCount = data.residue.typeCoveredUncomputable.length;
      expect(enforcedCount + unenforcedCount + uncomputableCount).toBe(data.meta.counts.typeCoveredCount);
      expect(unenforcedCount).toBe(data.meta.counts.typeCoveredUnenforced);
      expect(uncomputableCount).toBe(data.meta.counts.typeCoveredUncomputable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// An excluded file is excluded rather than unguarded — that rule does not read
// coverage.type_level, so it holds even with the tier off. Every other committed
// flag-off fixture carries no coverage.excluded root at all, so none of them can
// tell a reader whether turning the tier off also turns this off; this one can.
// ---------------------------------------------------------------------------
describe('extractPortalData over a flag-off fixture with an excluded root — exclusion still moves a file out of the unguarded residue with the type-level tier off', () => {
  const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-flagoff-excluded');

  async function extractFlagOff(): Promise<{ data: PortalData; dir: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-extract-flagoff-excl-'));
    cpSync(FIXTURE_ROOT, dir, { recursive: true });
    const data = await extractPortalData(dir, { writeEnabled: false });
    return { data, dir };
  }

  it('the type-level tier is genuinely off on this fixture — typeCoveredCount is 0', async () => {
    const { data, dir } = await extractFlagOff();
    try {
      expect(data.meta.counts.typeCoveredCount).toBe(0);
      expect(data.meta.counts.typeCoveredUnenforced).toBe(0);
      expect(data.meta.counts.typeCoveredUncomputable).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts reconcile: 1 node-owned + 1 excluded + 2 genuinely unmapped, out of 4 total', async () => {
    const { data, dir } = await extractFlagOff();
    try {
      expect(data.meta.counts.totalFiles).toBe(4);
      expect(data.meta.counts.excludedFiles).toBe(1);
      expect(data.meta.counts.coveredFiles).toBe(2); // legacy: nodeOwned(1) + excluded(1)
      expect(data.meta.counts.uncoveredFiles).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the excluded file lands in residue.excludedFiles, not residue.uncoveredFiles, with the tier off', async () => {
    const { data, dir } = await extractFlagOff();
    try {
      expect(data.residue.excludedFiles).toEqual(['vendor/tool.ts']);
      expect(data.residue.uncoveredFiles).not.toContain('vendor/tool.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the two files that were never excluded stay in residue.uncoveredFiles — exclusion does not sweep up unrelated unmapped files', async () => {
    const { data, dir } = await extractFlagOff();
    try {
      expect(data.residue.uncoveredFiles.slice().sort()).toEqual(['src/lib/util.ts', 'src/svc/handler.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
