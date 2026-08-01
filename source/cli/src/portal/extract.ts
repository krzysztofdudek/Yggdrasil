import type { Graph } from '../model/graph.js';
import {
  loadPortalGraph,
  walkPortalFiles,
  resetNestedProjectRootsCache,
  runPortalCheck,
  computePortalTypeCoverage,
  toPortalTypeCoverageInput,
  readAndVerifyLock,
  computePortalPairs,
  scanPortalUncovered,
  readNodeLog,
  computePortalBoundary,
  scanPortalSuppressions,
  computePortalFreshness,
  computePortalSourceFileCounts,
  computePortalLockHash,
  readGitCommitRef,
  PORTAL_SCHEMA_SUPPORTED,
  isPortalFileExcludedByCoverage,
  NO_COVERAGE_EXCLUDED,
  type CheckResult,
  type LockVerification,
  type PairComputation,
} from './engine-api.js';
import type { PortalData, PortalCounts, PortalPairState, PortalSuppression } from './contract.js';
import { buildPortalNodes, displayPairState, type SuppressionsByFile } from './derive-nodes.js';
import { buildAspects, buildFlows, buildTypes } from './derive-catalogue.js';
import { buildSuppressions, buildHubs, buildResidue, buildWorklist } from './derive-rest.js';
import { buildBoundary } from './derive-boundary.js';
import { deriveStructure } from './derive-metrics.js';

/**
 * Extract the portal data contract from a project's graph + lock.
 *
 * This is the trust core: every count in `meta.counts` is DERIVED by reusing the
 * CLI's own read-only functions — `runCheck` for severities + coverage, `verifyLock`
 * for per-pair states, `computeExpectedPairs` for the pair denominator — never a
 * literal and never a re-implementation. The acceptance invariant (the count-parity
 * gate) is that `meta.counts.errors/warnings/coveredFiles/totalFiles` equal what
 * `runCheck` reports and `verified + refused + unverified` equals the expected-pair
 * count.
 *
 * Read-only: the graph is loaded committed-only (`noSecrets`), no lock is written,
 * no LLM is called. `generatedAt` is stamped AFTER generation (Date is read here,
 * never inside the pure contract module).
 *
 * Per-node detail, the aspect/flow/type catalogues, the live boundary, hubs,
 * suppression inventory, and the worklist are filled by later derivation steps;
 * this step establishes the counts and the seam.
 */
export async function extractPortalData(
  projectRoot: string,
  opts: { writeEnabled: boolean },
): Promise<PortalData> {
  // Every refresh re-derives from scratch (see the module doc above) — including
  // the separate-project boundary, which would otherwise stay cached from the
  // FIRST refresh of this long-lived server process for as long as it keeps running.
  resetNestedProjectRootsCache();

  // Committed-only graph load — the portal can provably never read yg-secrets.yaml.
  // The facade is the SOLE gateway to the engine; this module reaches no engine node
  // directly (it imports only the facade + the data contract).
  const graph: Graph = await loadPortalGraph(projectRoot);

  const gitFiles = await walkPortalFiles(projectRoot);

  // The type-level classification lattice (coverage.type_level), classified ONCE
  // for this extraction run — mirroring the same single-classification-per-run
  // discipline `yg check` and the fill stage each follow — and threaded into
  // every consumer below, so runPortalCheck, lock verification, and the pair
  // denominator all count the SAME universe instead of the portal silently
  // reporting a component-only one when the tier is on. Undefined at flag-off —
  // every consumer already treats that as "nothing to do."
  const typeCoverageResult = await computePortalTypeCoverage(graph, gitFiles);
  const typeCoverageInput = toPortalTypeCoverageInput(typeCoverageResult);

  // Reuse the engine: severities + coverage come straight from runCheck. The pipeline
  // owns the portal's ONE reading of the wall clock — the facade takes it as an input
  // rather than inventing it, so the engine seam stays a function of what it is given.
  // The clock feeds the review-cadence check, which is why it must be a real clock and
  // not a fixed instant: a rule past its review date has to surface here exactly as it
  // does on the command line.
  const checkResult = await runPortalCheck(graph, gitFiles, () => new Date(), typeCoverageResult);

  // Reuse the engine: per-pair states from lock verification, and the expected-pair
  // denominator from pair computation. (verifyLock computes the same expected set
  // internally; computeExpectedPairs is called for the denominator and the LLM/det split.)
  const { lock, verification: verificationPromise } = readAndVerifyLock(graph, typeCoverageInput);
  const verification = await verificationPromise;
  const expected = await computePortalPairs(graph, typeCoverageInput);

  const counts = buildCounts(graph, checkResult, verification.pairs, expected.pairs);

  // Per-node log content (read once per node; parsed inside the pure derivation).
  // readNodeLog is the engine's own reader — read-only, returns '' when absent.
  const logContents = new Map<string, string>();
  for (const nodePath of graph.nodes.keys()) {
    logContents.set(nodePath, await readNodeLog(projectRoot, nodePath));
  }

  // Live suppression inventory (the facade reaches the ast/suppress scan). Indexed by
  // file so each node's mapped files pick up exactly the markers detected in them.
  const suppressionMarkers = await scanPortalSuppressions(graph, projectRoot, gitFiles, typeCoverageResult);
  const flatSuppressions = buildSuppressions(suppressionMarkers);
  const suppressions = indexSuppressionsByFile(flatSuppressions);

  // File-aware loop: per-node source freshness (current fingerprint vs the committed lock
  // baseline). A node whose mapped bytes changed since its last positive closure reads
  // `unverified` everywhere — the whole-repo cached green can never override a touched file.
  const freshnessMarkers = await computePortalFreshness(graph, lock);
  const freshByNode = new Map<string, boolean>();
  for (const m of freshnessMarkers) freshByNode.set(m.nodePath, m.sourceChanged);

  // The panel's real file count, alongside mappingEntryCount — see PortalNode.sourceFileCount.
  const sourceFileCountMarkers = await computePortalSourceFileCounts(graph);
  const sourceFileCountByNode = new Map<string, number>();
  for (const m of sourceFileCountMarkers) sourceFileCountByNode.set(m.nodePath, m.sourceFileCount);

  const nodes = buildPortalNodes(
    graph,
    lock,
    verification,
    checkResult,
    logContents,
    suppressions,
    freshByNode,
    sourceFileCountByNode,
  );

  // Catalogue derivations (aspect tally, flows, type model) — pure over the graph +
  // the already-verified pairs. Per-node pair-state index for the honest flow state.
  const pairStatesByNode = new Map<string, PortalPairState[]>();
  for (const vp of verification.pairs) {
    // A nodeless (type-covered-file) pair has no component to index under —
    // this index is per-component only; skip here rather than letting
    // `undefined` become a map key.
    if (vp.pair.nodePath === undefined) continue;
    const list = pairStatesByNode.get(vp.pair.nodePath) ?? [];
    list.push(collapsePairState(vp));
    pairStatesByNode.set(vp.pair.nodePath, list);
  }
  const aspects = buildAspects(graph, verification.pairs);
  const flows = buildFlows(graph, (path) => pairStatesByNode.get(path));
  const types = buildTypes(graph);

  // Hubs, residue and the worklist are pure over the already-built node array + the
  // CheckResult; they reuse the engine's own coverage scan and issue grouping.
  const hubs = buildHubs(nodes);
  const uncovered = scanPortalUncovered(graph, gitFiles);
  // The residue's uncovered-files ledger must mean exactly what its own chip says:
  // "nothing is checking this, and it wasn't skipped on purpose". A type-covered
  // file has its own verdict (a real pair against its matched type); an
  // excluded-root file was deliberately dropped from coverage. Neither belongs
  // here — this is the SAME exclusion counts.uncoveredFiles applies, so the chip
  // and this list's length can never disagree.
  const typeCoveredFiles = new Set(typeCoverageResult?.covered.keys() ?? []);
  const genuinelyUncovered = uncovered.filter(
    (f) => !typeCoveredFiles.has(f) && !isPortalFileExcludedByCoverage(f, graph.config.coverage ?? NO_COVERAGE_EXCLUDED),
  );
  const residue = buildResidue(nodes, genuinelyUncovered);
  const worklist = buildWorklist(checkResult);

  // Residue-track count post-pass. These three counts are NOT part of the count-parity
  // identity (verified/refused/unverified/coverage/severities) — they are the additive
  // honest-residue counts the header + Overview residue links display. buildCounts cannot
  // populate them: each depends on data derived AFTER the counts seam (the per-node array,
  // the flat suppression inventory, the residue ledger), so they are filled here once those
  // exist. Deriving them from the SAME built data the views render guarantees the header
  // number can never disagree with the list beneath it (the "0 waived" lie this fixes).
  counts.suppressed = flatSuppressions.length;
  counts.noRule = residue.noRuleNodes.length;
  counts.notApplicable = nodes.reduce((sum, n) => sum + n.notApplicable.length, 0);

  // FULL live boundary via the facade — phantom + declared-only + forbidden-type, joined
  // from the relation pass and the architecture matrix. `null` (the parse genuinely threw)
  // is the ONLY honest "unknown"; a successful parse yields the three classes verbatim.
  // ONE relation pass backs BOTH the boundary AND the structure panel: computePortalBoundary
  // runs the pass once and surfaces its detected-edge set on `boundaryInput`, so deriving the
  // structure metrics below adds NO second pass (the ≤2-pass invariant — runCheck + this one).
  const boundaryInput = await computePortalBoundary(graph, projectRoot);
  const boundary = buildBoundary(boundaryInput);

  // Structure panel — the same analysis `yg structure` computes (dependency tunnels, module
  // groups, change reach), derived PURELY from the already-flattened detected edges + the graph's
  // declared structural relations. A null boundaryInput (the parse threw) yields an explicit
  // UNKNOWN structure, never a fabricated zero graph.
  const structure = deriveStructure(
    graph,
    boundaryInput === null ? null : boundaryInput.detectedEdgesByNode ?? [],
  );

  // Attestation provenance — read-only: a content hash over the committed lock triad and the
  // git HEAD commit ref. Both pin an attestation digest to an exact committed state. The lock
  // hash excludes the gitignored deterministic cache (absent on a fresh clone); the commit ref
  // is null for a non-git dir (the digest then states "no commit ref").
  const lockHash = computePortalLockHash(graph);
  const commitRef = readGitCommitRef(projectRoot);

  const data: PortalData = {
    meta: {
      projectName: checkResult.projectName,
      generatedAt: '', // stamped below, after generation
      autoApprove: normalizeAutoApprove(graph.config.auto_approve),
      writeEnabled: opts.writeEnabled,
      schemaSupported: PORTAL_SCHEMA_SUPPORTED,
      lockHash,
      commitRef,
      counts,
    },
    nodes,
    aspects,
    flows,
    types,
    boundary,
    structure,
    suppressions: flatSuppressions,
    hubs,
    worklist,
    residue,
  };

  // Stamp generation time last — the only impurity, kept out of the contract module.
  data.meta.generatedAt = new Date().toISOString();

  return data;
}

/** Map the parsed config's auto_approve (false | 'deterministic' | 'full' | undefined) to the contract enum. */
function normalizeAutoApprove(value: 'deterministic' | 'full' | false | undefined): 'false' | 'deterministic' | 'full' {
  if (value === 'deterministic' || value === 'full') return value;
  return 'false';
}

/**
 * Collapse a VerifiedPair into the honest DISPLAY taxonomy via the single status-adjustment
 * transform: an advisory refusal → `warning`, the gate states → `unverified`. Used for the
 * per-node pair-state index that feeds the honest flow state — so a flow whose only "problem"
 * is an advisory refusal reads its participant as a non-blocking warning, never a blocking
 * refused.
 */
function collapsePairState(vp: LockVerification['pairs'][number]): PortalPairState {
  return displayPairState(vp.state.kind, vp.pair.status);
}

/** Index the flat suppression inventory by file so per-node filtering is O(mapped files). */
function indexSuppressionsByFile(flat: PortalSuppression[]): SuppressionsByFile {
  const byFile = new Map<string, PortalSuppression[]>();
  for (const s of flat) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }
  return { byFile };
}

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
 * The residue-track counts (suppressed / noRule / notApplicable) are seeded 0 here and
 * filled by a post-pass in extractPortalData, because each is derived from the built
 * node array / residue ledger / suppression inventory — data that does not exist yet at
 * this seam. They are additive residue, not part of the count-parity identity.
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
    // The residue-track counts (noRule / notApplicable / suppressed) are NOT part of the
    // count-parity identity and cannot be computed here — each depends on data derived AFTER
    // this seam (the built node array, the residue ledger, the suppression inventory). They
    // are seeded 0 and OVERWRITTEN by the post-pass in extractPortalData once that data exists.
    // (Never leave them 0: that prints "0 waived / 0 no rule / 0 not applicable" over a list.)
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
    errors,
    warnings,
  };
}
