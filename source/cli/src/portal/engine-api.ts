import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Graph, GraphNode, AspectStatus } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { loadGraphOrAbort } from '../cli/preamble.js';
import { readRulesArtifacts } from '../cli/rules-artifacts.js';
import { walkRepoFiles, listGitTrackedFiles } from '../io/repo-scanner.js';
import { runCheck, scanUncoveredFiles, type CheckResult, type CheckIssue } from '../core/check.js';
import { readLock, committedLockContentHash } from '../io/lock-store.js';
import { verifyLock, type LockVerification, type VerifiedPair, type PairState } from '../core/verify-lock.js';
import { computeExpectedPairs, computeSourceFingerprint, type PairComputation, type TypeCoverageInput } from '../core/pairs.js';
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
import type { BoundaryInput, SuppressionMarkerInput, FreshnessMarkerInput } from './contract.js';
import { computePortalBoundary as computeBoundaryImpl } from './api/boundary.js';
import { runSuppressionsScan, scanPortalSuppressions as adaptSuppressions } from './api/suppress-scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from './api/suppress-eligibility.js';
import { computePortalTypeCoverage as computeTypeCoverageImpl, toPortalTypeCoverageInput as toTypeCoverageInputImpl } from './api/type-coverage.js';

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
  TOP_TUNNELS,
} from '../core/graph-metrics.js';
export type { DeclaredRelation, StructEdge, EdgeOrigin, QuotientView } from '../core/graph-metrics.js';

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

/** Walk every git-tracked repo file (read-only). */
export async function walkPortalFiles(projectRoot: string): Promise<string[]> {
  return walkRepoFiles(projectRoot);
}

export { resetNestedProjectRootsCache } from '../io/repo-scanner.js'; // re-exported, not imported directly by the pipeline (single-seam)
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
  gitFiles: string[],
  nowUtc: () => Date,
  precomputedTypeCoverage?: TypeCoverageResult,
): Promise<CheckResult> {
  return runCheck(graph, gitFiles, {
    nowUtc,
    rulesArtifacts: await readRulesArtifacts(path.dirname(graph.rootPath)),
    trackedFiles: listGitTrackedFiles(path.dirname(graph.rootPath)),
    precomputedTypeCoverage,
  });
}

/** Classify type-level coverage ONCE per run, and its reduced lock-verification shape (see portal/api/type-coverage.ts). */
export async function computePortalTypeCoverage(graph: Graph, gitFiles: string[]): Promise<TypeCoverageResult | undefined> {
  return computeTypeCoverageImpl(graph, gitFiles);
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

/** Reuse the engine's coverage scan: repo files mapped to no node. */
export function scanPortalUncovered(graph: Graph, gitFiles: string[]): string[] {
  return scanUncoveredFiles(graph, gitFiles);
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

// ── FULL live boundary (phantom + declared-only + forbidden-type) ─────────────

/**
 * Compute the FULL live dependency boundary. Returns `null` ONLY when the relation
 * parse genuinely throws (the caller maps that to `unknown: true` — never a fabricated
 * clean boundary). All three classes are derived by a pure join over the relation pass
 * outputs and the architecture matrix; no engine logic changes.
 */
export async function computePortalBoundary(graph: Graph, projectRoot: string): Promise<BoundaryInput | null> {
  return computeBoundaryImpl(graph, projectRoot);
}

// ── Live suppression inventory ────────────────────────────────────────────────

/**
 * Scan the repo for active yg-suppress waivers and adapt them into the portal's flat
 * marker shape. Reuses the SAME scan `yg suppressions` runs. `typeCoverage` is the
 * caller's own classification, so a type-covered file is a waiver site here too.
 */
export async function scanPortalSuppressions(
  graph: Graph,
  projectRoot: string,
  gitFiles: string[],
  typeCoverage?: TypeCoverageResult,
): Promise<SuppressionMarkerInput[]> {
  const knownAspectIds = new Set(graph.aspects.map((a) => a.id));
  const draftAspectIds = new Set(
    graph.aspects.filter((a) => (a.status ?? 'enforced') === 'draft').map((a) => a.id),
  );
  const typeCoveredFiles = collectTypeCoveredFiles(typeCoverage?.covered);
  const report = await runSuppressionsScan(projectRoot, gitFiles, knownAspectIds, collectMappingEntries(graph), undefined, typeCoveredFiles);
  return adaptSuppressions(report, knownAspectIds, draftAspectIds);
}

// ── Attestation provenance: committed-lock hash + git commit ref (read-only) ──

/**
 * The content hash of the COMMITTED lock triad — surfaced through the facade so the pipeline
 * needs no lock-store import. Reuses the engine's own `committedLockContentHash` (it folds only
 * the committed nondeterministic + logs files, excluding the gitignored deterministic cache, so
 * the hash is stable across machines for one commit). This is a content-addressed digest of the
 * committed lock ARTIFACT for attestation — never a re-derivation of a verdict or count. Returns
 * '' when no committed lock exists yet.
 *
 * `graph.rootPath` is the `.yggdrasil/` directory the lock files live in.
 */
export function computePortalLockHash(graph: Graph): string {
  return committedLockContentHash(graph.rootPath);
}

/**
 * The current git HEAD commit ref (full sha), read read-only from `.git`. Resolves `.git/HEAD`:
 * a detached HEAD holds the sha directly; a `ref: refs/...` line is followed to the ref file
 * (or the packed-refs fallback). Returns `null` for a non-git directory or any unreadable /
 * malformed HEAD — the digest then states "no commit ref" rather than inventing one. Never
 * spawns a process and never writes; a bounded set of direct file reads under `.git/`.
 *
 * A LINKED WORKTREE's `.git` is not a directory but a pointer FILE (`gitdir: <path>`) to a
 * private per-worktree git-dir under the main repo's `.git/worktrees/<name>/` — that private
 * dir holds this worktree's own `HEAD` (a worktree can be on a different branch than the main
 * checkout), but `refs/heads/*` and `packed-refs` are SHARED and live in the main repo's git-dir,
 * reachable from the private dir's `commondir` file. Both forms are resolved here so the digest
 * reports the real commit whether `yg` runs from the main checkout or a linked worktree.
 *
 * `projectRoot` is the repo root (the parent of `.yggdrasil/`).
 */
export function readGitCommitRef(projectRoot: string): string | null {
  const dotGit = path.join(projectRoot, '.git');
  let dotGitStat;
  try {
    dotGitStat = statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir: string;
  if (dotGitStat.isDirectory()) {
    gitDir = dotGit;
  } else {
    // Linked worktree / submodule: `.git` is a pointer FILE (`gitdir: <path>`).
    let dotGitContent: string;
    try {
      dotGitContent = readFileSync(dotGit, 'utf-8');
    } catch {
      return null;
    }
    const pointerMatch = dotGitContent.match(/^gitdir:\s*(.+?)\s*$/);
    if (!pointerMatch) return null;
    gitDir = resolveRelative(projectRoot, pointerMatch[1]);
  }
  const headFile = path.join(gitDir, 'HEAD');
  if (!existsSync(headFile)) return null;
  let head: string;
  try {
    head = readFileSync(headFile, 'utf-8').trim();
  } catch {
    return null;
  }
  // Detached HEAD: the file holds the sha directly (SHA-1 = 40 hex, SHA-256 = 64 hex).
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(head)) return head;
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (!refMatch) return null;
  const refName = refMatch[1].trim();

  // Refs are shared across worktrees in the COMMON dir. A linked worktree's private git-dir
  // carries a `commondir` file (relative path to the shared main git-dir); a normal checkout
  // has no such file, so refs live directly under `gitDir` (commonDir === gitDir).
  let commonDir = gitDir;
  const commondirFile = path.join(gitDir, 'commondir');
  if (existsSync(commondirFile)) {
    try {
      commonDir = resolveRelative(gitDir, readFileSync(commondirFile, 'utf-8').trim());
    } catch {
      /* fall back to gitDir itself */
    }
  }

  // Loose ref: <commonDir>/<refName> holds the sha.
  const looseRef = path.join(commonDir, refName);
  if (existsSync(looseRef)) {
    try {
      const sha = readFileSync(looseRef, 'utf-8').trim();
      if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) return sha;
    } catch {
      /* fall through to packed-refs */
    }
  }
  // Packed ref fallback: <commonDir>/packed-refs maps `<sha> <refName>`.
  const packed = path.join(commonDir, 'packed-refs');
  if (existsSync(packed)) {
    try {
      const lines = readFileSync(packed, 'utf-8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\s+(.+)$/i);
        if (m && m[2].trim() === refName) return m[1];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve `target` against `base` unless already absolute — shared by the `gitdir`/`commondir`
 *  pointer-file resolution above (both may hold a POSIX-relative or an absolute path). */
function resolveRelative(base: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(base, target);
}

// ── File-aware loop: per-node source freshness (the honesty heartbeat) ─────────

/**
 * Compute per-node source FRESHNESS — the file-aware loop signal. For every node that carries
 * a COMMITTED source baseline (`lock.nodes[path].source`, written at positive closure for a
 * log_required node), compare its current mapped-source fingerprint — the SAME fold `yg check`
 * uses — against that baseline. `sourceChanged: true` when they differ: the node's bytes changed
 * since the reviewer last saw them, so it reads "we don't know", never a pass.
 *
 * Honesty boundary — never over-fire: a node WITHOUT a committed baseline (`stored` absent) is
 * reported `sourceChanged: false`. Engine semantics record a source fingerprint ONLY for
 * log_required types, so a baseline's absence is the normal case, not evidence of a change — the
 * portal must not paint the whole repo unverified from missing baselines. Such a node's freshness
 * is already carried honestly elsewhere: a node with reviewer pairs flips those pairs to
 * `unverified` on any input change (the pair-state path), and a no-rule node is already the
 * distinct, non-green `no-rule` state. This signal adds the ONE case neither covers: a node that
 * HAS a committed baseline (so its green is a real attestation of specific bytes) whose source
 * has since been edited — exactly where a cached green must never re-render as a pass.
 *
 * A mapping-less node has an undefined fingerprint and is never marked changed. Read-only; reuses
 * the engine's own fingerprint function so the portal's freshness can never diverge from the
 * engine's source-change detection.
 */
export async function computePortalFreshness(
  graph: Graph,
  lock: LockFile,
): Promise<FreshnessMarkerInput[]> {
  const out: FreshnessMarkerInput[] = [];
  for (const nodePath of graph.nodes.keys()) {
    const stored = lock.nodes[nodePath]?.source;
    // No committed baseline → no honest claim of change (the common, non-log_required case).
    if (stored === undefined) {
      out.push({ nodePath, sourceChanged: false });
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch {
      // An unreadable mapped file makes the fingerprint uncomputable. The node carries a
      // baseline (it once closed) but we can no longer confirm the bytes hold — never silently
      // fresh: report changed (it is already a blocking file-unreadable error elsewhere).
      out.push({ nodePath, sourceChanged: true });
      continue;
    }
    // Mapping-less node: no source to be fresh/stale about — never marked changed.
    if (fingerprint === undefined) {
      out.push({ nodePath, sourceChanged: false });
      continue;
    }
    out.push({ nodePath, sourceChanged: fingerprint !== stored });
  }
  return out;
}
