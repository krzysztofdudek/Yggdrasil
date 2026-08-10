import { describeCascadeCycle, type LockVerification, type PairComputation } from './engine-api.js';
import { displayPairState } from './derive-nodes.js';
import { worstPairState } from './derive-pair-state.js';
import type { PortalPairState, PortalTypeCoveredFile, PortalTypeCoveredUncomputableFile } from './contract.js';

/**
 * derive-type-coverage — per-file enforcement state for every type-covered file. Split out of
 * extract.ts so that orchestration file stays a focused unit (the same reason derive-counts.ts
 * and its `derive-*` siblings in this node exist); pure over the pair computation and lock
 * verification extractPortalData already ran — no I/O of its own.
 */

export interface TypeCoveredFilesResult {
  entries: PortalTypeCoveredFile[];
  uncomputableEntries: PortalTypeCoveredUncomputableFile[];
}

/**
 * Build the type-covered residue: which type-classified files have an actual enforced rule
 * (`enforced`), what that rule's honest pair state reads (`pairState`), and which files an
 * aspect `implies` cycle stopped from being resolved at all (`uncomputableEntries`).
 *
 * "enforced" means at least one non-draft rule from the matched type's cascade actually applies
 * to THIS file — read off the SAME nodeless expected pairs the pair-count seam (`expected`)
 * already computed, just re-indexed per file instead of only totalled, so this costs no second
 * pass computation. A file with zero such pairs matched a type but has nothing that checks it —
 * `yg check`'s own "satisfy coverage with no enforcement" state — and must never render the same
 * as a file with a real pair (verified, refused, or unverified).
 *
 * A file an aspect `implies` cycle stopped from being resolved at all
 * (`expected.uncomputableTypeCoverage`) is a THIRD, disjoint state: resolution never ran for it,
 * so it is neither "enforced" nor the zero-rule state above — `core/type-visibility.ts` (the
 * same producer `yg check`, `yg context --file`, and `yg owner --file` already read) excludes it
 * from both for the identical reason. Folding it into `enforced: false` here would render it
 * with the SAME "satisfy coverage with no enforcement" wording those three surfaces refuse to
 * use for it — a resolved claim where the honest answer is unknown.
 *
 * `enforced` names architecture-level status, never a recorded verdict — `verificationPairs`
 * already carries a REAL per-pair re-verification for every nodeless pair too, because
 * `typeCoverage` was threaded into `readAndVerifyLock` by the caller. Reading that result again
 * here costs nothing further: no second pass, no extra I/O.
 *
 * `pairState` replaces a presence-only `unverified` boolean: a REFUSED pair is a valid, current
 * lock entry too, so "is there a valid verdict on record" was never enough to tell an agent WHAT
 * that verdict says — a refused type-covered file used to render identically to a verified one.
 * Fold every nodeless pair matched to this file through the SAME status-adjusted DISPLAY
 * transform (`displayPairState`) the per-node index in derive-nodes.ts already applies — an
 * advisory refusal reads `warning`, never a blocking `refused` — then reduce worst-state-wins
 * via `worstPairState` (refused > unverified > warning > verified), the same reducer an aspect's
 * own tally already uses, so a file with one refused pair and one verified sibling reads the
 * worse of the two, never a false all-clear. A refused pair's reason (`vp.state.reason`) is
 * collected alongside it, keyed the same way, so the file's row can say WHY it is refused, not
 * just that it is.
 *
 * GUARD — the one trap this fold exists to avoid: `worstPairState` seeds its reduce at
 * `'verified'`, so calling it with an EMPTY array silently returns `'verified'` — fabricated
 * green. An unenforced type-covered file (`enforced === false`) has ZERO nodeless pairs by
 * construction, so `pairState` must be ABSENT for it, never computed from an empty fold.
 * `pairState` is therefore populated if and only if `enforced` is true; even then, if this
 * file's `enforced` flag somehow disagreed with `verificationPairs` and contributed no states
 * at all, the fallback is the explicit `'unverified'` literal below — NEVER a call to
 * `worstPairState([])`.
 */
export function buildTypeCoveredFiles(
  expected: Pick<PairComputation, 'pairs' | 'uncomputableTypeCoverage'>,
  verificationPairs: LockVerification['pairs'],
  typeCoveredMap: Map<string, string>,
): TypeCoveredFilesResult {
  const enforcedTypeCoveredFiles = new Set<string>();
  for (const p of expected.pairs) {
    if (p.nodePath !== undefined) continue;
    for (const f of p.subjectFiles) enforcedTypeCoveredFiles.add(f);
  }

  const statesByFile = new Map<string, PortalPairState[]>();
  const reasonsByFile = new Map<string, string[]>();
  for (const vp of verificationPairs) {
    if (vp.pair.nodePath !== undefined) continue;
    const display = displayPairState(vp.state.kind, vp.pair.status);
    for (const f of vp.pair.subjectFiles) {
      const states = statesByFile.get(f) ?? [];
      states.push(display);
      statesByFile.set(f, states);
      // A refusal's reason belongs to the file regardless of status-adjusted
      // display (refused AND advisory-refused-shown-as-warning both keep their
      // reason — see PortalTypeCoveredFile.reasons's own doc) — key off the RAW
      // verdict kind, not the display transform.
      if (vp.state.kind === 'refused' && vp.state.reason !== undefined) {
        const reasons = reasonsByFile.get(f) ?? [];
        reasons.push(vp.state.reason);
        reasonsByFile.set(f, reasons);
      }
    }
  }

  const uncomputableByFile = new Map<string, string>(); // file -> why (describeCascadeCycle's sentence)
  for (const u of expected.uncomputableTypeCoverage) {
    uncomputableByFile.set(u.file, describeCascadeCycle(u.cycle));
  }

  const entries: PortalTypeCoveredFile[] = [];
  const uncomputableEntries: PortalTypeCoveredUncomputableFile[] = [];
  for (const [path, type] of typeCoveredMap) {
    const why = uncomputableByFile.get(path);
    if (why !== undefined) {
      uncomputableEntries.push({ path, type, why });
    } else {
      const enforced = enforcedTypeCoveredFiles.has(path);
      const states = statesByFile.get(path);
      const reasons = reasonsByFile.get(path);
      entries.push({
        path,
        type,
        enforced,
        // ABSENT when unenforced (zero pairs — see the GUARD above); the
        // explicit 'unverified' fallback covers an enforced file whose pairs
        // somehow contributed no states, so `worstPairState` is only ever
        // called on a guaranteed-non-empty array.
        ...(enforced
          ? {
              pairState: (states !== undefined && states.length > 0
                ? worstPairState(states)
                : 'unverified') as Exclude<PortalPairState, 'n/a'>,
            }
          : {}),
        // Gated on `enforced` too (not just "did we collect any reasons"): the contract
        // declares `reasons` absent whenever `pairState` is absent (PortalTypeCoveredFile's
        // own doc), and that invariant must rest on construction here, not on
        // `enforcedTypeCoveredFiles` (from `expected.pairs`) and `reasonsByFile` (from
        // `verificationPairs`) — two separately-computed pair universes — happening to agree.
        ...(enforced && reasons !== undefined && reasons.length > 0 ? { reasons } : {}),
      });
    }
  }

  return { entries, uncomputableEntries };
}
