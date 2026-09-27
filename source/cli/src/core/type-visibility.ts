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
 *     `RUNTIME_DISPOSITION_REASONS`). These are FILL-ONLY facts: `yg check`
 *     and `yg context --file` never re-execute check.mjs themselves, so
 *     `runtimeRows` is `[]` at both call sites' OWN classification — but `yg
 *     check --approve`'s fill stage (core/fill.ts) DOES run check.mjs, and
 *     hands the disposition it just watched happen to its own post-fill
 *     report in the SAME process (core/check.ts's `runtimeDispositions`
 *     option) — the only way a row with one of these reasons is ever
 *     populated, never persisted, never visible to a later separate `yg
 *     check`, `yg context --file`, `yg owner --file`, or the portal, none of
 *     which fill.
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
 * This module builds no NEW reason of its own: every `TypeVisibilityReason` it
 * groups, counts, and shapes is one the producers above already decided (the
 * render layer, `check-render-header.ts`, turns a cascade-cycle group's
 * `aspectId` into the same `why` sentence `yg owner --file` / `yg context
 * --file` already print, via `describeCascadeCycle` (formatters/type-visibility-text.ts) — never
 * restated here, so the wording cannot drift between the three surfaces). The
 * things this module DOES compute itself are which of a type's declared law
 * is enforced ANYWHERE (a plain group-by over `appliedPairs`), where the
 * type's implicit parent chain stops — both pure graph facts, no file I/O,
 * independent of whether a relation-edge index is available — and, lower in
 * this file, the message TEXT for an already-decided reason
 * (`cannotRunUnverifiedMessage`, whose phrase for the reason comes from
 * `describeTypeVisibilityReason`, formatters/type-visibility-text.ts): composing a
 * sentence out of a reason this module did not invent is not the same as
 * inventing one.
 */
import type { Graph } from '../model/graph.js';
import type { AspectStatus } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import type { PairDrop, ExpectedPair, UncomputableTypeCoverage } from './pairs.js';
import { walkTypeParentChain } from './type-effective.js';
// The report's shapes live in the model layer (model/type-visibility.ts) so the
// renderers that print them never depend on this module; re-exported for this
// module's callers.
import { describeTypeVisibilityReason } from '../formatters/type-visibility-text.js';
import type {
  TypeVisibilityReason,
  TypeVisibilityRow,
  TypeVisibilityUncomputableGroup,
  TypeVisibilityReport,
} from '../model/type-visibility.js';
export type { TypeVisibilityReason, TypeVisibilityRow, TypeVisibilityUncomputableGroup, TypeVisibilityReport };

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
 * `runFill`'s same-run fill→check handoff (core/fill.ts, `RunCheckOptions.
 * runtimeDispositions`): translate its raw `(file, aspectId, code)` facts —
 * a component-free det pair's check.mjs THIS run watched fail — into the rows
 * `buildTypeVisibility`'s `runtimeRows` parameter expects, via
 * `classifyRunnerDisposition` above. A code this module does not represent
 * yields no row, same as no disposition at all — never a guess.
 */
export function toRuntimeVisibilityRows(dispositions: Array<{ file: string; aspectId: string; code: string }>): TypeVisibilityRow[] {
  const rows: TypeVisibilityRow[] = [];
  for (const d of dispositions) {
    const reason = classifyRunnerDisposition(d.code);
    if (reason) rows.push({ file: d.file, aspectId: d.aspectId, reason });
  }
  return rows;
}

/**
 * The reason THIS run's `runtimeRows` already recorded for (aspectId,
 * unitKey), or undefined when none applies — a componented pair (`unitKey`
 * has no `file:` prefix), a plain not-yet-approved run (`runtimeRows` is
 * always `[]` there), or a nodeless pair whose check never threw. Used by
 * `unverifiedIssueMessage` below.
 */
export function cannotRunReasonFor(runtimeRows: TypeVisibilityRow[], aspectId: string, unitKey: string): TypeVisibilityReason | undefined {
  if (!unitKey.startsWith('file:')) return undefined;
  const file = unitKey.slice('file:'.length);
  return runtimeRows.find((r) => r.aspectId === aspectId && r.file === file)?.reason;
}

/**
 * The `unverified` message for a nodeless pair `cannotRunReasonFor` already
 * traced to a runtime-only reason THIS run watched happen — unlike
 * `unverifiedMessage` (formatters/lock-issue-messages.ts), `next` never points
 * back at `yg check --approve`: re-attempting it reproduces the identical
 * result, since the disposition is structural, not a stale or missing
 * verdict. Names the same fix `describeTypeVisibilityReason` already states
 * the reason for, so the two never disagree.
 */
export function cannotRunUnverifiedMessage(params: { aspectId: string; unitKey: string; reason: TypeVisibilityReason }): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' cannot run on ${params.unitKey} — re-running yg check --approve reproduces this identical result.`,
    why: `${describeTypeVisibilityReason(params.reason)}; only running the check discovers that, so no lock refresh changes it.`,
    next: `Give the file a component of its own (a yg-node.yaml mapping it), or fix what the reason above names in check.mjs / yg-architecture.yaml — not another --approve.`,
  };
}

/**
 * `core/check.ts`'s `emitPairIssue`, composed: the ordinary `unverifiedMessage`
 * (its `plain` argument — `formatters/lock-issue-messages.ts`, kept as a
 * parameter rather than an import here so this module keeps its existing
 * dependency footprint) UNLESS `cannotRunReasonFor` finds this pair among
 * THIS run's own `runtimeRows`, in which case `cannotRunUnverifiedMessage`
 * takes over — fixing the run that used to tell an agent to re-run `yg
 * check --approve` for a pair it, in the SAME breath, just said cannot run
 * at all. Keeping the branch here (not in check.ts) is what lets
 * `emitPairIssue` stay a one-line swap — see its own call site.
 */
export function unverifiedIssueMessage(
  runtimeRows: TypeVisibilityRow[],
  pair: { aspectId: string; unitKey: string },
  plain: (p: { aspectId: string; unitKey: string }) => IssueMessage,
): IssueMessage {
  const reason = cannotRunReasonFor(runtimeRows, pair.aspectId, pair.unitKey);
  return reason ? cannotRunUnverifiedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey, reason }) : plain(pair);
}

/**
 * One rule's real lock-verification outcome for a single (file, aspectId)
 * pair — narrowed from `core/verify-lock.ts#VerifiedPair` to the one fact
 * `unverifiedVerdictCaveat` below needs, so this module does not import
 * verify-lock's own pair/gate types just to read a discriminant.
 */
export interface RuleVerificationOutcome {
  aspectId: string;
  /**
   * true: the lock holds a CURRENTLY VALID entry for this pair (approved or
   * refused — its recorded input hash still matches). false: no entry at
   * all, OR a stale one whose inputs changed since it was recorded — `yg
   * check`'s own `unverified`, either way.
   */
  verified: boolean;
}

/**
 * The qualified caveat clause for a set of rule-verification outcomes a
 * per-file surface (`yg owner --file`, `yg context --file`) is about to
 * report as "enforced by architecture alone" — never the deep, fill-only
 * "cannot run" reason above (neither surface ever fills). Callers pass the
 * SAME classification `yg check` itself computes for the identical pairs
 * (`core/verify-lock.ts#verifyPairs`, scoped to just this one file's own
 * nodeless pairs — cheap on top of the whole-project pair walk both commands
 * already run, never a second one): a stored entry that no longer matches
 * its current input hash counts here exactly as it would in `yg check`'s own
 * qualified "N unverified" wording, not only a pair with no entry at all.
 * `''` when every pair's stored verdict is currently valid: never claims a
 * gap that does not exist.
 */
export function unverifiedVerdictCaveat(outcomes: RuleVerificationOutcome[]): string {
  const unverified = outcomes.filter((o) => !o.verified);
  if (unverified.length === 0) return '';
  return ` (${unverified.length} of ${outcomes.length} rule${outcomes.length === 1 ? '' : 's'} unverified — no valid verdict is currently on record for ${unverified.length === 1 ? 'it' : 'them'})`;
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
