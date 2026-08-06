import type { Graph } from '../model/graph.js';
import type { CheckResult, LockVerification, PairComputation } from './engine-api.js';
import { displayPairState } from './derive-nodes.js';
import type { PortalCounts } from './contract.js';

/**
 * derive-counts — `meta.counts` from the engine's own results. Split out of extract.ts so
 * each file stays a focused unit (mirrors the panel-view.js / panel-aspect.js split on the
 * frontend side). Pure: no I/O, no graph mutation, no lock access — the same discipline every
 * other `derive-*` sibling in this node follows.
 */

/**
 * Build meta.counts from the engine results. The pair-state, severity, and coverage
 * counts are read off the engine's own outputs so they can never diverge from
 * `yg check`. Pairs that are neither cleanly verified nor a code refusal
 * (prompt-too-large, companion-error) are counted as unverified — they are not
 * green and not a reviewer's "no".
 *
 * Pair states are bucketed by the status-adjusted DISPLAY state (the single
 * `displayPairState` transform), so a `refused` verdict on an ADVISORY aspect lands in
 * `advisoryRefused` — NOT `refused`. `refused` then counts ENFORCED refusals only, matching
 * what `yg check` blocks on, while the advisory refusal is the non-blocking warning it already
 * shows up as in `warnings` (runCheck emits it as a warning issue). The count-parity identity
 * stays whole: verified + refused + unverified + advisoryRefused === expected pairs.
 *
 * The residue-track counts (suppressed / noRule / notApplicable / typeCoveredUnenforced /
 * typeCoveredUncomputable) are seeded 0 here and filled by a post-pass in extractPortalData,
 * because each is derived from the built node array / residue ledger / suppression
 * inventory — data that does not exist yet at this seam. They are additive residue, not part
 * of the count-parity identity.
 */
export function buildCounts(
  graph: Graph,
  check: CheckResult,
  pairs: LockVerification['pairs'],
  expectedPairs: PairComputation['pairs'],
): PortalCounts {
  let verified = 0;
  let verifiedDet = 0;
  let verifiedLlm = 0;
  let refused = 0;
  let unverified = 0;
  let advisoryRefused = 0;
  for (const vp of pairs) {
    // Bucket by the status-adjusted display state, so an advisory refusal never reads as a
    // blocking `refused` (it is the non-blocking warning `yg check` already reports).
    switch (displayPairState(vp.state.kind, vp.pair.status)) {
      case 'verified':
        verified += 1;
        // Split by reviewer kind — the same split CheckResult.verifiedDet/verifiedLlm tallies
        // off the identical pairs loop in runCheck, so the two stay in lockstep.
        if (vp.pair.kind === 'llm') verifiedLlm += 1;
        else verifiedDet += 1;
        break;
      case 'refused':
        // ENFORCED refusal — a real, blocking "no".
        refused += 1;
        break;
      case 'warning':
        // ADVISORY refusal — non-blocking signal, already counted in `warnings`.
        advisoryRefused += 1;
        break;
      default:
        // unverified | prompt-too-large | companion-error → not green, not a code "no".
        unverified += 1;
        break;
    }
  }

  let pairsLLM = 0;
  let pairsDet = 0;
  for (const p of expectedPairs) {
    if (p.kind === 'llm') pairsLLM += 1;
    else pairsDet += 1;
  }

  const errors = check.issues.filter((i) => i.severity === 'error').length;
  const warnings = check.issues.filter((i) => i.severity === 'warning').length;

  return {
    nodes: graph.nodes.size,
    aspects: graph.aspects.length,
    flows: graph.flows.length,
    pairsTotal: expectedPairs.length,
    pairsLLM,
    pairsDet,
    verified,
    verifiedDet,
    verifiedLlm,
    refused,
    unverified,
    advisoryRefused,
    // The residue-track counts (noRule / notApplicable / suppressed / typeCoveredUnenforced /
    // typeCoveredUncomputable) are NOT part of the count-parity identity and cannot be computed
    // here — each depends on data derived AFTER this seam (the built node array, the residue
    // ledger, the suppression inventory). They are seeded 0 and OVERWRITTEN by the post-pass in
    // extractPortalData once that data exists. (Never leave them 0: that prints "0 waived / 0 no
    // rule / 0 not applicable" over a list.)
    noRule: 0,
    draft: check.draftSkipped,
    notApplicable: 0,
    suppressed: 0,
    // A file satisfied by the type-level lattice has its own verdict — it must
    // never ALSO inflate "uncovered". coveredFiles keeps its legacy conflated
    // meaning (nodeOwnedFiles + excludedFiles, unchanged below); subtracting
    // typeCoveredCount on top of it is the one corrected term.
    uncoveredFiles: check.totalFiles - check.coveredFiles - (check.typeCoveredCount ?? 0),
    coveredFiles: check.coveredFiles,
    totalFiles: check.totalFiles,
    typeCoveredCount: check.typeCoveredCount ?? 0,
    excludedFiles: check.excludedFiles ?? 0,
    typeCoveredUnenforced: 0,
    typeCoveredUncomputable: 0,
    errors,
    warnings,
  };
}
