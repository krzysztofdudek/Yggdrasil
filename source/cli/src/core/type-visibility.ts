/**
 * source/cli/src/core/type-visibility.ts
 *
 * Honesty artifact for the type-level coverage tier: for every file enforced
 * by its architecture type alone, records not just what a rule attached to
 * that type ENFORCES on it, but every rule that is attached and does NOT —
 * with the reason. Assembled from four producers, never a fifth:
 *   - `staticDrops` (`PairComputation.drops`, core/pairs.ts) — the reasons
 *     decided while working out which rules apply: a whole-unit rule with no
 *     component to run on, a file excluded by the rule's own `scope.files`,
 *     an unreadable subject, an LLM rule over a binary subject, an id with no
 *     matching aspect definition, or the cascade's own `when-not-satisfied` /
 *     `draft`.
 *   - `runtimeRows` — the reasons only running the rule can decide (a
 *     deterministic check reading beyond the architecture's allowance,
 *     touching ctx.node/ctx.graph with no component behind it, or a
 *     companion that could not resolve a dependency — this third reason has
 *     no `StructureRunnerError` code wired to it yet, see the note below
 *     `RUNTIME_DISPOSITION_REASONS`). These three are FILL-ONLY: neither `yg
 *     check` nor `yg context --file` ever re-executes check.mjs (see the
 *     module-level note below `RUNTIME_DISPOSITION_REASONS`), so
 *     `runtimeRows` is `[]` at both call sites today — never fabricated to
 *     look populated.
 *   - `appliedPairs` — the (file, aspectId, status) rows that ACTUALLY
 *     produced a pair (`core/pairs.ts`'s own nodeless enumeration output,
 *     filtered to `nodePath === undefined`). This is the ONLY source of truth
 *     for "enforced" / "advisory": it is never inferred from the absence of a
 *     drop row. A silent gap in the enumeration that forgets to record a drop
 *     must never be read back as "therefore enforced" — that inference is
 *     exactly the failure mode this artifact exists to rule out, so it is not
 *     reintroduced here as a shortcut.
 *   - `uncomputable` (`PairComputation.uncomputableTypeCoverage`, core/pairs.ts)
 *     — files whose type's rules were never resolved at all: the nodeless
 *     enumeration's cascade call absorbed an aspect `implies` cycle for them,
 *     so they contribute NEITHER a static drop NOR an applied pair. A file
 *     with no drop and no applied pair is otherwise indistinguishable from one
 *     whose type genuinely attaches nothing — this producer is what keeps the
 *     two apart: `byType[].uncomputable` / the top-level `uncomputable` report
 *     one, both excluded from `zeroEnforcement`, so "resolution never ran" is
 *     never rendered as "resolution ran and found nothing".
 *
 * This module builds NO reason of its own: it groups, counts, and shapes what
 * the producers already decided (the render layer, `check-render-header.ts`,
 * turns a cascade-cycle group's `aspectId` into the same `why` sentence
 * `yg owner --file` / `yg context --file` already print, via
 * `type-effective.ts#describeCascadeCycle` — never restated here, so the
 * wording cannot drift between the three surfaces). The two things this
 * module DOES compute itself are which of a type's declared law is enforced
 * ANYWHERE (a plain group-by over `appliedPairs`) and where the type's
 * implicit parent chain stops — both pure graph facts, no file I/O,
 * independent of whether a relation-edge index is available.
 */
import type { Graph } from '../model/graph.js';
import type { AspectStatus } from '../model/graph.js';
import type { PairDrop, ExpectedPair, UncomputableTypeCoverage } from './pairs.js';
import type { TypeAspectDropReason } from './type-effective.js';
import { walkTypeParentChain } from './type-effective.js';
import type { ChainTermination } from './type-effective.js';

/**
 * Plain-language sentence for where a type's inherited chain stops and why —
 * shared verbatim between `yg check`'s per-type block and `yg context --file`
 * so the wording never drifts between the two surfaces.
 *
 * 'no-parents' phrasing deliberately does NOT claim whether the type omitted
 * `parents:` or wrote an explicit `parents: []`: the graph loader normalizes
 * both to the identical absent-parents state before either ever reaches this
 * function (`architecture-parser.ts` turns a YAML `parents: []` into
 * `undefined` at load time), so a real, loaded graph can never tell the two
 * apart here. Claiming "no parents declared" would be false for an author who
 * wrote the explicit empty list; this phrasing is true either way.
 * 'empty-parents' keeps its own distinct, accurate text — reachable only via
 * a hand-built Graph that bypasses the parser (never a real loaded project;
 * see type-effective.test.ts) — so it is not merged into 'no-parents'.
 */
export function describeChainTermination(t: ChainTermination): string {
  const reasonPhrase: Record<ChainTermination['reason'], string> = {
    fork: `a fork (${t.candidates.join(' | ')})`,
    cycle: `a cycle back to '${t.candidates[0]}'`,
    'no-parents': `'${t.candidates[0]}' — it has no parent type to inherit from`,
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
 * 'companion-context-failed' has no producer yet: no `StructureRunnerError`
 * code maps to it in `RUNTIME_DISPOSITION_REASONS` below, so no caller ever
 * constructs a row with it.
 *
 * All three runtime reasons are FILL-ONLY today: `yg check` and `yg context
 * --file` both compute this report with `runtimeRows: []` (see `check.ts` and
 * `build-context.ts`) because neither ever re-executes a deterministic
 * check.mjs — only `yg check --approve`'s fill stage does, and nothing
 * persists a runtime disposition's code across runs for either shipped
 * surface to read back. `describeTypeVisibilityReason` still describes them
 * (a caller that DOES observe one live, during a fill, must have real
 * wording ready), but do not expect to see them in rendered `yg check` or `yg
 * context --file` output — that would require wiring a same-process
 * fill→check handoff, which is a distinct, larger change.
 */
export type TypeVisibilityReason =
  | TypeAspectDropReason         // 'when-not-satisfied' | 'draft'
  | 'whole-unit-rule'
  | 'scope.files-excluded'
  | 'aspect-undefined'
  | 'unreadable'
  | 'binary-subject'
  | 'read-beyond-architecture'
  | 'node-context-required'
  | 'companion-context-failed';

export interface TypeVisibilityRow {
  file: string;
  aspectId: string;
  reason: TypeVisibilityReason;
}

/**
 * One (file, aspectId) pair that ACTUALLY produced a pair — `core/pairs.ts`'s
 * nodeless enumeration output, narrowed to the fields this artifact needs.
 * The one and only input `buildTypeVisibility` treats as ground truth for
 * "enforced" / "advisory"; never derived from anything else.
 */
export interface TypeVisibilityAppliedPair {
  file: string;
  aspectId: string;
  status: AspectStatus;
}

/** Narrows a pairs array (component + nodeless) to the nodeless rows this artifact treats as ground truth. */
export function toAppliedPairs(pairs: ExpectedPair[]): TypeVisibilityAppliedPair[] {
  return pairs
    .filter((p) => p.nodePath === undefined)
    .map((p) => ({ file: p.subjectFiles[0], aspectId: p.aspectId, status: p.status }));
}

/**
 * Files whose rules could not be worked out at all, grouped by the cascade
 * cycle's aspect id (files sharing the SAME cycle) — the same shape `dropped`
 * groups by reason, applied to a distinct kind of fact: a `dropped` row means
 * "this rule does not run here"; a group here means "this type's rules were
 * never resolved for these files". `files` is sorted; a group with an
 * `undefined` aspectId is the rare iteration-bound-exceeded variant of
 * `TypeCascadeCycle` (no specific aspect to name).
 */
export interface TypeVisibilityUncomputableGroup {
  aspectId: string | undefined;
  files: string[];
}

export interface TypeVisibilityReport {
  /** One block per matched type, ordered by type id (code-point). */
  byType: Array<{
    typeId: string;
    /** Covered files matched to this type, sorted. */
    files: string[];
    /** Aspect ids whose effective status is 'enforced' on AT LEAST ONE file of this type — a real pair exists; never inferred from the absence of a drop. */
    enforced: string[];
    /** Same aspect ids as `enforced`, each with the file count it actually runs on — a rule live on one accidental file reads as a count of 1, never just a bare name. */
    enforcedCounts: Array<{ aspectId: string; count: number }>;
    /** Aspect ids whose effective status is 'advisory' on AT LEAST ONE file of this type — it runs (a real pair exists) but never blocks. Kept separate from `enforced`/`enforcedCounts`: a rule that only warns must never be reported under a heading that claims enforcement. */
    advisory: string[];
    /** Same aspect ids as `advisory`, each with its file count. */
    advisoryCounts: Array<{ aspectId: string; count: number }>;
    /** Aspect ids attached to this type that do not enforce on some or all of its files, with the reason and a file count. */
    dropped: Array<{ aspectId: string; reason: TypeVisibilityReason; count: number }>;
    /** Named when a bundle's file-level half applies (enforced OR advisory) and its whole-unit half cannot. */
    halfExpandedBundles: Array<{ bundleId: string; enforced: string[]; dropped: string[] }>;
    /** This type's own files an aspect `implies` cycle stopped from being resolved at all — see `TypeVisibilityUncomputableGroup`'s own doc. Disjoint from `files` used for `enforced`/`advisory`/`dropped`/`zeroEnforcement`: a file here contributes to NONE of those, since its rules were never worked out. */
    uncomputable: TypeVisibilityUncomputableGroup[];
    /** Where the inherited chain stops, and why. */
    chainTermination: ChainTermination;
  }>;
  /** Files with a matched type and no applicable rule at all (zero pairs, any status) — NEVER includes a file counted under `uncomputable` below: "resolution ran and found nothing" and "resolution never ran" are mutually exclusive outcomes for the same file. */
  zeroEnforcement: { count: number; samples: string[] };
  /** Every type-covered file (any type) an aspect `implies` cycle stopped from being resolved at all, grouped the same way each `byType[].uncomputable` is — see `TypeVisibilityUncomputableGroup`'s own doc. `count` is the total file count across every group, never capped (matches `zeroEnforcement.count`'s own contract; only the per-group `files` list is subject to the renderer's own display cap). */
  uncomputable: { count: number; groups: TypeVisibilityUncomputableGroup[] };
  /** Every (file, aspectId, reason) drop row, static and runtime, sorted code-point stable. */
  rows: TypeVisibilityRow[];
}

/** Matches the rest of `yg check`'s own sample/member truncation (CAP_NODES). Counts are never capped — only the sample list. */
const SAMPLE_CAP = 12;

/**
 * Code-point order, never locale: this list is RENDERED verbatim (`yg check`,
 * `yg context --file`), so its ordering must be identical on every platform
 * and locale — `.localeCompare()` (or any Intl collation) would make the
 * order depend on the runtime's configured locale, which is neither stable
 * across environments nor deterministic in the way a rendered artifact
 * requires.
 */
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

/**
 * Group uncomputable entries by their cascade cycle's aspect id (files
 * sharing the SAME cycle) — the same shape `dropped` groups by reason. `[]`
 * in ⇒ `[]` out, so a type/report with no uncomputable files renders no
 * group at all (never a stray empty-group line).
 */
function groupUncomputable(entries: UncomputableTypeCoverage[]): TypeVisibilityUncomputableGroup[] {
  const byAspect = new Map<string, string[]>(); // key: aspectId, or '' for the undefined (iteration-bound-exceeded) variant
  for (const e of entries) {
    const key = e.cycle.aspectId ?? '';
    const arr = byAspect.get(key);
    if (arr) arr.push(e.file);
    else byAspect.set(key, [e.file]);
  }
  return [...byAspect.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, files]) => ({ aspectId: key === '' ? undefined : key, files: [...files].sort() }));
}

export function buildTypeVisibility(
  graph: Graph,
  covered: Map<string, string>,
  staticDrops: PairDrop[],
  runtimeRows: TypeVisibilityRow[],
  appliedPairs: TypeVisibilityAppliedPair[],
  uncomputable: UncomputableTypeCoverage[] = [],
): TypeVisibilityReport {
  const uncomputableFiles = new Set(uncomputable.map((u) => u.file));
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

  // file -> aspectId -> status, for every (file, aspectId) that ACTUALLY
  // produced a pair. The one and only source of truth for "enforced" /
  // "advisory" — see the module doc-comment.
  const statusByFile = new Map<string, Map<string, AspectStatus>>();
  for (const p of appliedPairs) {
    let m = statusByFile.get(p.file);
    if (!m) {
      m = new Map();
      statusByFile.set(p.file, m);
    }
    m.set(p.aspectId, p.status);
  }

  const byType: TypeVisibilityReport['byType'] = [];
  const zeroEnforcementFiles: string[] = [];

  for (const typeId of [...filesByType.keys()].sort()) {
    const files = filesByType.get(typeId)!;
    const fileSet = new Set(files);
    const { termination } = walkTypeParentChain(graph, typeId);

    const enforcedSet = new Set<string>();
    const enforcedFileCounts = new Map<string, number>();
    const advisorySet = new Set<string>();
    const advisoryFileCounts = new Map<string, number>();

    for (const file of files) {
      // Rules never resolved for this file (an absorbed implies cycle) — it
      // is neither enforced/advisory/dropped NOR zero-enforcement (both of
      // those mean resolution RAN); it is reported via `uncomputable` below
      // instead, on its own honest channel.
      if (uncomputableFiles.has(file)) continue;
      const statuses = statusByFile.get(file);
      if (!statuses || statuses.size === 0) {
        zeroEnforcementFiles.push(file);
        continue;
      }
      for (const [aspectId, status] of statuses) {
        if (status === 'enforced') {
          enforcedSet.add(aspectId);
          enforcedFileCounts.set(aspectId, (enforcedFileCounts.get(aspectId) ?? 0) + 1);
        } else if (status === 'advisory') {
          advisorySet.add(aspectId);
          advisoryFileCounts.set(aspectId, (advisoryFileCounts.get(aspectId) ?? 0) + 1);
        }
        // 'draft' never reaches here: computeExpectedPairs excludes draft
        // pairs by default, and both shipped callers never pass includeDraft.
      }
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

    // "Applies" for bundle-half-expansion purposes: ANY status that produced a
    // real pair (enforced or advisory) counts as the file-level half running —
    // only a genuinely missing pair (a drop) is the whole-unit half's absence.
    const appliedSet = new Set<string>([...enforcedSet, ...advisorySet]);

    const halfExpandedBundles: Array<{ bundleId: string; enforced: string[]; dropped: string[] }> = [];
    for (const aspect of graph.aspects) {
      if (aspect.reviewer.type !== 'aggregate') continue;
      const implies = aspect.implies ?? [];
      const enforcedMembers = implies.filter((id) => appliedSet.has(id));
      const droppedMembers = implies.filter((id) => wholeUnitDropped.has(id));
      if (enforcedMembers.length > 0 && droppedMembers.length > 0) {
        halfExpandedBundles.push({ bundleId: aspect.id, enforced: enforcedMembers, dropped: droppedMembers });
      }
    }
    halfExpandedBundles.sort((a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));

    const enforced = [...enforcedSet].sort();
    const advisory = [...advisorySet].sort();
    byType.push({
      typeId,
      files,
      enforced,
      enforcedCounts: enforced.map((aspectId) => ({ aspectId, count: enforcedFileCounts.get(aspectId) ?? 0 })),
      advisory,
      advisoryCounts: advisory.map((aspectId) => ({ aspectId, count: advisoryFileCounts.get(aspectId) ?? 0 })),
      dropped,
      halfExpandedBundles,
      uncomputable: groupUncomputable(uncomputable.filter((u) => u.typeId === typeId)),
      chainTermination: termination,
    });
  }

  zeroEnforcementFiles.sort();
  const zeroEnforcement = { count: zeroEnforcementFiles.length, samples: zeroEnforcementFiles.slice(0, SAMPLE_CAP) };

  return {
    byType,
    zeroEnforcement,
    uncomputable: { count: uncomputable.length, groups: groupUncomputable(uncomputable) },
    rows,
  };
}

/** Short, plain-language phrase for a reason — shared by every render surface so the vocabulary never drifts between them. */
export function describeTypeVisibilityReason(reason: TypeVisibilityReason): string {
  switch (reason) {
    case 'when-not-satisfied': return 'its attach condition (when:) was not satisfied on this file';
    case 'draft': return 'the rule is still draft (reviewer skipped)';
    case 'whole-unit-rule': return 'it is whole-unit (per: node) and this file has no component to run it on';
    case 'scope.files-excluded': return "excluded by the rule's own scope.files filter";
    case 'aspect-undefined': return 'the architecture attaches an aspect id with no matching aspect definition';
    case 'unreadable': return 'the file could not be read, so it cannot be reviewed';
    case 'binary-subject': return 'a binary file cannot be reviewed by a prose rule';
    case 'read-beyond-architecture': return "it tried to read a file outside what the architecture allows this file's type to depend on";
    case 'node-context-required': return 'it needs component context (ctx.node / ctx.graph) that a type-covered file does not have';
    case 'companion-context-failed': return 'its companion could not resolve a dependency for this file';
  }
}
