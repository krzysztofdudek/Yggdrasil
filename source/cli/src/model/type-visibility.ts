/**
 * The type-level coverage tier's report shapes: why a rule attached to a file's
 * type does not run on it, the per-type report `yg check` renders, and the two
 * cascade facts that report carries (where a type's inherited chain stops, and
 * an aspect `implies` cycle the cascade absorbed). Pure types, in the model
 * layer so the renderers that print them name them without depending on the
 * engine that computes them; core/type-visibility.ts and core/type-effective.ts
 * re-export them.
 */

/** Why an aspect the architecture attaches to this file's type does not enforce on it. */
export type TypeAspectDropReason = 'when-not-satisfied' | 'draft';

/** An aspect `implies` cycle absorbed by `computeTypeAspectCascade` (core/type-effective.ts) — see its exception contract there. */
export interface TypeCascadeCycle {
  /** The aspect id at which the cycle was detected (best-effort — the underlying `ImpliesCycleError`'s own field; absent for the rare iteration-bound-exceeded variant). */
  aspectId: string | undefined;
}

/**
 * Why the implicit parent-chain walk (`walkTypeParentChain`, core/type-effective.ts) stopped where it did, computed
 * once per type — independent of any one file. `candidates` names the parent
 * ids at a fork (sorted, code-point order), the single type the walk cannot
 * revisit at a cycle, or the type the chain ends AT for the other two reasons.
 */
export interface ChainTermination {
  reason: 'fork' | 'no-parents' | 'empty-parents' | 'cycle';
  candidates: string[];
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
 * code maps to it in `RUNTIME_DISPOSITION_REASONS` (core/type-visibility.ts), so no caller ever
 * constructs a row with it.
 *
 * All three runtime reasons are FILL-ONLY: they can only ever be discovered
 * by actually running check.mjs, which happens nowhere except `yg check
 * --approve`'s fill stage. `build-context.ts` (`yg context --file`) and
 * `yg owner --file` both compute this report with `runtimeRows: []` always —
 * they never fill, so they have nothing to hand off; a file whose disposition
 * `yg check --approve` named in a prior run reads there exactly as it would
 * with no disposition known at all (the qualified "unverified" fallback,
 * never persisted — see `docs/configuration.md`'s `type_level` paragraph).
 * `check.ts`'s OWN classification (the plain, non-`--approve` read) is
 * likewise always `[]`; only the SAME run's `core/fill.ts`, having just
 * watched a component-free det pair's check.mjs fail with a
 * `StructureRunnerError`, translates its code via `classifyRunnerDisposition`
 * (core/type-visibility.ts) and passes the row into that run's own post-fill `runCheck` call
 * (`RunCheckOptions.runtimeDispositions`) — the one and only live caller of
 * that function outside its own unit tests. `'companion-context-failed'`
 * still has no producer: no `StructureRunnerError` code maps to it in
 * `RUNTIME_DISPOSITION_REASONS`, so no caller ever constructs a row
 * with it — wiring one is a distinct, still-undone change (an LLM pair's
 * companion-hook failure has no code-based disposition to translate).
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
