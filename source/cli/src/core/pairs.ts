/**
 * source/cli/src/core/pairs.ts
 *
 * Read-side foundation for the verdict lock: computes the expected set of
 * (aspect, unit) pairs for a loaded graph and per-node source fingerprints.
 *
 * Public contract (consumed by future check/fill stages):
 *   computeExpectedPairs   — expected pairs for the whole graph
 *   computeSourceFingerprint — sha256 fold over sorted [path, sha256(bytes)] of
 *                              all mapped files (child carve-out applied, binaries
 *                              included by bytes). Format: "path:hash\n..." lines
 *                              sorted, folded with sha256 via hashString.
 *
 * Design:
 *   - scope applies AFTER the 7-channel effectiveness walk, never inside it.
 *   - Aggregate aspects are always excluded (no own reviewer, no own verdict).
 *   - Draft aspects are excluded by default; pass { includeDraft: true } for GC.
 *   - LLM subject sets exclude binary files (by extension); deterministic keeps them.
 *   - Empty subject set → no pair for that (aspect, node) — vacuous pass.
 *   - Nodes with empty mapping → no pairs at all.
 *   - Pairs are sorted by aspectId, then unitKey for deterministic output.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import type { AspectStatus } from '../model/graph.js';
import type { UnitKey } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { toPosixPath } from '../utils/posix.js';
import { nodeUnit, fileUnit } from '../model/lock.js';
import { expandMappingPaths, hashFile, hashString } from '../io/hash.js';
import { probeUnreadable } from '../io/graph-fs.js';
import { normalizeMappingPaths } from '../io/paths.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  isAggregateAspect,
} from './graph/aspects.js';
import { evaluateFileWhen } from './file-when-evaluator.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { BINARY_EXTENSIONS } from '../utils/binary-extensions.js';
import { mappingEntryMatchesFile } from '../utils/mapping-path.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { isExcludedByCoverage } from './check-coverage-tiers.js';
import { computeTypeAspectCascade } from './type-effective.js';
import type { TypeAspectDrop, TypeAspectDropReason, TypeEffectiveAspect, TypeCascadeCycle } from './type-effective.js';
import type { TypedEdgeIndex } from '../relations/pass.js';

// ============================================================
// Public types
// ============================================================

export interface ExpectedPair {
  aspectId: string;
  kind: 'llm' | 'deterministic';
  unitKey: UnitKey;          // nodeUnit(nodePath) for per-node; fileUnit(path) per-file
  /**
   * The component that owns this unit. Absent when the file is enforced by its
   * architecture type and no component owns it — there is no owner to name, and
   * inventing one would put a component in front of a person that does not exist.
   */
  nodePath?: string;
  status: AspectStatus;      // effective status on the node (for rendering/severity)
  subjectFiles: string[];    // repo-relative POSIX, sorted
}

/**
 * Why a rule attached to a file's type does not run on that file. A widening of
 * the cascade's own reasons (`TypeAspectDropReason`, `./type-effective.js`) with
 * the ones only enumeration can decide — the cascade has no concept of
 * `scope.per` / `scope.files` / binary subjects / a missing aspect definition,
 * since those are pair-enumeration concepts, not cascade concepts.
 *
 * Every one of these MUST be recorded wherever the nodeless enumeration below
 * decides an (aspect, file) pair will not exist: a silent `continue` with no
 * drop row leaves nothing to distinguish "does not apply" from "was never
 * checked", and a caller deriving "enforced" from the absence of a drop (never
 * done here — see `type-visibility.ts`'s own contract) would misread the gap
 * as enforcement.
 */
export type PairDropReason =
  | TypeAspectDropReason
  | 'whole-unit-rule'
  | 'scope.files-excluded'
  | 'aspect-undefined'
  | 'unreadable'
  | 'binary-subject';

/**
 * A cascade drop with the file it happened on attached. `TypeAspectDrop` is
 * scoped to the single file a `computeTypeAspectCascade` call was made about and
 * carries no `file` of its own; this is that value WITH the file attached — never
 * push a bare `TypeAspectDrop` into a `PairDrop[]`.
 *
 * `Omit<TypeAspectDrop, 'reason'>` rather than a plain `extends`: `reason` here
 * is WIDENED (`PairDropReason` ⊇ `TypeAspectDropReason`), and a plain `extends`
 * requires the subinterface's property to be assignable to the base's — the
 * narrower-to-wider direction TypeScript structurally forbids. The Omit removes
 * the conflicting field before re-adding it at the wider type; the resulting
 * shape is exactly `{ aspectId: string; file: string; reason: PairDropReason }`.
 */
export interface PairDrop extends Omit<TypeAspectDrop, 'reason'> {
  file: string;
  reason: PairDropReason;
}

/**
 * Type-level coverage facts for one run, computed ONCE (by the caller, from
 * `computeTypeCoverage`) and threaded in here — this function never classifies
 * anything itself. Absent ⇒ no type-covered files exist for this run (the
 * feature is off, or nothing matched), and enumeration behaves exactly as it
 * did before the tier existed.
 */
export interface TypeCoverageInput {
  /** file → matched type id, for every file enforced by its type alone. */
  covered: Map<string, string>;
  /** Files reported ambiguous this run — their stored results are retained, not pruned. */
  ambiguousPaths: string[];
  /** Statically-resolved import edges, for applicability only. Omit when unavailable. */
  edges?: TypedEdgeIndex;
}

/**
 * Represents a candidate subject file that could not be read during scope.files
 * evaluation. The file is excluded from the subject set (it cannot be hashed or
 * reviewed) and is surfaced here so callers can turn it into a blocking error.
 *
 * Callers MUST surface non-empty unreadable as a blocking error — a silently
 * dropped file can turn an enforced rule into a vacuous pass.
 *
 * `messageData` is pre-populated at creation so CLI command handlers can render
 * the diagnostic directly without rebuilding the message from the raw fields.
 */
export interface UnreadableSubject {
  /** Absent for a nodeless (type-covered-file) unreadable subject — follows ExpectedPair's optionality. */
  nodePath?: string;
  aspectId: string;
  path: string;          // repo-relative POSIX
  reason: string;        // from evaluateFileWhen's unreadableReason (or a clear fallback)
  messageData: IssueMessage;
}

/**
 * One type-covered file whose rules could not be worked out at all: the
 * nodeless enumeration's `computeTypeAspectCascade` call absorbed an aspect
 * `implies` cycle for it (see that function's own exception contract). This
 * file contributes ZERO pairs and ZERO drops — not because nothing applies,
 * but because resolution never ran to completion. A caller that folds a file
 * with no pairs/drops into "zero applicable rules" (as `core/type-visibility.ts`
 * did before this type existed) reports a false "satisfies coverage with no
 * enforcement" for a file whose coverage was never actually assessed.
 */
export interface UncomputableTypeCoverage {
  file: string;
  typeId: string;
  cycle: TypeCascadeCycle;
}

/**
 * Return shape of computeExpectedPairs.
 *
 * Callers MUST surface a non-empty `unreadable` array as a blocking error.
 * Silently ignoring it means a file that failed the content filter is dropped
 * from the review surface, which can turn an enforced rule into a vacuous pass
 * (zero pairs = no reviewer invocation = implicit green).
 */
export interface PairComputation {
  pairs: ExpectedPair[];
  unreadable: UnreadableSubject[];
  /** Rules attached to a file's type that do not run on it, with the reason. */
  drops: PairDrop[];
  /** Type-covered files an aspect `implies` cycle stopped from being resolved at all — see `UncomputableTypeCoverage`'s own doc. */
  uncomputableTypeCoverage: UncomputableTypeCoverage[];
}

export interface ComputePairsOptions {
  /** When true, include draft aspects (used by GC universe). Default: false. */
  includeDraft?: boolean;
  /**
   * Files enforced by their architecture type. Absent ⇒ no such files exist for
   * this run (the feature is off, or nothing matched) and enumeration behaves
   * exactly as it did before the tier existed.
   */
  typeCoverage?: TypeCoverageInput;
}

/**
 * Thrown by computeSourceFingerprint when a mapped file cannot be read. A file
 * written into a node's mapping MUST be readable; an unreadable one cannot be
 * hashed, so the fingerprint is undefined rather than silently computed over a
 * partial set. Fill-side callers catch this and decline to advance the node's
 * fingerprint / log baseline (the node is already surfaced as a blocking
 * file-unreadable error by computeExpectedPairs).
 */
export class FileUnreadableError extends Error {
  constructor(
    readonly nodePath: string,
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`mapped file '${filePath}' on node '${nodePath}' is unreadable: ${reason}`);
    this.name = 'FileUnreadableError';
  }
}

// ============================================================
// Sanctioned refactor: getChildMappingExclusions moved here.
// Re-imported in approve.ts and check.ts (import-only change, no behavior change).
// ============================================================

/**
 * Compute child mapping exclusions for the CHILD-PRECEDENCE (child-wins) model.
 *
 * Returns the mapping entries of every strict-descendant node, so a parent's
 * subject-file set can exclude any file a descendant maps. The exclusion is
 * applied by the callers via mappingEntryMatchesFile (glob-aware), so a
 * descendant that claims a specific file INSIDE a directory the parent globs
 * (e.g. parent `src/repo/** /*.cs`, child `src/repo/FooRepository.cs`) genuinely
 * carves that file out of the parent — the deeper node wins, implicitly, with no
 * requirement that the child's mapping string be nested under the parent's.
 * (A previous version gated on `cm === pm || cm.startsWith(pm + '/')`, which only
 * carved a string-nested entry and so never realized child-precedence for a glob
 * parent — the file stayed double-owned. That gate is removed.)
 */
export function getChildMappingExclusions(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  if (normalizeMappingPaths(node.meta.mapping).length === 0) return [];

  const exclusions: string[] = [];
  for (const [childPath, childNode] of graph.nodes) {
    if (childPath === nodePath || !childPath.startsWith(nodePath + '/')) continue;
    for (const cm of normalizeMappingPaths(childNode.meta.mapping)) {
      exclusions.push(cm);
    }
  }
  return exclusions;
}

/**
 * The full mapped subject set for a node: every mapped file (gitignore-aware
 * expansion) with the child carve-out applied, BEFORE any scope.files filter and
 * BEFORE binary exclusion. This is the deterministic-reviewer subject set when an
 * aspect declares no scope filter — identical to the `nodeFiles` set
 * computeExpectedPairs builds at step 4. Repo-relative POSIX paths, unsorted.
 *
 * Used by the fill stage to decide whether a deterministic pair's subject is
 * NARROWER than the node's full mapping (a per:node aspect with a scope.files
 * filter, or a per:file aspect): a narrowed subject must run the structure runner
 * with subjectScope so reads of the excluded siblings fold as observations
 * (spec §1, §3.1) rather than slipping into neither the subject hash nor touched.
 */
export async function computeNodeMappedFiles(
  graph: Graph,
  nodePath: string,
): Promise<string[]> {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const rawMapping = normalizeMappingPaths(node.meta.mapping);
  if (rawMapping.length === 0) return [];

  const projectRoot = path.dirname(graph.rootPath);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  const allExpanded = await expandMappingPaths(projectRoot, rawMapping);
  return excludePrefixes.length > 0
    ? allExpanded.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
    : allExpanded;
}

/**
 * The set of node paths whose effective-aspect computation THROWS (an implies
 * cycle, or any other structural error in the effectiveness engine). These nodes
 * are silently skipped by computeExpectedPairs (they contribute ZERO pairs), so
 * the GC pair universe cannot account for them — it would wrongly read their
 * existing verdict entries as detached and prune paid verdicts (data loss).
 *
 * GC must POSITIVELY prove an entry detached before pruning it. A node in this
 * set could NOT be computed this run, so its entries are retained untouched; the
 * validator still surfaces the cycle as a blocking `aspect-implies-cycle` error.
 * A node that simply no longer exists in the graph is NOT in this set (it is not
 * iterated at all) — its entries are genuinely detached and remain prunable.
 */
export function computeUncomputableNodes(graph: Graph): Set<string> {
  const uncomputable = new Set<string>();
  for (const [nodePath, node] of graph.nodes) {
    try {
      computeEffectiveAspects(node, graph);
      computeEffectiveAspectStatuses(node, graph);
    } catch {
      // Mirror computeExpectedPairs's catch: a node whose effectiveness throws is
      // skipped there, so record it here to protect its entries from GC.
      uncomputable.add(nodePath);
    }
  }
  return uncomputable;
}

// ============================================================
// computeExpectedPairs
// ============================================================

/**
 * Compute the complete expected set of (aspect, unit) pairs for a graph.
 *
 * Algorithm per node:
 *   1. Collect effective aspects (7-channel cascade, when-filtered).
 *   2. Skip aggregates (no reviewer, no verdict).
 *   3. Skip draft unless includeDraft.
 *   4. Expand mapping paths (child carve-out applied).
 *   5. Filter by scope.files predicate (evaluateFileWhen) — absent = all files.
 *      Files where evaluateFileWhen reports unreadable: true are EXCLUDED from
 *      the subject set and recorded in the returned `unreadable` array.
 *   6. For LLM aspects: additionally exclude binaries (by extension).
 *   7. Empty subject set → no pair.
 *   8. per: node → one pair; per: file → one pair per subject file.
 *
 * Output `pairs` is sorted by aspectId, then unitKey for deterministic comparison.
 * Callers MUST surface a non-empty `unreadable` array as a blocking error.
 *
 * Note: files that disappear between mapping expansion (step 4) and scope
 * evaluation (step 5) simply never enter the subject set — mapping expansion
 * is a snapshot and missing paths are silently dropped at that stage. The
 * explicit `unreadable` channel covers only content-filter read failures (EACCES
 * or similar) on files that were successfully enumerated.
 *
 * Nodeless enumeration (`opts.typeCoverage`), run AFTER the node loop above so
 * every component pair stays byte-identical: for each file enforced by its
 * architecture type alone (`typeCoverage.covered`), unless the file sits under a
 * `coverage.excluded` root (the one exclusion authority, `isExcludedByCoverage` —
 * an explicit node mapping is never subject to it, so the node loop above never
 * consults it — this is the ONE step in this loop that stays silent: the file
 * was never really "covered" to begin with, so there is nothing to have a
 * reason about), run `computeTypeAspectCascade` once for the whole file and,
 * for each of its effective aspects: skip aggregates silently (no reviewer, no
 * own verdict — the bundle they belong to is reported separately, never as a
 * bare drop); an id with no matching aspect definition records
 * `aspect-undefined`; skip a whole-unit rule (`scope.per !== 'file'` — there is
 * no component to run it on) recording `whole-unit-rule`; skip a file excluded
 * by the aspect's own `scope.files` recording `scope.files-excluded`; an
 * unreadable scope.files evaluation or unreadable subject records `unreadable`
 * (in addition to routing through the same blocking `unreadable` channel the
 * node loop uses); an LLM aspect over a binary subject records `binary-subject`
 * (a prose rule cannot review bytes it cannot read as text). Every one of these
 * is recorded — this loop never silently decides an (aspect, file) pair will
 * not exist without leaving a reason for it, so a caller can never mistake "no
 * drop was recorded" for "therefore enforced". Every surviving (aspect, file)
 * emits one `file:` pair with `nodePath` omitted. `drops` collects every
 * cascade drop (`when-not-satisfied` / `draft`) PLUS every enumeration-only
 * reason above, each with the file it happened on attached.
 *
 * Before any of that: when `computeTypeAspectCascade` itself absorbed an
 * aspect `implies` cycle for this file (its own `cycle` result), the file
 * contributes NEITHER a pair NOR a drop — its rules were never resolved, so
 * there is nothing to classify one way or the other. That fact is recorded on
 * its own channel, `uncomputableTypeCoverage`, never folded into `drops`: a
 * caller that reads "no pairs, no drops" as "genuinely zero applicable rules"
 * (as `core/type-visibility.ts` used to) must consult this channel first.
 */
export async function computeExpectedPairs(
  graph: Graph,
  opts?: ComputePairsOptions,
): Promise<PairComputation> {
  const includeDraft = opts?.includeDraft ?? false;
  const projectRoot = path.dirname(graph.rootPath);
  const cache = new FileContentCache();

  const pairs: ExpectedPair[] = [];
  const unreadableMap = new Map<string, UnreadableSubject>(); // key: nodePath+aspectId+path
  const readabilityCache = new Map<string, string | null>(); // absPath → unreadable reason | null

  for (const [nodePath, node] of graph.nodes) {
    // Expand the node's mapped files (gitignore-aware, child carve-out applied).
    const rawMapping = normalizeMappingPaths(node.meta.mapping);
    if (rawMapping.length === 0) continue; // no mapping → no pairs for this node

    // O(nodes²) with one FS walk per node — fine at current scale; if check latency grows, precompute a child-exclusion index per run.
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    const allExpanded = await expandMappingPaths(projectRoot, rawMapping);
    const nodeFiles = excludePrefixes.length > 0
      ? allExpanded.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
      : allExpanded;

    if (nodeFiles.length === 0) continue; // after carve-out, nothing left

    // Effective aspects and their statuses for this node.
    let effectiveIds: Set<string>;
    let statuses: Map<string, AspectStatus>;
    try {
      effectiveIds = computeEffectiveAspects(node, graph);
      statuses = computeEffectiveAspectStatuses(node, graph);
    } catch {
      // ImpliesCycleError or similar structural error — skip this node; the
      // validator will catch and report the cycle separately.
      continue;
    }

    for (const aspectId of effectiveIds) {
      // Aggregates never produce a pair (no own reviewer, no own verdict).
      if (isAggregateAspect(graph, aspectId)) continue;

      const effectiveStatus = statuses.get(aspectId) ?? 'enforced';
      if (!includeDraft && effectiveStatus === 'draft') continue;

      const aspectDef = graph.aspects.find((a) => a.id === aspectId);
      if (!aspectDef) continue;

      // isAggregateAspect already guarded above; reviewer.type is 'llm' | 'deterministic' here.
      const kind = aspectDef.reviewer.type as 'llm' | 'deterministic';

      const scope = aspectDef.scope;

      // ── Step 1: scope.files filter (path + content predicate) ──────────
      let scopeFiltered = nodeFiles;
      if (scope?.files) {
        const results = await Promise.all(
          nodeFiles.map((p) =>
            evaluateFileWhen(scope.files!, {
              absPath: path.resolve(projectRoot, p),
              repoRelPath: p,
              projectRoot,
              cache,
            }),
          ),
        );
        // Collect unreadable files so they can be surfaced as blocking errors.
        // A silently dropped file can turn an enforced rule into a vacuous pass.
        for (let i = 0; i < nodeFiles.length; i++) {
          const r = results[i];
          if (r.unreadable) {
            const key = `${nodePath}\0${aspectId}\0${nodeFiles[i]}`;
            if (!unreadableMap.has(key)) {
              const filePath = nodeFiles[i];
              const reason = r.unreadableReason ?? 'unreadable';
              // A too-large file is readable but exceeds the content-scan limit, so
              // "could not read" would be inaccurate — phrase it as a filter that
              // could not be evaluated. An actual read failure (EACCES, vanished)
              // keeps the "could not read" wording.
              const tooLarge = r.unreadableKind === 'too-large';
              const what = tooLarge
                ? `Aspect '${aspectId}' on node '${toPosixPath(nodePath)}' could not evaluate the content filter on subject file '${toPosixPath(filePath)}': ${reason}.`
                : `Aspect '${aspectId}' on node '${toPosixPath(nodePath)}' could not read subject file '${toPosixPath(filePath)}': ${reason}.`;
              const why = tooLarge
                ? 'The scope.files content filter must scan each mapped file to decide whether it is a review subject, but this file exceeds the scan limit, so the filter could not be applied and the file was dropped from the review subject set. A silently dropped file can turn an enforced rule into a vacuous pass.'
                : 'A file the scope.files filter must evaluate could not be read, so it was dropped from the review subject set. A silently dropped file can turn an enforced rule into a vacuous pass.';
              const next = tooLarge
                ? `Split '${toPosixPath(filePath)}' below the 5MB scan limit, narrow the content filter so it no longer needs to scan this file, or remove it from the node mapping, then re-run yg check.`
                : `Fix the file permissions or remove '${toPosixPath(filePath)}' from the node mapping, then re-run yg check.`;
              unreadableMap.set(key, {
                nodePath,
                aspectId,
                path: filePath,
                reason,
                messageData: { what, why, next },
              });
            }
          }
        }
        scopeFiltered = nodeFiles.filter((_, i) => results[i].result);
      }

      // ── Step 2: LLM aspects additionally exclude binary files ───────────
      let subjectFiles = scopeFiltered;
      if (kind === 'llm') {
        subjectFiles = scopeFiltered.filter(
          (p) => !BINARY_EXTENSIONS.has(path.extname(p).toLowerCase()),
        );
      }

      // ── Step 2.5: an unreadable subject file blocks (file-unreadable) ────
      // A file written into the mapping MUST be readable. Records each
      // unreadable subject in `unreadable[]` (surfaced as a blocking error) and
      // drops it from the subject set, so a deterministic check can never run
      // over a silently-shrunk subject and pass vacuously, and the LLM subject
      // never excludes a file the reviewer was meant to see. This covers ALL
      // aspects; the scope.files branch above already excluded+recorded files
      // whose content predicate could not read them, so they never reach here.
      const readableSubjects: string[] = [];
      for (const filePath of subjectFiles) {
        const absPath = path.resolve(projectRoot, filePath);
        let reason = readabilityCache.get(absPath);
        if (reason === undefined) {
          reason = await probeUnreadable(absPath);
          readabilityCache.set(absPath, reason);
        }
        if (reason === null) {
          readableSubjects.push(filePath);
          continue;
        }
        const key = `${nodePath}\0${aspectId}\0${filePath}`;
        if (!unreadableMap.has(key)) {
          unreadableMap.set(key, {
            nodePath,
            aspectId,
            path: filePath,
            reason,
            messageData: {
              what: `Aspect '${aspectId}' on node '${toPosixPath(nodePath)}' could not read subject file '${toPosixPath(filePath)}': ${reason}.`,
              why: 'A file written into the node mapping could not be read, so it cannot be reviewed. A silently dropped subject can turn an enforced rule into a vacuous pass (zero subject = no real review = implicit green).',
              next: `Fix the file permissions or remove '${toPosixPath(filePath)}' from the node mapping, then re-run yg check.`,
            },
          });
        }
      }
      subjectFiles = readableSubjects;

      // Empty subject set → vacuous pass, no pair.
      if (subjectFiles.length === 0) continue;

      const sortedSubjects = [...subjectFiles].sort();

      // ── Step 3: per: node (or absent scope) → one pair ─────────────────
      const per = scope?.per ?? 'node';
      if (per === 'node') {
        pairs.push({
          aspectId,
          kind,
          unitKey: nodeUnit(nodePath),
          nodePath,
          status: effectiveStatus,
          subjectFiles: sortedSubjects,
        });
      } else {
        // per: file → one pair per subject file
        for (const filePath of sortedSubjects) {
          pairs.push({
            aspectId,
            kind,
            unitKey: fileUnit(filePath),
            nodePath,
            status: effectiveStatus,
            subjectFiles: [filePath],
          });
        }
      }
    }
  }

  // ── Nodeless enumeration: files enforced by their architecture type alone. ──
  // Added AFTER the node loop so every component pair above is byte-identical;
  // absent opts.typeCoverage ⇒ this loop does not run at all (zero added cost,
  // zero behavior change — the feature-off contract).
  const drops: PairDrop[] = [];
  const uncomputableTypeCoverage: UncomputableTypeCoverage[] = [];
  const coverageConfig = graph.config.coverage ?? DEFAULT_COVERAGE;
  for (const [file, typeId] of opts?.typeCoverage?.covered ?? []) {
    // The one exclusion authority (isExcludedByCoverage) — a file under an
    // excluded root is skipped entirely, not even classified into a drop. This
    // is the SAME authority computeTypeCoverage itself already applied to reach
    // `covered` in the first place, so this is a defensive re-check, not a new
    // filter — but the node loop above never consults it (an explicit mapping is
    // a stronger statement of intent than an exclusion, per Step 3's guard).
    if (isExcludedByCoverage(file, coverageConfig)) continue;

    let cascade: { effective: TypeEffectiveAspect[]; drops: TypeAspectDrop[]; cycle?: TypeCascadeCycle };
    try {
      cascade = computeTypeAspectCascade(graph, file, typeId, opts?.typeCoverage?.edges);
    } catch {
      // Mirrors the node loop's own catch above: an unexpected structural error
      // must not abort enumeration for every OTHER type-covered file in the run.
      // (computeTypeAspectCascade's own contract already absorbs an implies
      // cycle internally — see the branch below — so this guards the boundary
      // against some OTHER, genuinely unexpected failure, not a known one.)
      continue;
    }
    if (cascade.cycle) {
      // The cascade absorbed an implies cycle instead of resolving this
      // file's rules — record it on its OWN channel, never as a drop or a
      // silent skip. A drop means "this specific rule does not run here"; an
      // implies cycle means "nothing about this file's type could be
      // resolved at all". Conflating the two is exactly what used to make
      // this file read as "zero applicable rules" (genuinely nothing
      // attached) when its rules were simply never worked out.
      uncomputableTypeCoverage.push({ file, typeId, cycle: cascade.cycle });
      continue;
    }
    for (const d of cascade.drops) drops.push({ file, ...d });

    for (const { aspectId, status } of cascade.effective) {
      // Aggregates never produce a pair (no own reviewer, no own verdict) —
      // silent, exactly like the node loop's own aggregate skip.
      if (isAggregateAspect(graph, aspectId)) continue;
      if (!includeDraft && status === 'draft') continue; // recorded via cascade.drops above

      const aspectDef = graph.aspects.find((a) => a.id === aspectId);
      if (!aspectDef) {
        // The architecture attaches an id with no matching aspect definition —
        // a graph a real loader rejects (checkDanglingAspectRefs), reachable
        // only via a hand-built Graph that bypasses that validation. Still
        // recorded: a caller deriving "enforced" from the absence of a drop
        // must never read this gap as enforcement.
        drops.push({ file, aspectId, reason: 'aspect-undefined' });
        continue;
      }
      const kind = aspectDef.reviewer.type as 'llm' | 'deterministic';
      const scope = aspectDef.scope;

      // A whole-unit (per: node, or absent scope) rule has no component to run
      // on for a nodeless file — there is no "whole unit" here.
      const per = scope?.per ?? 'node';
      if (per !== 'file') {
        drops.push({ file, aspectId, reason: 'whole-unit-rule' });
        continue;
      }

      // scope.files content/path predicate, evaluated over this one file.
      if (scope?.files) {
        const result = await evaluateFileWhen(scope.files, {
          absPath: path.resolve(projectRoot, file),
          repoRelPath: file,
          projectRoot,
          cache,
        });
        if (result.unreadable) {
          const key = `\0${aspectId}\0${file}`;
          if (!unreadableMap.has(key)) {
            const reason = result.unreadableReason ?? 'unreadable';
            const tooLarge = result.unreadableKind === 'too-large';
            const what = tooLarge
              ? `Aspect '${aspectId}' could not evaluate the content filter on its subject file '${toPosixPath(file)}': ${reason}.`
              : `Aspect '${aspectId}' could not read its subject file '${toPosixPath(file)}': ${reason}.`;
            const why = tooLarge
              ? 'The scope.files content filter must scan the file to decide whether it is a review subject, but this file exceeds the scan limit, so the filter could not be applied and the file was dropped from the review subject set. A silently dropped file can turn an enforced rule into a vacuous pass.'
              : 'A file the scope.files filter must evaluate could not be read, so it was dropped from the review subject set. A silently dropped file can turn an enforced rule into a vacuous pass.';
            const next = tooLarge
              ? `Split '${toPosixPath(file)}' below the 5MB scan limit, narrow the content filter so it no longer needs to scan this file, or add its root to coverage.excluded, then re-run yg check.`
              : `Fix the file permissions, or add its root to coverage.excluded, then re-run yg check.`;
            unreadableMap.set(key, { aspectId, path: file, reason, messageData: { what, why, next } });
          }
          // Recorded on both channels: `unreadable` for the blocking error, AND
          // a drop row here — the aspect still does not enforce on this file,
          // and a caller deriving "enforced" from the absence of a drop must
          // never read this gap (unreadable is not "attach condition satisfied").
          drops.push({ file, aspectId, reason: 'unreadable' });
          continue;
        }
        if (!result.result) {
          drops.push({ file, aspectId, reason: 'scope.files-excluded' });
          continue;
        }
      }

      // LLM aspects never review a binary — a prose rule cannot review bytes
      // it cannot read as text. Recorded (never silent, unlike the node loop's
      // own binary exclusion): a type-covered file has no owning component to
      // fall back on, so this is the only place this fact is ever surfaced.
      if (kind === 'llm' && BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        drops.push({ file, aspectId, reason: 'binary-subject' });
        continue;
      }

      // Final unreadable probe — a file written into typeCoverage.covered MUST be
      // readable to be reviewed (mirrors the node loop's own step 2.5).
      const absPath = path.resolve(projectRoot, file);
      let reason = readabilityCache.get(absPath);
      if (reason === undefined) {
        reason = await probeUnreadable(absPath);
        readabilityCache.set(absPath, reason);
      }
      if (reason !== null) {
        const key = `\0${aspectId}\0${file}`;
        if (!unreadableMap.has(key)) {
          unreadableMap.set(key, {
            aspectId,
            path: file,
            reason,
            messageData: {
              what: `Aspect '${aspectId}' could not read its subject file '${toPosixPath(file)}': ${reason}.`,
              why: 'A file this aspect must review could not be read, so it cannot be reviewed. A silently dropped subject can turn an enforced rule into a vacuous pass (zero subject = no real review = implicit green).',
              next: `Fix the file permissions, or add its root to coverage.excluded, then re-run yg check.`,
            },
          });
        }
        drops.push({ file, aspectId, reason: 'unreadable' });
        continue;
      }

      pairs.push({
        aspectId,
        kind,
        unitKey: fileUnit(file),
        status,
        subjectFiles: [file],
      });
    }
  }

  // Deterministic output ordering: aspectId first, then unitKey.
  pairs.sort((a, b) => {
    if (a.aspectId < b.aspectId) return -1;
    if (a.aspectId > b.aspectId) return 1;
    if (a.unitKey < b.unitKey) return -1;
    if (a.unitKey > b.unitKey) return 1;
    return 0;
  });

  return { pairs, unreadable: Array.from(unreadableMap.values()), drops, uncomputableTypeCoverage };
}

// ============================================================
// computeSourceFingerprint
// ============================================================

/**
 * Compute the per-node source fingerprint.
 *
 * Algorithm:
 *   1. Expand all mapped files (child carve-out applied).
 *   2. Hash every file (binaries included — hashFile reads raw bytes).
 *   3. Build sorted 'path:hash' lines and fold with sha256.
 *   4. Return undefined if the node maps nothing.
 *
 * Fingerprint format (local-state contract, documented here for stability):
 *   sha256(join('\n', sorted(['<repoRelPosix>:<sha256hex>', ...])))
 *
 * This is INDEPENDENT of scope filters — the fingerprint covers the full
 * mapping and is used to detect source drift, not to reproduce subject sets.
 * Binary files are included by their raw bytes (not their extension).
 *
 * Unreadable mapped file: a file that cannot be read (EACCES, vanished
 * mid-run, …) throws FileUnreadableError rather than producing a partial
 * fingerprint. A file written into the mapping MUST be readable; the
 * fingerprint is undefined, not silently computed over the readable subset.
 * Fill-side callers catch this and decline to advance the node's fingerprint /
 * log baseline — the node is already a blocking file-unreadable error via
 * computeExpectedPairs, so this only prevents a stale-green closure, never
 * adds a new failure.
 */
export async function computeSourceFingerprint(
  graph: Graph,
  nodePath: string,
): Promise<string | undefined> {
  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;

  const rawMapping = normalizeMappingPaths(node.meta.mapping);
  if (rawMapping.length === 0) return undefined;

  const projectRoot = path.dirname(graph.rootPath);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  const allExpanded = await expandMappingPaths(projectRoot, rawMapping);
  const nodeFiles = excludePrefixes.length > 0
    ? allExpanded.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
    : allExpanded;

  if (nodeFiles.length === 0) return undefined;

  // Hash all files (binaries included by bytes). An unreadable mapped file
  // throws FileUnreadableError — the fingerprint is undefined, never a partial
  // fold over the readable subset (a file in the mapping must be readable).
  const pairs = await Promise.all(
    nodeFiles.map(async (p) => {
      const absPath = path.resolve(projectRoot, p);
      const reason = await probeUnreadable(absPath);
      if (reason !== null) throw new FileUnreadableError(nodePath, toPosixPath(p), reason);
      const hash = await hashFile(absPath);
      return `${p}:${hash}`;
    }),
  );

  // Sort and fold into a single sha256.
  // Format: sorted 'repoRelPosixPath:sha256hex' lines joined by '\n', folded with sha256.
  const digest = pairs.sort().join('\n');
  return hashString(digest);
}
