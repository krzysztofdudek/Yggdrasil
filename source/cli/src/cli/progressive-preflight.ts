/**
 * source/cli/src/cli/progressive-preflight.ts — turns the progressive-mode
 * git probes (`utils/git-introspect.ts`) into exactly one verdict for
 * `yg check`: gate the whole graph, gate only the touched set, stay quiet,
 * or fall back to the whole graph because the state could not be trusted.
 *
 * This module is the decision table, kept strictly separate from the
 * probing it decides over. Nothing here calls git, touches the filesystem,
 * reads the clock, or reads an environment variable — every fact arrives
 * already resolved as a plain value, so the same inputs always produce the
 * same verdict. That purity is what makes the table testable without a
 * repository at all, and it is why the module doing the actual probing
 * (`utils/git-introspect.ts`) is a strictly separate file: mixing "go find
 * out" with "decide what it means" would make the decision itself
 * un-replayable.
 *
 * ── The one invariant every branch below protects ───────────────────────
 * `honest-empty` is the ONLY quiet-green outcome — the run reports nothing
 * in scope and exits clean. Reaching it on a guess rather than a proof is
 * exactly the silent-green hole this state machine exists to close: a rule
 * violation sitting in a change that progressive mode never actually looked
 * at would pass CI with a clean report. So `honest-empty` requires a
 * POSITIVE proof (a probe that answered `true`, never a `null` standing in
 * for "probably fine"), and anything that merely LOOKS empty without that
 * proof — most importantly an empty touched set on its own — must land in
 * `global-fallback` instead, never in `honest-empty` and never quietly in
 * `scoped` (there is nothing to scope from an unproven or absent diff).
 */
import type { ChangedFiles } from '../utils/git-introspect.js';

/**
 * Every fact the state machine needs, already resolved by the caller: the
 * command layer wires `utils/git-introspect.ts`'s probes and the parsed
 * CLI/config values into this shape — this module never resolves any of it
 * itself. Field names pin exactly what was compared, since several of
 * these are easy to get backwards (ancestor direction, which two trees):
 *
 * - `configReference` — the `progressive.reference` value from
 *   `yg-config.yaml` (e.g. `origin/main`), or `undefined` when the project
 *   never opted in to progressive mode at all.
 * - `fullFlag` — whether `--full` was passed on this invocation.
 * - `mergeBase` — `getMergeBase(HEAD, configReference)`, or `null` if it
 *   could not be resolved (bad reference, or a shallow clone whose history
 *   does not reach the common ancestor).
 * - `isAncestorHeadRef` — `isAncestor(HEAD, configReference)`: is HEAD an
 *   ancestor of (or equal to) the reference? True here is algebraically the
 *   same fact as `mergeBase === HEAD` — the reference has not been left
 *   behind by anything HEAD has done.
 * - `worktreeClean` — `hasCleanWorktree()`: no staged, unstaged, or
 *   untracked change versus HEAD.
 * - `treesIdenticalHeadMb` — `treesIdentical(HEAD, mergeBase)`: do HEAD and
 *   the merge-base point at the same tree CONTENT (not the same commit)?
 *   True here is the commit-then-revert shape: history diverged and came
 *   back to the same content.
 * - `touched` — the union touched set from `changedFilesAgainst`, or `null`
 *   if it could not be enumerated at all.
 * - `toplevelMatchesProjectRoot` — does `git rev-parse --show-toplevel`
 *   equal the project root this graph's paths are relative to? `null` when
 *   the probe itself failed; `false` on a confirmed mismatch (a nested
 *   graph or monorepo subdirectory) — both are treated identically below,
 *   since neither is a confirmed match.
 * - `shallow` — `isShallowRepository()`, used only to pick which of three
 *   distinct explanations a `mergeBase === null` fallback gets.
 * - `submoduleGitlinkInDiff` — whether a submodule gitlink appears among the
 *   changed paths. NOT a by-product of the touched set, and NOT implied by
 *   `touched` being resolved: the changed-file reader reports paths only,
 *   with no file modes, so nothing in `touched` distinguishes a gitlink from
 *   an ordinary file. A caller answers this from a SEPARATE probe
 *   (`gitlinkPaths` in `utils/git-introspect.ts`, which must read both the
 *   current index and the reference's own tree — neither alone sees a
 *   submodule that was added but not committed, or one this change removed)
 *   and intersects that set with the touched paths itself. Always a concrete
 *   `boolean` (not nullable) because the row it feeds below is a refusal and
 *   there is no third answer this table could act on — which is exactly why a
 *   caller that could not determine it must supply `true` (refuse) rather
 *   than the reassuring `false`.
 */
export interface PreflightProbes {
  configReference: string | undefined;
  fullFlag: boolean;
  mergeBase: string | null;
  isAncestorHeadRef: boolean | null;
  worktreeClean: boolean | null;
  treesIdenticalHeadMb: boolean | null;
  touched: ChangedFiles | null;
  toplevelMatchesProjectRoot: boolean | null;
  shallow: boolean | null;
  submoduleGitlinkInDiff: boolean;
}

/**
 * The verdict. `reason` is set on every `global-fallback` (never on any
 * other mode) and names the SPECIFIC cause, not a generic "state machine
 * declined" string — a caller renders it through
 * `formatters/message-builder.ts`'s what/why/next shape, and a generic
 * reason would give that renderer nothing to work with.
 */
export interface ProgressiveState {
  mode: 'off' | 'full' | 'honest-empty' | 'scoped' | 'global-fallback';
  reason?: string;
}

/**
 * Resolve the verdict. An if-ladder in matrix order, deliberately not a
 * `switch` (there is no single discriminant to switch on — each branch
 * tests a different combination of fields) and deliberately not
 * reordered for brevity: the order IS the doctrine. Every early return is a
 * "this is the stricter, more-blocking answer and it wins over anything
 * later" claim, so moving a check changes what the state machine means, not
 * just how it reads.
 */
export function resolveProgressiveState(p: PreflightProbes): ProgressiveState {
  // 1. `--full` is the explicit escape hatch — a CI leg proving the whole
  //    graph, or a maintainer auditing everything, asks for this BECAUSE it
  //    wants the answer this ladder would otherwise compute to not matter.
  //    It wins even over a project that never configured progressive mode
  //    at all: "prove everything" needs no prior opt-in.
  if (p.fullFlag) {
    return { mode: 'full' };
  }

  // 2. No configured reference means the feature was never turned on. This
  //    must be reachable with EVERY other probe still at its zero value
  //    (null/false/absent) — a project that never opted in must never be
  //    pulled into a `global-fallback` branch below, all of which exist to
  //    react to a progressive run that COULD NOT prove itself trustworthy.
  //    "Never asked" and "asked and could not answer" are different
  //    situations and must not share an outcome.
  if (p.configReference === undefined) {
    return { mode: 'off' };
  }

  // 3. Fallback causes — checked before anything that could look clean or
  //    scoped, because a probe that failed outright must win over a probe
  //    that merely happened to read as empty. The four causes below are
  //    checked most-upstream-fact first: a `null` touched set undermines
  //    everything else this function could say, an unresolved merge-base
  //    undermines the ancestry/tree-identity probes that depend on it, and
  //    so on, so when more than one cause fires at once, the first one
  //    listed here is the one reported.

  // 3a. Without a touched set, nothing later in this ladder can be trusted:
  //     `scoped` would gate on a guessed diff and `honest-empty` would call
  //     that guess proof. A caller that cannot enumerate the diff has
  //     nothing safer to do than gate everything.
  if (p.touched === null) {
    return {
      mode: 'global-fallback',
      reason:
        'the changed-files diff against the configured reference could not be read (git status/diff failed), so there is no touched set to scope against.',
    };
  }

  // 3b. No merge-base means there is no stable point to diff against at
  //     all. `shallow` disambiguates WHY into three genuinely different
  //     fixes, so the caller rendering this reason can name one instead of shrugging:
  //     - a confirmed shallow clone (`shallow === true`) means the common
  //       ancestor is probably just outside the truncated history — fetch
  //       more and the SAME reference will resolve;
  //     - an unknown shallow-ness (`shallow === null`) means even THAT
  //       probe could not run, which points at a broader git failure (no
  //       git binary, `repoCwd` not a repository, …) rather than history
  //       depth specifically;
  //     - a confirmed full clone (`shallow === false`) rules out history
  //       depth entirely, so the merge-base failure means the CONFIGURED
  //       REFERENCE itself is the problem (typo, branch renamed/deleted,
  //       never fetched).
  if (p.mergeBase === null) {
    if (p.shallow === true) {
      return {
        mode: 'global-fallback',
        reason:
          'no merge-base with the configured reference could be found, and this is a shallow clone — the common ancestor is likely outside the truncated history. Fetch more history (e.g. `git fetch --unshallow`) and re-run.',
      };
    }
    if (p.shallow === null) {
      return {
        mode: 'global-fallback',
        reason:
          'no merge-base with the configured reference could be found, and git itself did not answer the shallow-clone probe either — this looks like a broader git failure (missing git, or this is not a git repository), not just an unresolved reference.',
      };
    }
    return {
      mode: 'global-fallback',
      reason:
        'no merge-base with the configured reference could be found, even though this is a full (non-shallow) clone — the configured reference likely does not exist or was never fetched. Check progressive.reference in yg-config.yaml.',
    };
  }

  // 3c. A nested graph root (this run's git top level does not match the
  //     project root the graph's paths are relative to) makes every path in
  //     the touched set potentially mis-rooted. `null` (the probe itself
  //     failed) is treated the same as a confirmed mismatch — neither is a
  //     confirmed match, and scoping on an unconfirmed root is worse than
  //     gating everything.
  if (p.toplevelMatchesProjectRoot !== true) {
    return {
      mode: 'global-fallback',
      reason:
        'the git work-tree top level does not match (or could not be confirmed to match) the project root — a nested graph or monorepo subdirectory would have every touched path resolved against the wrong root.',
    };
  }

  // 3d. A submodule gitlink in the diff is not a file path at all — it is a
  //     pointer to another repository's commit. Scoping needs paths it can
  //     match against the graph's mapping, and a gitlink has none.
  if (p.submoduleGitlinkInDiff) {
    return {
      mode: 'global-fallback',
      reason:
        'a submodule gitlink appears in the changed-files diff, and scoping cannot resolve a gitlink to a plain file path.',
    };
  }

  // 4. Honest-empty: the only quiet-green outcome, reached ONLY by a
  //    positive proof. Two independent shapes prove it:
  //    (a) HEAD has not moved past the reference at all
  //        (`isAncestorHeadRef === true`, i.e. `mergeBase === HEAD`);
  //    (b) HEAD moved past the reference and came back to the exact same
  //        tree content — the commit-then-revert branch
  //        (`treesIdenticalHeadMb === true`).
  //    Neither shape alone says anything about UNCOMMITTED changes sitting
  //    on top, so both additionally require a clean worktree. `=== true`
  //    (never a truthy check) on every condition is what keeps a `null` —
  //    "could not tell" — from ever being mistaken for "proved clean".
  if (p.isAncestorHeadRef === true && p.worktreeClean === true) {
    return { mode: 'honest-empty' };
  }
  if (p.treesIdenticalHeadMb === true && p.worktreeClean === true) {
    return { mode: 'honest-empty' };
  }

  // 5. Every route to a proven-clean state has been ruled out. An EMPTY
  //    touched set at this point is not additional evidence of "nothing
  //    changed" — it is the exact shape an enumeration bug produces (the
  //    diff/status call silently missed something while the tree-identity
  //    or worktree probes disagree with it, e.g. mergeBase ≠ HEAD with
  //    Δ = ∅ but the trees are NOT identical). Reporting `scoped` here
  //    would gate nothing and print a clean report for real drift; reporting
  //    `honest-empty` would repeat the exact silent-green mistake this
  //    state machine exists to close. Only the global gate is defensible.
  if (p.touched.files.size === 0) {
    return {
      mode: 'global-fallback',
      reason:
        'the touched set came back empty, but nothing proved the state actually clean (the tree-identity and worktree probes did not corroborate it) — treating this as an enumeration failure rather than honest-empty.',
    };
  }

  // 6. A non-empty touched set with a trustworthy merge-base is exactly the
  //    case progressive mode exists to handle, whether the branch is
  //    ordinary or the reference merely sits on top of local uncommitted
  //    changes: gate the change, not the world.
  return { mode: 'scoped' };
}
