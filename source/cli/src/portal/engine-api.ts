import path from 'node:path';
import type { Graph, GraphNode, AspectStatus, CoverageConfig } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { loadGraphOrAbort } from '../cli/preamble.js';
import { readRulesArtifacts } from '../cli/rules-artifacts.js';
import { walkRepoFiles, listGitTrackedFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { runCheck, scanUncoveredFiles, type CheckResult, type CheckIssue } from '../core/check.js';
// From utils/ (not core/check-coverage-tiers.ts, which only re-exports it) — this
// facade already declares its cli/utils relation, so importing the defining module
// directly adds no new coupling beyond what is already reviewed and visible.
import { isExcludedByCoverage } from '../utils/coverage-exclusion.js';
import { readLock } from '../io/lock-store.js';
import { verifyLock, type LockVerification, type VerifiedPair, type PairState } from '../core/verify-lock.js';
import { computeExpectedPairs, describeCascadeCycle, type PairComputation, type TypeCoverageInput } from '../core/pairs.js';
import type { TypeCoverageResult } from '../core/type-coverage.js';
import { readLogContent } from '../core/log/log-gate.js';
import { CLI_SUPPORTED_SCHEMA } from '../core/graph-loader.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectStatusSources,
  hasNonDraftEffectiveAspects,
  isAggregateAspect,
} from '../core/graph/aspects.js';
import { collectDescendants } from '../core/graph/traversal.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import { parseLog } from '../core/parsing/log-parser.js';
import { groupIssues, type IssueGroup } from '../cli/group-issues.js';
import type { BoundaryInput, SuppressionMarkerInput, FreshnessMarkerInput, SourceFileCountMarkerInput, PortalTypeAllowed } from './contract.js';
// RELATION_TYPES only — this facade already declares its cli/relations/core relation
// (allowed-types.ts is re-exported from there), so this import adds no new coupling.
// allowedRelationTypes itself is NOT imported here: resolveAllowedRelations below reads
// def.relations/relationDefault directly (see its doc comment for why), so importing the
// (fromType, toType)-pair function would be dead weight. It is still the reference
// semantics this function mirrors — cross-checked against it in the test suite.
import { RELATION_TYPES } from '../relations/allowed-types.js';
import { computePortalBoundary as computeBoundaryImpl } from './api/boundary.js';
import { runSuppressionsScan, scanPortalSuppressions as adaptSuppressions } from './api/suppress-scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from './api/suppress-eligibility.js';
import { computePortalTypeCoverage as computeTypeCoverageImpl, toPortalTypeCoverageInput as toTypeCoverageInputImpl } from './api/type-coverage.js';
import { computePortalSourceFileCounts as computeSourceFileCountsImpl } from './api/source-file-counts.js';
import { computePortalFreshness as computeFreshnessImpl } from './api/freshness.js';

/**
 * engine-api — the portal's SOLE gateway to engine internals.
 *
 * Every engine call the portal backend needs is wrapped here, behind a clean,
 * read-only API. The extraction pipeline (extract.ts + derive-*.ts) imports ONLY
 * from this module and from the data contract — it never reaches an engine node
 * directly. That concentrates the entire portal→engine coupling into ONE node
 * (a single seam), instead of a spider of relations fanning into a dozen subsystems.
 *
 * READ-ONLY by construction: this module imports NO lock writer (no writeLock /
 * setEntry / runFill), loads the graph committed-only (noSecrets), and calls only
 * the engine's read-only entry points. The portal read-only aspects are attached to
 * this node and enforce those invariants mechanically.
 *
 * The FULL live boundary (phantom + declared-only + forbidden-type) and the live
 * suppression inventory are computed here too — the only places the portal reaches the
 * relations layer and the ast/suppress scan — so the pipeline stays a pure consumer of
 * the contract this facade produces.
 */

// ── Schema constant ──────────────────────────────────────────────────────────

/** CLI_SUPPORTED_SCHEMA, surfaced through the facade so the pipeline needs no loader import. */
export const PORTAL_SCHEMA_SUPPORTED = CLI_SUPPORTED_SCHEMA;

// ── Structural-metrics core (the `yg structure` pure functions), re-exported ───
//
// The structure panel's derivation reuses the SAME wave-2 pure metrics `yg structure` uses. It is
// surfaced through this facade (not imported directly by the pipeline) so the extraction pipeline
// keeps its single-seam guarantee — the facade already declares its `cli/core/graph` relation, so
// re-exporting graph-metrics adds no new engine coupling. These are pure data-in / data-out
// functions: no I/O, no graph mutation, no lock access.
export {
  edgeUniverse,
  tunnelSpans,
  quotientAtDepth,
  changeReach,
  depthOfPath,
  lcaDepthOfPaths,
  ancestorAtDepth,
  widenedTunnelMetrics,
  rankTunnels,
  TOP_TUNNELS,
} from '../core/graph-metrics.js';
export type { DeclaredRelation, StructEdge, EdgeOrigin, QuotientView } from '../core/graph-metrics.js';

// ── Resolved relation allow-list (architecture "what may depend on what" matrix) ──

/** Resolved per-relation-type allow-list for one node type — default/'*'/[] settled
 *  with the SAME semantics as allowedRelationTypes (the relation-target-forbidden
 *  validator's mirror). 'any' ⇔ this relation type may target every type. */
export function resolveAllowedRelations(graph: Graph, typeId: string): PortalTypeAllowed[] {
  const def = graph.architecture?.node_types?.[typeId];
  if (!def) return [];
  const lists = def.relations;
  const policy = def.relationDefault ?? 'allow';
  const out: PortalTypeAllowed[] = [];
  for (const rt of RELATION_TYPES) {
    const targets = lists?.[rt];
    if (targets === undefined) { if (policy === 'allow') out.push({ type: rt, targets: 'any' }); continue; }
    if (targets.length === 0) continue;                       // explicit [] = forbidden
    if (targets.includes('*')) { out.push({ type: rt, targets: 'any' }); continue; }
    out.push({ type: rt, targets: [...targets] });
  }
  return out;
}

// ── Graph + repo loading ─────────────────────────────────────────────────────

/**
 * Load the project graph committed-only — the portal can provably never read
 * yg-secrets.yaml. `noSecrets: true` is mandatory (enforced by an aspect on this node).
 */
export async function loadPortalGraph(projectRoot: string): Promise<Graph> {
  return loadGraphOrAbort(projectRoot, {
    tolerateInvalidConfig: true,
    noSecrets: true,
  });
}

/** Walk every repo file on disk (read-only), respecting .gitignore — never the git index, so a tracked-but-gitignored file is invisible here (see tracked-file-gitignored, the check that exists precisely because this walk cannot see one). */
export async function walkPortalFiles(projectRoot: string): Promise<string[]> {
  return walkRepoFiles(projectRoot);
}

export { resetNestedProjectRootsCache } from '../io/repo-scanner.js'; // re-exported, not imported directly by the pipeline (single-seam)
export { NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js'; // re-exported so the residue derivation's exclusion filter needs no engine import of its own
// The mapping-expansion cache reset (io/hash.ts) — mirrors
// resetNestedProjectRootsCache above for the same staleness reason: a node's
// mapped directory can gain or lose files between two refreshes of this
// long-lived process, and the cache must not carry the first refresh's
// (now-stale) file list into the second. Re-exported through this single seam
// rather than imported directly by the pipeline, same as every other engine
// read here; costs no new relation beyond the cli/io/stores one this facade
// already declares for the rest of io/hash.ts and io/repo-scanner.ts.
export { resetMappedFilesCache } from '../io/hash.js';
// ── Engine read-only entry points (severities, coverage, pairs, lock) ─────────

/**
 * Reuse the engine: severities + coverage come straight from runCheck. This wrapper
 * exists to supply EVERY boundary input the `yg check` CLI boundary supplies, because
 * core skips a boundary-injected check outright when its input is absent — so anything
 * missing here is not a shorter report, it is a warning the portal silently swallows
 * while the command line prints it:
 *
 *   - the review clock, without which core skips the review-cadence check and the
 *     portal undercounts aspect-review-overdue warnings;
 *   - the committed rules-distribution snapshot, without which core skips the
 *     committed-digest staleness gate and a repo with a stale, hand-edited, or missing
 *     digest reads clean in the portal while `yg check` warns about it.
 *
 * The clock is a REQUIRED parameter — reading it here would make output depend on
 * when the module ran, and a required param is a stronger anti-omission guarantee
 * than a self-supplied default that could silently hide the decision.
 *
 * The rules snapshot is read here via the SAME shared boundary reader the CLI uses,
 * rooted the same way core derives it (parent of `graph.rootPath`) — deterministic
 * relative to on-disk files, so the two boundaries can never disagree about what the
 * installer wrote.
 *
 *   - real `git ls-files` output, for the tracked∩gitignored anomaly check —
 *     without it the portal misses this anomaly entirely while `yg check`
 *     reports it. Derived here from the SAME projectRoot the rules snapshot
 *     above uses, exactly like that read: git absent or the probe failing
 *     degrades to null (skips that one check only), never throws.
 */
export async function runPortalCheck(
  graph: Graph,
  repoFiles: string[],
  nowUtc: () => Date,
  precomputedTypeCoverage?: TypeCoverageResult,
): Promise<CheckResult> {
  return runCheck(graph, repoFiles, {
    nowUtc,
    rulesArtifacts: await readRulesArtifacts(path.dirname(graph.rootPath)),
    trackedFiles: listGitTrackedFiles(path.dirname(graph.rootPath)),
    precomputedTypeCoverage,
  });
}

/** Classify type-level coverage ONCE per run, and its reduced lock-verification shape (see portal/api/type-coverage.ts). */
export async function computePortalTypeCoverage(graph: Graph, repoFiles: string[]): Promise<TypeCoverageResult | undefined> {
  return computeTypeCoverageImpl(graph, repoFiles);
}
export function toPortalTypeCoverageInput(result: TypeCoverageResult | undefined): TypeCoverageInput | undefined {
  return toTypeCoverageInputImpl(result);
}

/** Read the lock and verify it in one read-only step — per-pair states for the portal. */
export function readAndVerifyLock(graph: Graph, typeCoverage?: TypeCoverageInput): { lock: LockFile; verification: Promise<LockVerification> } {
  const lock = readLock(graph.rootPath);
  return { lock, verification: verifyLock(graph, lock, typeCoverage) };
}

/** Reuse the engine: the expected-pair denominator + the LLM/deterministic split. `typeCoverage` is computePortalTypeCoverage's own output, reduced — keeps this in the same universe `yg check` counts. */
export async function computePortalPairs(graph: Graph, typeCoverage?: TypeCoverageInput): Promise<PairComputation> {
  return computeExpectedPairs(graph, { typeCoverage });
}

/**
 * The `why` sentence for a file whose type's rules an aspect `implies` cycle stopped from
 * being resolved at all (`PairComputation.uncomputableTypeCoverage[].cycle`) — the SAME text
 * `yg check`, `yg context --file`, and `yg owner --file` already print for the identical fact,
 * so the pipeline can render it without a third, drifting copy of the wording.
 */
export { describeCascadeCycle };

/** Reuse the engine's coverage scan: repo files mapped to no node. */
export function scanPortalUncovered(graph: Graph, repoFiles: string[]): string[] {
  return scanUncoveredFiles(graph, repoFiles);
}

/**
 * True iff `file` matches a `coverage.excluded` root. Reused by the residue
 * derivation so a deliberately-excluded file is never listed alongside a
 * genuinely-unmapped one — it was skipped on purpose, not silently missed.
 */
export function isPortalFileExcludedByCoverage(file: string, coverage: CoverageConfig): boolean {
  return isExcludedByCoverage(file, coverage);
}

/** Read one node's raw log.md text (read-only; '' when absent). */
export async function readNodeLog(projectRoot: string, nodePath: string): Promise<string> {
  return readLogContent(projectRoot, nodePath);
}

// ── Effective-aspect / status helpers (the cascade the derivations read) ──────

export {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectStatusSources,
  hasNonDraftEffectiveAspects,
  isAggregateAspect,
  collectDescendants,
  selectTierForAspect,
  parseLog,
};

export type {
  AspectStatus,
  GraphNode,
  CheckResult,
  CheckIssue,
  LockVerification,
  VerifiedPair,
  PairState,
  PairComputation,
};

// ── Issue grouping (the worklist reuses the CLI's own grouping) ───────────────

/** Reuse the CLI's own rule grouping + priority cascade for the portal worklist. */
export function groupPortalIssues(issues: CheckIssue[]): IssueGroup[] {
  return groupIssues(issues);
}

/** The shape `groupPortalIssues` returns — re-exported (type-only, no new relation: this
 *  facade already declares the `cli/group-issues` coupling above) so the pipeline can name
 *  a group's fields (`toGroup` in derive-rest.ts) without importing `cli/group-issues` itself. */
export type { IssueGroup };

/** Reuse the CLI's own coverage-code partition so the portal worklist splits
 *  coverage issues out of rule-grouping exactly like the terminal's grouped
 *  renderer (renderErrorSection / renderWarningSection). */
export { FULL_WHAT_CODES, COVERAGE_GROUP_EXCLUDED_CODES } from '../cli/group-issues.js';

// ── FULL live boundary (phantom + declared-only + forbidden-type) ─────────────

/**
 * Compute the FULL live dependency boundary. Returns `null` ONLY when the relation
 * parse genuinely throws (the caller maps that to `unknown: true` — never a fabricated
 * clean boundary). All three classes are derived by a pure join over the relation pass
 * outputs and the architecture matrix; no engine logic changes.
 *
 * `typeCoveredFiles`, when passed, seeds the SAME pass with the pipeline's own
 * type-coverage classification, so the returned `typedEdges` (the live type-relation
 * gate's edges — the same ones `yg structure` widens its own universe with) come from
 * this ONE call rather than a second, dedicated pass — see `computePortalBoundary`'s
 * own doc in api/boundary.ts.
 */
export async function computePortalBoundary(
  graph: Graph,
  projectRoot: string,
  typeCoveredFiles?: Map<string, string>,
): Promise<BoundaryInput | null> {
  return computeBoundaryImpl(graph, projectRoot, typeCoveredFiles);
}

// ── Live suppression inventory ────────────────────────────────────────────────

/**
 * Scan the repo for active yg-suppress waivers and adapt them into the portal's flat
 * marker shape. Reuses the SAME scan `yg suppressions` runs. `typeCoverage` is the
 * caller's own classification, so a type-covered file is a waiver site here too.
 *
 * `underApproximatingAspectIds` (aspects declaring `errs: 'under'` — a deterministic
 * check that produces no false positives by design) is computed here the SAME way
 * `cli/suppressions.ts` computes it for the command-line inventory, and threaded into
 * BOTH the scan (so its case-(d) "waives a check that cannot false-alarm" warning now
 * also fires on the portal path, which it never did while this call passed `undefined`)
 * and the adapter (so each marker's resolved `risk` can read `'errs-under'`). Returns
 * the adapted markers ALONGSIDE the scan's raw `totalMarkers` (including non-waiver
 * `enable` markers) so the caller can fill `PortalCounts.suppressionMarkers` without a
 * second scan.
 */
export async function scanPortalSuppressions(
  graph: Graph,
  projectRoot: string,
  repoFiles: string[],
  typeCoverage?: TypeCoverageResult,
): Promise<{ markers: SuppressionMarkerInput[]; totalMarkers: number }> {
  const knownAspectIds = new Set(graph.aspects.map((a) => a.id));
  const draftAspectIds = new Set(
    graph.aspects.filter((a) => (a.status ?? 'enforced') === 'draft').map((a) => a.id),
  );
  const underApproximatingAspectIds = new Set(
    graph.aspects.filter((a) => a.errs === 'under').map((a) => a.id),
  );
  const typeCoveredFiles = collectTypeCoveredFiles(typeCoverage?.covered);
  const report = await runSuppressionsScan(
    projectRoot,
    repoFiles,
    knownAspectIds,
    collectMappingEntries(graph),
    underApproximatingAspectIds,
    typeCoveredFiles,
    graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
  );
  return {
    markers: adaptSuppressions(report, knownAspectIds, draftAspectIds, underApproximatingAspectIds),
    totalMarkers: report.totalMarkers,
  };
}

// ── Attestation provenance: committed-lock hash + git commit ref (read-only) ──
//
// Both live in api/attestation.ts (split out so each file stays a focused unit, mirroring
// the other api/*.ts children this facade already wraps) — re-exported here under their own
// names so the pipeline's single-seam guarantee holds (it imports only this facade).
export { computePortalLockHash, readGitCommitRef } from './api/attestation.js';

// ── File-aware loop: per-node source freshness (the honesty heartbeat) ─────────

/** Per-node source freshness (see portal/api/freshness.ts) — the file-aware loop
 *  signal that forces a touched node's state to `unverified`, never a stale pass. */
export async function computePortalFreshness(
  graph: Graph,
  lock: LockFile,
): Promise<FreshnessMarkerInput[]> {
  return computeFreshnessImpl(graph, lock);
}

// ── The panel's real file count ─────────────────────────────────────────────

/** Per-node real source-file count (see portal/api/source-file-counts.ts) — the number
 *  the panel shows next to `mappingEntryCount` so an adopter can see both what a node
 *  DECLARES (entries) and what it actually OWNS (files) at a glance. */
export async function computePortalSourceFileCounts(graph: Graph): Promise<SourceFileCountMarkerInput[]> {
  return computeSourceFileCountsImpl(graph);
}
