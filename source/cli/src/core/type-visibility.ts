/**
 * source/cli/src/core/type-visibility.ts
 *
 * Honesty artifact for the type-level coverage tier: for every file enforced
 * by its architecture type alone, records not just what a rule attached to
 * that type ENFORCES on it, but every rule that is attached and does NOT —
 * with the reason. Assembled from two producers, never a third:
 *   - `staticDrops` (`PairComputation.drops`, core/pairs.ts) — the reasons
 *     decided while working out which rules apply: a whole-unit rule with no
 *     component to run on, a file excluded by the rule's own `scope.files`,
 *     the cascade's own `when-not-satisfied` / `draft`.
 *   - `runtimeRows` — the reasons only running the rule can decide (a
 *     deterministic check reading beyond the architecture's allowance,
 *     touching ctx.node/ctx.graph with no component behind it, or — from a
 *     later task — a companion that could not resolve a dependency).
 *
 * This module builds NO reason of its own: it groups, counts, and renders
 * what the two producers already decided. The one thing it DOES compute
 * itself is which of a type's declared law is enforced ANYWHERE (a plain
 * structural "not dropped everywhere" derivation over the SAME drop rows),
 * and where the type's implicit parent chain stops — both pure graph facts,
 * no file I/O, independent of whether a relation-edge index is available.
 */
import type { Graph } from '../model/graph.js';
import type { PairDrop } from './pairs.js';
import type { TypeAspectDropReason } from './type-effective.js';
import { walkTypeParentChain, computeDeclaredAttachedAspects } from './type-effective.js';
import type { ChainTermination } from './type-effective.js';
import { isAggregateAspect } from './graph/aspects.js';

/**
 * Plain-language sentence for where a type's inherited chain stops and why —
 * shared verbatim between `yg check`'s per-type block and `yg context --file`
 * so the wording never drifts between the two surfaces.
 */
export function describeChainTermination(t: ChainTermination): string {
  const reasonPhrase: Record<ChainTermination['reason'], string> = {
    fork: `a fork (${t.candidates.join(' | ')})`,
    cycle: `a cycle back to '${t.candidates[0]}'`,
    'no-parents': `'${t.candidates[0]}' — no parents declared`,
    'empty-parents': `'${t.candidates[0]}' — an explicit empty parents list`,
  };
  return `inherited rules stop at ${reasonPhrase[t.reason]}`;
}

/**
 * Every reason a rule attached to a file's type does not enforce on it: the
 * static reasons decided while enumerating which rules apply (reused
 * verbatim from `PairDropReason` — never restated, so a reason added
 * downstream cannot drift from its name there), widened by the ones only
 * running the rule can decide.
 *
 * The runtime reasons are a semantic layer over the structure runner's own
 * typed dispositions, not the raw codes themselves: 'read-beyond-architecture'
 * for a `StructureRunnerError` coded `STRUCTURE_UNDECLARED_FS_READ`,
 * 'node-context-required' for one coded `STRUCTURE_NODE_CONTEXT_UNAVAILABLE`.
 * 'companion-context-failed' has no producer yet — a later task's companion
 * failure feeds it; until then no caller ever constructs a row with it.
 */
export type TypeVisibilityReason =
  | TypeAspectDropReason         // 'when-not-satisfied' | 'draft'
  | 'whole-unit-rule'
  | 'scope.files-excluded'
  | 'read-beyond-architecture'
  | 'node-context-required'
  | 'companion-context-failed';

export interface TypeVisibilityRow {
  file: string;
  aspectId: string;
  reason: TypeVisibilityReason;
}

export interface TypeVisibilityReport {
  /** One block per matched type, ordered by type id (code-point). */
  byType: Array<{
    typeId: string;
    /** Covered files matched to this type, sorted. */
    files: string[];
    /** Aspect ids enforced on AT LEAST ONE file of this type. */
    enforced: string[];
    /** Same aspect ids as `enforced`, each with the file count it actually runs on — a rule live on one accidental file reads as a count of 1, never just a bare name. */
    enforcedCounts: Array<{ aspectId: string; count: number }>;
    /** Aspect ids attached to this type that do not enforce on some or all of its files, with the reason and a file count. */
    dropped: Array<{ aspectId: string; reason: TypeVisibilityReason; count: number }>;
    /** Named when a bundle's file-level half applies and its whole-unit half cannot. */
    halfExpandedBundles: Array<{ bundleId: string; enforced: string[]; dropped: string[] }>;
    /** Where the inherited chain stops, and why. */
    chainTermination: ChainTermination;
  }>;
  /** Files with a matched type and no applicable rule at all. */
  zeroEnforcement: { count: number; samples: string[] };
  /** Every (file, aspectId, reason) row, static and runtime, sorted code-point stable. */
  rows: TypeVisibilityRow[];
}

/** Matches the rest of `yg check`'s own sample/member truncation (CAP_NODES). Counts are never capped — only the sample list. */
const SAMPLE_CAP = 12;

function compareRows(a: TypeVisibilityRow, b: TypeVisibilityRow): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.aspectId !== b.aspectId) return a.aspectId < b.aspectId ? -1 : 1;
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  return 0;
}

/**
 * Structure-runner disposition codes this module knows how to translate into
 * a `TypeVisibilityReason`. Absent from this map (including a future
 * companion-hook code) ⇒ undefined — callers construct a row with a reason
 * they already know, never invent one from a code this map does not list.
 */
const RUNTIME_DISPOSITION_REASONS: ReadonlyMap<string, TypeVisibilityReason> = new Map<string, TypeVisibilityReason>([
  ['STRUCTURE_UNDECLARED_FS_READ', 'read-beyond-architecture'],
  ['STRUCTURE_NODE_CONTEXT_UNAVAILABLE', 'node-context-required'],
]);

/**
 * Translate a `StructureRunnerError.code` into its `TypeVisibilityReason`, or
 * undefined for a code this artifact does not represent (e.g. a genuine
 * check.mjs bug — `STRUCTURE_CHECK_THROWN` — is a violation/runtime-error
 * disposition, never an attached-but-not-enforced row). A Map, not a plain
 * object literal: a dynamic `code` naming a reserved key (`constructor`,
 * `toString`, `__proto__`, ...) can never resolve to an inherited value.
 */
export function classifyRunnerDisposition(code: string): TypeVisibilityReason | undefined {
  return RUNTIME_DISPOSITION_REASONS.get(code);
}

export function buildTypeVisibility(
  graph: Graph,
  covered: Map<string, string>,
  staticDrops: PairDrop[],
  runtimeRows: TypeVisibilityRow[],
): TypeVisibilityReport {
  const filesByType = new Map<string, string[]>();
  for (const [file, typeId] of covered) {
    const arr = filesByType.get(typeId);
    if (arr) arr.push(file);
    else filesByType.set(typeId, [file]);
  }
  for (const arr of filesByType.values()) arr.sort();

  const rows: TypeVisibilityRow[] = [
    ...staticDrops.map((d): TypeVisibilityRow => ({ file: d.file, aspectId: d.aspectId, reason: d.reason })),
    ...runtimeRows,
  ].sort(compareRows);

  // file -> set of aspect ids dropped for ANY reason (used to derive "enforced").
  const droppedAspectsByFile = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = droppedAspectsByFile.get(r.file);
    if (s) s.add(r.aspectId);
    else droppedAspectsByFile.set(r.file, new Set([r.aspectId]));
  }

  const byType: TypeVisibilityReport['byType'] = [];
  const zeroEnforcementFiles: string[] = [];

  for (const typeId of [...filesByType.keys()].sort()) {
    const files = filesByType.get(typeId)!;
    const fileSet = new Set(files);
    const { chainTypeIds, termination } = walkTypeParentChain(graph, typeId);
    const declaredAttached = computeDeclaredAttachedAspects(graph, typeId, chainTypeIds);

    // Per-aspect enforced-on-N-files tally (K2 mitigation): a rule live on only
    // one accidental file must be visible as a count of 1, not just a bare name.
    const enforcedSet = new Set<string>();
    const enforcedFileCounts = new Map<string, number>();
    for (const file of files) {
      const droppedHere = droppedAspectsByFile.get(file);
      let fileEnforced = false;
      for (const aspectId of declaredAttached) {
        if (isAggregateAspect(graph, aspectId)) continue;
        if (!droppedHere?.has(aspectId)) {
          enforcedSet.add(aspectId);
          enforcedFileCounts.set(aspectId, (enforcedFileCounts.get(aspectId) ?? 0) + 1);
          fileEnforced = true;
        }
      }
      if (!fileEnforced) zeroEnforcementFiles.push(file);
    }

    // Dropped counts, grouped by (aspectId, reason), scoped to this type's files.
    const counts = new Map<string, { aspectId: string; reason: TypeVisibilityReason; count: number }>();
    for (const r of rows) {
      if (!fileSet.has(r.file)) continue;
      const key = `${r.aspectId}\0${r.reason}`;
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { aspectId: r.aspectId, reason: r.reason, count: 1 });
    }
    const dropped = [...counts.values()].sort((a, b) =>
      a.aspectId !== b.aspectId ? (a.aspectId < b.aspectId ? -1 : 1) : (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
    );
    const wholeUnitDropped = new Set(dropped.filter((d) => d.reason === 'whole-unit-rule').map((d) => d.aspectId));

    const halfExpandedBundles: Array<{ bundleId: string; enforced: string[]; dropped: string[] }> = [];
    for (const aspect of graph.aspects) {
      if (aspect.reviewer.type !== 'aggregate') continue;
      const implies = aspect.implies ?? [];
      const enforcedMembers = implies.filter((id) => enforcedSet.has(id));
      const droppedMembers = implies.filter((id) => wholeUnitDropped.has(id));
      if (enforcedMembers.length > 0 && droppedMembers.length > 0) {
        halfExpandedBundles.push({ bundleId: aspect.id, enforced: enforcedMembers, dropped: droppedMembers });
      }
    }
    halfExpandedBundles.sort((a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));

    const enforced = [...enforcedSet].sort();
    byType.push({
      typeId,
      files,
      enforced,
      enforcedCounts: enforced.map((aspectId) => ({ aspectId, count: enforcedFileCounts.get(aspectId) ?? 0 })),
      dropped,
      halfExpandedBundles,
      chainTermination: termination,
    });
  }

  zeroEnforcementFiles.sort();
  const zeroEnforcement = { count: zeroEnforcementFiles.length, samples: zeroEnforcementFiles.slice(0, SAMPLE_CAP) };

  return { byType, zeroEnforcement, rows };
}

/** Short, plain-language phrase for a reason — shared by every render surface so the vocabulary never drifts between them. */
export function describeTypeVisibilityReason(reason: TypeVisibilityReason): string {
  switch (reason) {
    case 'when-not-satisfied': return 'its attach condition (when:) was not satisfied on this file';
    case 'draft': return 'the rule is still draft (reviewer skipped)';
    case 'whole-unit-rule': return 'it is whole-unit (per: node) and this file has no component to run it on';
    case 'scope.files-excluded': return "excluded by the rule's own scope.files filter";
    case 'read-beyond-architecture': return "it tried to read a file outside what the architecture allows this file's type to depend on";
    case 'node-context-required': return 'it needs component context (ctx.node / ctx.graph) that a type-covered file does not have';
    case 'companion-context-failed': return 'its companion could not resolve a dependency for this file';
  }
}
