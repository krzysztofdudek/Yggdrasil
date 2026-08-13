/**
 * source/cli/src/core/check.ts — the `yg check` read (spec §6).
 *
 * A pure read: it verifies, it never writes. Every aspect verdict is validated by
 * re-hashing the stored lock entry against current inputs — no reviewer is called
 * and no verdict is produced here; the lock is written only by the fill stage
 * behind `yg check --approve`. Relation conformance is the one exception to
 * "stored": it is never cached, and is recomputed live on every call, so its
 * result is always the current truth.
 *
 * Order:
 *   1. The type-level classification lattice and the import-resolution pass, each
 *      computed ONCE and both BEFORE structural validation — so a rule whose
 *      applicability is gated on a file's classified type or on its real
 *      dependencies is answered from the same facts every later step reads,
 *      instead of from an absent index that silently answers every such condition
 *      the same way (a positively-gated rule never attaching; a negated one always
 *      attaching).
 *   2. Structural + completeness validation, then the two standalone gates fed by
 *      injected inputs: review cadence and committed-digest drift.
 *   3. Everything the verdict lock answers for — pair verdicts, relation
 *      conformance, the type gate, log integrity and the mandatory-log
 *      requirement — fail-closed on a lock that cannot be read.
 *   4. Coverage, plus the one anomaly check fed by injected git output.
 *   5. Assemble: combine the issue sets; classify them against the change scope
 *      when one was supplied (a finding the change is not accountable for
 *      becomes a non-blocking `-outside` twin, so the tallies below all read the
 *      classified list); pick the single next step; and — only when the caller
 *      asks for it — write the silent attention index as a byproduct, after the
 *      issue set is final so it can never change one.
 *
 * INJECTED INPUTS, gated HERE. The engine keeps no clock, shells out to no git,
 * and reads no files of its own: a caller supplies each such input, and an absent
 * one silently SKIPS exactly the check that needed it. Those gates are written in
 * this file's own body deliberately — that is what lets the rule proving every
 * call site complete derive the gated set from the same place the gates live.
 *
 * This module is the orchestrator: it owns the ORDER above, that gating, and
 * little else. The cohesive stages live in sibling files and are wired in here:
 *   - check-contract.ts       — the public issue/result contract
 *   - check-pair-issues.ts    — one verified pair's state → the issues it reports
 *   - check-log-state.ts      — log integrity/format + the mandatory-log requirement
 *   - check-lock-phase.ts     — everything gated on a readable lock (step 3)
 *   - check-coverage-scan.ts  — the uncovered-file and tracked∩gitignored scans
 *   - check-coverage-phase.ts — coverage tiers + the type-level lattice (step 4)
 *   - check-coverage-tiers.ts — the single coverage-tier / exclusion authority
 *   - check-progressive.ts    — the change-scope classification of the assembled
 *                               issues (in scope ⇒ untouched; outside ⇒ its
 *                               `-outside` twin at warning severity)
 *   - check-byte-guard.ts     — the gathering half of the byte guard: the
 *                               subject bytes of every blocking obligation the
 *                               scope is about to treat as inherited, so the
 *                               pure comparer can re-admit any whose content
 *                               provably moved despite git reporting otherwise
 *   - check-suggested-next.ts — the one `next` a finished check points at
 *
 * `runAttentionDump` — the read-only calibration lens behind a hidden flag —
 * stays HERE rather than moving to a sibling of its own: this is the single
 * module permitted to import the feature-field index writer at all, and the lens
 * reads its cohort helpers from exactly that module.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { excludeNestedGraphSubtrees } from '../io/repo-scanner.js';
import { toPosixPath } from '../utils/posix.js';
import { computeTypeCoverageCached } from './type-coverage.js';
import type { TypeCoverageResult } from './type-coverage.js';
import type { TypeCoverageInput } from './pairs.js';
import { validate } from './validator.js';
import type { BurnSet } from './progressive-scope.js';
import { forceInScopeOnByteMismatch } from './progressive-scope.js';
import { collectByteGuardCandidates } from './check-byte-guard.js';
import { checkReviewOverdue } from './checks/aspect-contracts.js';
import { checkDigestGate } from './checks/digest-gate.js';
import type { RulesArtifacts } from './checks/digest-gate.js';
// ── Relation-conformance (computed live, parse + resolve every run) ──
import { runProjectRelationPass } from '../relations/pass.js';
import type { RelationPassResult } from '../relations/pass.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import type { CheckIssue, CheckResult } from './check-contract.js';
import { runLockPhase } from './check-lock-phase.js';
import type { LockVerification } from './verify-lock.js';
import { runCoveragePhase } from './check-coverage-phase.js';
import { scanUncoveredFiles, scanTrackedButIgnored } from './check-coverage-scan.js';
import { computeSuggestedNext } from './check-suggested-next.js';
import { applyChangeScope, countOutside } from './check-progressive.js';
// ── Silent feature-field deviation index (L3 attention) — the writer lives HERE ONLY,
//    behind the runCheck fence (G2). cli/check.ts calls runAttentionDump, never the writer. ──
import {
  writeFeatureIndex,
  computeFamilyDeviations,
  groupByFamily,
  nodeOnlyFamilyOwner,
  median,
  DIMS,
  DIM_LABEL,
  MIN_N,
  Z_ADMIT,
} from './feature-index-write.js';

// ── Public surface ─────────────────────────────────────────

export type { CheckIssue, CheckResult } from './check-contract.js';
export { scanUncoveredFiles, scanTrackedButIgnored } from './check-coverage-scan.js';
export { computeSuggestedNext } from './check-suggested-next.js';
export {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
} from './check-coverage-tiers.js';

// ── Check orchestrator ────────────────────────────────────

/**
 * Run the full check (spec §6): structural validation → coverage → prompt-size
 * gate → lock verification → relation conformance (LIVE) → log integrity → report.
 *
 * Aspect verdicts are validated by hashing against the lock (no LLM calls, no
 * writes — the lock is the only persisted aspect-verification state). Relation
 * conformance is NOT cached: it runs live every call (parse + resolve + verify,
 * keyless, no LLM calls), so the result is always current.
 *
 * @param coverageVisibleFiles -- coverage-visible file list (CLI's
 *        `walkRepoFiles` output, gitignore-aware/git-independent). Null skips
 *        the coverage section. NOT git-derived — see `options.trackedFiles`.
 * @param options.trackedFiles -- INJECTED real `git ls-files` output, for the
 *        tracked∩gitignored anomaly check (`scanTrackedButIgnored`), the ONE
 *        remaining git consumer here. Absent/null skips just that check.
 * @param options.nowUtc -- INJECTED clock for the review-cadence check (spec
 *        RZ-18); absent skips it. Read-only — never writes the lock, changes
 *        a verdict, or gates `--approve`.
 * @param options.writeFeatureIndex -- true only from cli/check.ts's report
 *        path: write the SILENT feature-field deviation index after issues
 *        are computed. Best-effort — never changes the issue set or exit code.
 * @param options.now -- INJECTED clock stamped into the index's `generatedAt`.
 * @param options.rulesArtifacts -- INJECTED snapshot of the committed
 *        rules-distribution artifacts plus the installed CLI's canonical
 *        digest, for the committed-digest staleness gate; same absence-skips
 *        seam as `nowUtc`. Read-only.
 * @param options.changeScope -- INJECTED change scope. Plain data: the burn
 *        set a caller already computed plus the name it was measured against.
 *        Core touches no git and resolves no reference itself. Supplying it
 *        REWRITES the assembled issue list (core/check-progressive.ts): a
 *        finding the change is not accountable for is re-coded to its
 *        `-outside` twin at warning severity, so it still appears and is still
 *        counted but no longer blocks. Absent ⇒ the list is unrewritten and
 *        every count, code and exit code is exactly what it always was.
 */
// Each field below is ISSUE-GATING (`options?.<key> ? <issues> : []` — absence
// silently skips a check), a WHOLE-LIST REWRITE
// (`options?.<key> ? fn(list, options.<key>) : list` — absence leaves the whole
// issue list unrewritten), or a side-effect switch. A NEW optional field must be
// one of those three, or `.yggdrasil/aspects/runcheck-injected-input-parity`
// refuses it as unclassified: write one of the two ternaries, or list it in that
// check.mjs's SIDE_EFFECT_ONLY allowlist (it alters no issue) or its
// ISSUE_TRANSFORM map (it will, once its consumer lands) with a reason.
export interface RunCheckOptions {
  /** INJECTED clock for the review-cadence check (spec RZ-18). Absent ⇒ that check is skipped. */
  nowUtc?: () => Date;
  /** Write the silent feature-field deviation index after issues are computed (default false). */
  writeFeatureIndex?: boolean;
  /** INJECTED clock for the index's `generatedAt`; defaults to `() => new Date()` when writing. */
  now?: () => Date;
  /** INJECTED rules-artifacts snapshot for the committed-digest staleness gate. Absent ⇒ skipped. */
  rulesArtifacts?: RulesArtifacts;
  /**
   * INJECTED real `git ls-files` output (null when git is absent or the probe
   * failed), for the tracked∩gitignored anomaly check. Absent or null ⇒ that
   * one check is skipped — core reads no git itself, and every other coverage
   * check is fed entirely by `coverageVisibleFiles` (the disk walk), unaffected.
   */
  trackedFiles?: string[] | null;
  /** INJECTED already-classified result — skips a second classify when a caller (runFill) already ran one. Absent ⇒ classified here. */
  precomputedTypeCoverage?: TypeCoverageResult;
  /**
   * INJECTED already-computed import-resolution pass — skips a second parse of
   * every mapped source file when a caller (runFill) already ran one in the same
   * process. Absent ⇒ run here, as on every plain `yg check`.
   *
   * Sound on both fill paths for the same reason: this pass reads SOURCE, and a
   * fill writes only lock and log files. Whatever it resolved before the fill it
   * would resolve identically after, so re-running it can only reproduce the
   * result already in hand. (`precomputedTypeCoverage` above is injected for the
   * same reason and by the same caller — these two travel together, since the
   * lattice feeds this pass and this pass feeds the type-coverage input built
   * from it.)
   */
  precomputedRelationPass?: RelationPassResult;
  /**
   * INJECTED already-computed lock verification — skips re-hashing every
   * expected pair when the caller already did it against the SAME lock bytes in
   * this process. Absent ⇒ verified here, as on every plain `yg check`.
   *
   * ONLY safe for a caller that has written NOTHING since it computed this. That
   * is exactly one caller: `runFill`'s `--dry-run` preview, which is structurally
   * incapable of writing (it returns before the verdict writer is even
   * constructed) and so is reporting on a lock byte-identical to the one it
   * classified moments earlier. Re-hashing it was most of what made a preview
   * documented as free cost roughly what a real run costs.
   *
   * A REAL fill must NOT pass this: it writes verdicts between the two points,
   * and reporting the pre-fill classification afterwards would describe a lock
   * that no longer exists — every pair it just filled would still read as
   * unverified. That path deliberately re-verifies.
   */
  precomputedVerification?: LockVerification;
  /** runFill's own fill→check handoff, this run only. Absent ⇒ none (a plain read never fills). */
  runtimeDispositions?: Array<{ file: string; aspectId: string; code: string }>;
  /**
   * INJECTED change scope: which of this run's obligations the current change is
   * accountable for (`burn`), the plain name it was measured against
   * (`referenceName`, for the report to quote), and the reference tree's
   * path→object-id listing (`blobOidByPath`) the byte guard checks git's own
   * answer against. PLAIN DATA — the caller computes the burn set and reads that
   * listing from git itself; core touches no git and resolves no reference.
   *
   * `blobOidByPath` is `null`, never absent, when the listing could not be
   * obtained: the guard is then skipped, and the run gates exactly as it would
   * have without it. A required-but-nullable member rather than an optional one
   * on purpose — a caller that simply forgot it would silently disarm the guard,
   * and "I could not read the tree" is a fact worth having to state.
   *
   * Consumed as a WHOLE-LIST REWRITE of the assembled issues
   * (`applyChangeScope`, core/check-progressive.ts) — the classification step
   * that re-codes a finding the change did not reach to its `-outside` twin at
   * warning severity, splitting the aggregate coverage finding rather than
   * re-coding it, and keeping any finding it cannot positively attribute as a
   * blocking error. A caller OMITTING it gets the unrewritten list, which is why
   * `.yggdrasil/aspects/runcheck-injected-input-parity` demands this member at
   * every runCheck call site (surfaces wanting global truth pass an explicit
   * `undefined`): a surface that forgot it would silently report a different
   * issue set from every other.
   */
  changeScope?: { burn: BurnSet; referenceName: string; blobOidByPath: Map<string, string> | null };
}

export async function runCheck(
  graph: Graph,
  coverageVisibleFiles: string[] | null,
  options?: RunCheckOptions,
): Promise<CheckResult> {
  const projectRoot = path.dirname(graph.rootPath);
  // Shared across validate() and computeTypeCoverage() below so an uncovered
  // file's content is read at most once per check run, instead of once per
  // consumer.
  const sharedContentCache = new FileContentCache();

  // Coverage config + the type-level lattice, computed ONCE — hoisted ahead of
  // validate() (K15: one classify per run) so checkReviewerPresence (inside
  // validate()) sees the SAME value. Reused from options.precomputedTypeCoverage
  // when supplied; else undefined at flag-off / coverageVisibleFiles === null.
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
  let earlyTypeCoverage: TypeCoverageResult | undefined = options?.precomputedTypeCoverage;
  if (earlyTypeCoverage === undefined && coverageVisibleFiles !== null && coverage.typeLevel) {
    const uncoveredForGate = scanUncoveredFiles(graph, coverageVisibleFiles);
    // computeTypeCoverageCached constructs its own persistent content-hash cache
    // under .yggdrasil/.type-class-cache/ (see io/type-class-cache.ts).
    earlyTypeCoverage = await computeTypeCoverageCached(graph, uncoveredForGate, sharedContentCache);
  }

  // Relation pass (parse + resolve), run ONCE per call — hoisted ahead of
  // validate() so a `relations:` atom in an aspect's `when:` (applicability
  // gated on a type-covered file's statically-resolved imports) is answered
  // from the SAME edge index validate() and the lock verification below both
  // read, instead of an absent index that silently answers every relations:
  // atom false (a positively-gated rule never attaching; a negated one always
  // attaching — both silent). The RESULT is handed to the lock phase below for
  // the relation-conformance and type-gate issues that already consume it —
  // never a second pass. Only the COMPUTATION moved earlier; emission of those
  // issues stays exactly where it was, still conditional on the lock being
  // readable (the lock phase's own try block).
  // Undefined at flag-off or no-git (earlyTypeCoverage above) -> the pass's own
  // type-covered enumeration loop does nothing, zero added parse cost (R3).
  // Reused from options.precomputedRelationPass when a caller already ran the
  // identical pass in this process — see that option for why a fill cannot have
  // invalidated it.
  const relResult = options?.precomputedRelationPass
    ?? await runProjectRelationPass(graph, projectRoot, earlyTypeCoverage?.covered);

  const typeCoverageInput: TypeCoverageInput | undefined = earlyTypeCoverage
    ? {
        covered: earlyTypeCoverage.covered,
        ambiguousPaths: earlyTypeCoverage.ambiguous.map((a) => a.file),
        edges: relResult.typedEdges,
      }
    : undefined;

  // 1. Validation (structural + completeness)
  const validation = await validate(graph, 'all', sharedContentCache, typeCoverageInput);
  // Filter out issues without a code -- they are internal (e.g., invalid-scope).
  const validationIssues: CheckIssue[] = validation.issues
    .filter(vi => vi.code)
    .map(vi => ({ ...vi, code: vi.code! }));

  // 1b. Review-cadence (spec RZ-18): overdue is a warning computed against an
  // INJECTED clock. Absent clock ⇒ skip (no fabricated Date.now in core). Merged
  // into the issue set exactly like validationIssues; never blocks (warning) and
  // never touches the lock.
  const reviewOverdueIssues: CheckIssue[] = options?.nowUtc
    ? checkReviewOverdue(graph, options.nowUtc())
        .filter(vi => vi.code)
        .map(vi => ({ ...vi, code: vi.code! }))
    : [];

  // 1c. Committed-digest staleness gate: a read-only warning comparing the
  // committed rules-distribution artifacts against the installed CLI's
  // canonical digest. INJECTED snapshot, same seam as nowUtc — core reads no
  // files itself, so an absent snapshot skips the gate entirely. Never blocks,
  // never touches the lock.
  const digestGateIssues: CheckIssue[] = options?.rulesArtifacts
    ? checkDigestGate(options.rulesArtifacts)
        .filter(vi => vi.code)
        .map(vi => ({ ...vi, code: vi.code! }))
    : [];

  // `coverage`/`earlyTypeCoverage` moved above section 1 (K15); read again below.

  // 2. Lock verification: pair verdicts, relation conformance, the type gate,
  // parser-infrastructure failures, log integrity and the mandatory-log
  // requirement — every one of them reported only when the lock can be read.
  // The relation pass computed above is handed in, never re-run.
  const {
    issues: lockIssues,
    verifiedDet,
    verifiedLlm,
    typeVisibility,
    featureFactsByPath,
    featureHashByPath,
    pairs,
  } = await runLockPhase({
    graph,
    projectRoot,
    typeCoverageInput,
    earlyTypeCoverage,
    relResult,
    runtimeDispositions: options?.runtimeDispositions,
    precomputedVerification: options?.precomputedVerification,
  });

  // 3. Coverage scan (unmapped-files / uncovered-advisory), plus the
  // type-level classification lattice (coverage.type_level) when opted in.
  const {
    issues: coverageIssues,
    coveredFiles,
    totalFiles,
    typeCoveredCount,
    nodeOwnedFiles,
    excludedFiles,
    typeLevel,
    classifyingTypeCount,
  } = await runCoveragePhase({
    graph,
    projectRoot,
    coverageVisibleFiles,
    coverage,
    earlyTypeCoverage,
  });
  if (coverageVisibleFiles !== null) {
    // Additive tracked∩gitignored anomaly detection: a git-tracked file positively
    // matched by .gitignore, independent of node mapping. INJECTED real
    // `git ls-files` output — the ONE remaining git consumer in this surface;
    // absent (or the CLI's git probe having failed) SKIPS this check entirely.
    coverageIssues.push(...(options?.trackedFiles ? await scanTrackedButIgnored(graph, options.trackedFiles, coverageVisibleFiles) : []));
  }

  // Combine all issues
  const assembledIssues: CheckIssue[] = [
    ...lockIssues,
    ...validationIssues,
    ...reviewOverdueIssues,
    ...digestGateIssues,
    ...coverageIssues,
  ];

  // Byte guard, gathered BEFORE the classification below reads the scope: the
  // subject bytes of every blocking obligation the measurement is about to treat
  // as inherited. Git can be told to report a modified file as unmodified
  // (`assume-unchanged`, `skip-worktree`), and such a file's obligations would
  // otherwise be released on that false report. Reads nothing at all when there
  // is no scope, no reference listing, or a scope that already went global — so
  // a run with the feature off is untouched by its existence.
  const byteGuardCandidates = await collectByteGuardCandidates(
    options?.changeScope,
    pairs,
    projectRoot,
  );

  // Change-scope classification. With a scope supplied, every finding the
  // change is NOT accountable for is re-coded to its `-outside` twin at warning
  // severity (the aggregate coverage finding is split rather than re-coded); a
  // finding that cannot be attributed stays a blocking error. Absent ⇒ the
  // assembled list is handed on unrewritten, which is every run today that does
  // not opt in. This sits BEFORE the two derived tallies below deliberately: the
  // suggested next step and the advisory count must both read the CLASSIFIED
  // list, or the report would point at a finding it no longer blocks on.
  //
  // The scope it classifies against is the measured one WIDENED by the byte
  // guard — `forceInScopeOnByteMismatch` re-admits any candidate whose bytes
  // disagree with the reference tree and returns the burn set untouched (the
  // same object) when none do, so this is the plain measurement plus, never
  // minus.
  const allIssues = options?.changeScope
    ? applyChangeScope(
        assembledIssues,
        forceInScopeOnByteMismatch(
          options.changeScope.burn,
          byteGuardCandidates,
          options.changeScope.blobOidByPath,
        ),
        pairs,
      )
    : assembledIssues;
  // Deliberately a SECOND, independently-shaped expression rather than a richer
  // return from the call above: the rule that proves every runCheck call site
  // supplies this option derives the rewrite from `options?.<key> ? fn(list, …)
  // : list` exactly, and an object return would make the alternative an object
  // literal, leaving the classification unproven and the gate red everywhere.
  const outsideCount = options?.changeScope ? countOutside(allIssues) : undefined;
  const progressiveReference = options?.changeScope ? options.changeScope.referenceName : undefined;
  const changedInputCount = options?.changeScope ? options.changeScope.burn.changedInputCount : undefined;

  // Node type counts
  const nodeTypeCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const t = node.meta.type;
    nodeTypeCounts.set(t, (nodeTypeCounts.get(t) ?? 0) + 1);
  }

  const suggestedNext = computeSuggestedNext(allIssues);
  const advisoryWarnings = allIssues.filter(i => i.code === 'aspect-violation-advisory').length;
  const draftSkipped = countDraftAspectsAcrossGraph(graph);

  // Silent feature-field deviation index (L3 attention). Written ONLY when the CLI report
  // path requests it — AFTER the full issue set is assembled, so a write failure can never
  // change the issue set or the exit code. `writeFeatureIndex` is internally best-effort
  // (every error swallowed to debugWrite), so this never throws into the check.
  //
  // Scope the index to the repository's coverage-visible, graph-governed universe — EXACTLY the
  // set the coverage layer governs (the walkRepoFiles disk walk minus nested-graph subtrees). This
  // keeps attention off gitignored scratch or a nested-worktree copy that falls under a mapped
  // ancestor directory. With no file list available (coverageVisibleFiles === null) NO index is
  // written — honest scoping.
  if (options?.writeFeatureIndex && featureFactsByPath && featureHashByPath && coverageVisibleFiles !== null) {
    const includedPaths = new Set(
      excludeNestedGraphSubtrees(coverageVisibleFiles).map((f) => toPosixPath(f.trim())),
    );
    await writeFeatureIndex(graph, featureFactsByPath, featureHashByPath, includedPaths, {
      now: options.now ?? (() => new Date()),
      covered: earlyTypeCoverage?.covered,
    });
  }

  return {
    projectName: path.basename(projectRoot),
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    issues: allIssues,
    suggestedNext,
    advisoryWarnings,
    draftSkipped,
    verifiedDet,
    verifiedLlm,
    pairs,
    typeLevel,
    typeCoveredCount,
    classifyingTypeCount,
    nodeOwnedFiles,
    excludedFiles,
    typeVisibility,
    outsideCount,
    progressiveReference,
    changedInputCount,
  };
}

// ── Calibration instrument: `--attention-dump` (writes nothing, exits 0) ──────

/**
 * The calibration instrument behind the hidden `--attention-dump` flag. Runs the
 * relation pass over WARM shards (no new parse — an AST fact cache HIT), computes
 * candidate deviations at the CURRENT `Z_ADMIT`, and returns a plain-language
 * report: each file's raw structural counts grouped by family, outliers marked
 * "worth a closer read". Writes NOTHING, no LLM calls — a read-only lens for
 * re-calibrating the threshold. Returns the formatted string; the CLI prints it
 * and exits 0.
 *
 * `coverageVisibleFiles` scopes the universe to the same coverage-visible, graph-governed
 * set the written index uses (CLI-supplied `walkRepoFiles` disk walk, the same walk the
 * report path uses — core never shells out to git or walks the filesystem itself). A
 * gitignored/scratch file under a mapped ancestor directory is never shown.
 */
export async function runAttentionDump(graph: Graph, coverageVisibleFiles: string[]): Promise<string> {
  const projectRoot = path.dirname(graph.rootPath);
  const ownerOf = nodeOnlyFamilyOwner(buildOwnerIndex(graph.nodes).ownerOf);
  const relResult = await runProjectRelationPass(graph, projectRoot);
  const includedPaths = new Set(
    excludeNestedGraphSubtrees(coverageVisibleFiles).map((f) => toPosixPath(f.trim())),
  );
  const deviations = computeFamilyDeviations(relResult.factsByPath, ownerOf, relResult.hashByPath, includedPaths);
  const dimGet = new Map(DIMS.map((d) => [d.dim, d.get] as const));

  // Group every parsed file's raw vector by family — the SAME grouping the index writer uses
  // (shared helper, so the dump and the written index can never drift on cohort membership).
  const families = groupByFamily(relResult.factsByPath, ownerOf, includedPaths);

  const out: string[] = [];
  out.push('Structural feature field — calibration view (read-only; nothing is written).');
  out.push('');
  out.push("Each file's raw structural counts are compared only against its node's other");
  out.push('same-language files. A file is called "worth a closer read" when it sits far from');
  out.push('its neighbours on some dimension. This is a local hint on a small sample — never a');
  out.push('verdict, and it never affects whether your build passes.');
  out.push(
    `Sensitivity in effect: ${Z_ADMIT} (higher flags fewer, more extreme files); a group needs at ` +
      `least ${MIN_N} same-language files before anything is compared at all.`,
  );
  out.push('');

  if (families.size === 0) {
    out.push('No node owns any parsed source files yet — nothing to compare.');
    return `${out.join('\n')}\n`;
  }

  for (const key of [...families.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const members = families.get(key)!;
    const [, owner, language] = key.split('\x00'); // keys are node\x00<nodeId>\x00<language> here
    const tooFew = members.length < MIN_N;
    const note = tooFew ? ' — too few files to compare; nothing flagged here' : '';
    out.push(`${owner} · ${language}  (${members.length} file${members.length === 1 ? '' : 's'}${note})`);
    for (const m of [...members].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const c = m.fv.categories;
      out.push(`  ${toPosixPath(m.path)}`);
      out.push(
        `      size=${m.fv.nodeCount} nest=${m.fv.depthQuartiles.join('/')} ` +
          `fn=${c['function-like']} cls=${c['class-like']} imp=${c['import-like']} ` +
          `br=${c['branch-like']} call=${c['call-like']} lit=${c['literal-like']}`,
      );
      const dev = deviations.get(m.path);
      if (dev !== undefined) {
        const flags = dev.deviations.map((d) => {
          const get = dimGet.get(d.dim)!;
          const value = get(m.fv);
          const med = median(members.map((mm) => get(mm.fv)));
          const direction = value >= med ? 'high' : 'low';
          return `${DIM_LABEL[d.dim] ?? d.dim} unusually ${direction} (${value}; neighbours ~${med})`;
        });
        out.push(`      → worth a closer read: ${flags.join('; ')}`);
      }
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

// ── Internal helpers ───────────────────────────────────────

/**
 * Count UNIQUE aspect IDs whose aspect-level default status is 'draft'.
 * (Not the count of node×aspect pairs — aspects that are draft on some nodes
 * and non-draft on others are still counted once here.)
 * Surfaced as a header tally in `yg check` so the agent sees how many
 * dormant rules sit in the graph.
 */
function countDraftAspectsAcrossGraph(graph: Graph): number {
  let n = 0;
  for (const aspect of graph.aspects) {
    if ((aspect.status ?? 'enforced') === 'draft') n++;
  }
  return n;
}
