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
  describeCascadeCycle,
  PORTAL_SCHEMA_SUPPORTED,
  isPortalFileExcludedByCoverage,
  NO_COVERAGE_EXCLUDED,
  type LockVerification,
} from './engine-api.js';
import type {
  PortalData,
  PortalPairState,
  PortalSuppression,
  PortalTypeCoveredFile,
  PortalTypeCoveredUncomputableFile,
} from './contract.js';
import { buildPortalNodes, displayPairState, type SuppressionsByFile } from './derive-nodes.js';
import { buildAspects, buildFlows, buildTypes } from './derive-catalogue.js';
import { buildSuppressions, buildHubs, buildResidue, buildWorklist } from './derive-rest.js';
import { buildBoundary } from './derive-boundary.js';
import { deriveStructure, type StructureTypeWidening } from './derive-metrics.js';
import { buildCounts } from './derive-counts.js';

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

  const repoFiles = await walkPortalFiles(projectRoot);

  // The type-level classification lattice (coverage.type_level), classified ONCE
  // for this extraction run — mirroring the same single-classification-per-run
  // discipline `yg check` and the fill stage each follow — and threaded into
  // every consumer below, so runPortalCheck, lock verification, and the pair
  // denominator all count the SAME universe instead of the portal silently
  // reporting a component-only one when the tier is on. Undefined at flag-off —
  // every consumer already treats that as "nothing to do."
  const typeCoverageResult = await computePortalTypeCoverage(graph, repoFiles);
  const typeCoverageInput = toPortalTypeCoverageInput(typeCoverageResult);

  // Reuse the engine: severities + coverage come straight from runCheck. The pipeline
  // owns the portal's ONE reading of the wall clock — the facade takes it as an input
  // rather than inventing it, so the engine seam stays a function of what it is given.
  // The clock feeds the review-cadence check, which is why it must be a real clock and
  // not a fixed instant: a rule past its review date has to surface here exactly as it
  // does on the command line.
  const checkResult = await runPortalCheck(graph, repoFiles, () => new Date(), typeCoverageResult);

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
  const suppressionMarkers = await scanPortalSuppressions(graph, projectRoot, repoFiles, typeCoverageResult);
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
  const uncovered = scanPortalUncovered(graph, repoFiles);
  // The residue's uncovered-files ledger must mean exactly what its own chip says:
  // "nothing is checking this, and it wasn't skipped on purpose". A type-covered
  // file has its own verdict (a real pair against its matched type); an
  // excluded-root file was deliberately dropped from coverage. Neither belongs
  // here — this is the SAME exclusion counts.uncoveredFiles applies, so the chip
  // and this list's length can never disagree.
  const typeCoveredMap = typeCoverageResult?.covered ?? new Map<string, string>();
  const typeCoveredPaths = new Set(typeCoveredMap.keys());
  const coverageExclusion = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const genuinelyUncovered = uncovered.filter(
    (f) => !typeCoveredPaths.has(f) && !isPortalFileExcludedByCoverage(f, coverageExclusion),
  );
  // Deliberately excluded (never classified, never a residue gap) — the same file set
  // `counts.excludedFiles` counts, kept as its own list so the file has somewhere to be
  // found by name instead of only ever being a number (it was never dropped by accident).
  const excludedFileList = uncovered.filter(
    (f) => !typeCoveredPaths.has(f) && isPortalFileExcludedByCoverage(f, coverageExclusion),
  );

  // Per-file enforcement state for every type-covered file: "enforced" means at least one
  // non-draft rule from the matched type's cascade actually applies to THIS file — read off
  // the SAME nodeless expected pairs already computed above for the pair-count seam
  // (`expected`), just re-indexed per file instead of only totalled, so this costs no second
  // pass computation. A file with zero such pairs matched a type but has nothing that checks
  // it — `yg check`'s own "satisfy coverage with no enforcement" state — and must never
  // render the same as a file with a real pair (verified, refused, or unverified).
  //
  // A file an aspect `implies` cycle stopped from being resolved at all
  // (`expected.uncomputableTypeCoverage`) is a THIRD, disjoint state: resolution never ran
  // for it, so it is neither "enforced" nor the zero-rule state above — `core/type-visibility.ts`
  // (the same producer `yg check`, `yg context --file`, and `yg owner --file` already read)
  // excludes it from both for the identical reason. Folding it into `enforced: false` here
  // would render it with the SAME "satisfy coverage with no enforcement" wording those three
  // surfaces refuse to use for it — a resolved claim where the honest answer is unknown.
  const enforcedTypeCoveredFiles = new Set<string>();
  for (const p of expected.pairs) {
    if (p.nodePath !== undefined) continue;
    for (const f of p.subjectFiles) enforcedTypeCoveredFiles.add(f);
  }
  // `enforced` names architecture-level status, never a recorded verdict —
  // `verification.pairs` (already computed above, at line 100/130/150's own
  // cost, for the counts/node/aspect derivations) already carries a REAL
  // per-pair re-verification for every nodeless pair too, because `typeCoverage`
  // was threaded into `readAndVerifyLock` at the top of this function. Reading
  // that result again here costs nothing further: no second pass, no extra I/O.
  // A pair's state is `'verified'` or `'refused'` exactly when the lock holds a
  // CURRENT valid entry for it (the input hash still matches); anything else —
  // missing entirely, or present but stale since a source edit — is the same
  // "no valid verdict on record" fact `yg check`, `yg owner --file`, and `yg
  // context --file` already name for the identical pair, so the portal cannot
  // answer more weakly than the verification it is already holding.
  const unverifiedTypeCoveredFiles = new Set<string>();
  for (const vp of verification.pairs) {
    if (vp.pair.nodePath !== undefined) continue;
    if (vp.state.kind === 'verified' || vp.state.kind === 'refused') continue;
    for (const f of vp.pair.subjectFiles) unverifiedTypeCoveredFiles.add(f);
  }
  const uncomputableByFile = new Map<string, string>(); // file -> why (describeCascadeCycle's sentence)
  for (const u of expected.uncomputableTypeCoverage) {
    uncomputableByFile.set(u.file, describeCascadeCycle(u.cycle));
  }
  const typeCoveredEntries: PortalTypeCoveredFile[] = [];
  const typeCoveredUncomputableEntries: PortalTypeCoveredUncomputableFile[] = [];
  for (const [path, type] of typeCoveredMap) {
    const why = uncomputableByFile.get(path);
    if (why !== undefined) {
      typeCoveredUncomputableEntries.push({ path, type, why });
    } else {
      typeCoveredEntries.push({ path, type, enforced: enforcedTypeCoveredFiles.has(path), unverified: unverifiedTypeCoveredFiles.has(path) });
    }
  }

  const residue = buildResidue(nodes, genuinelyUncovered, typeCoveredEntries, excludedFileList, typeCoveredUncomputableEntries);
  const worklist = buildWorklist(checkResult);

  // Residue-track count post-pass. These four counts are NOT part of the count-parity
  // identity (verified/refused/unverified/coverage/severities) — they are the additive
  // honest-residue counts the header + Overview residue links display. buildCounts cannot
  // populate them: each depends on data derived AFTER the counts seam (the per-node array,
  // the flat suppression inventory, the residue ledger), so they are filled here once those
  // exist. Deriving them from the SAME built data the views render guarantees the header
  // number can never disagree with the list beneath it (the "0 waived" lie this fixes).
  counts.suppressed = flatSuppressions.length;
  counts.noRule = residue.noRuleNodes.length;
  counts.notApplicable = nodes.reduce((sum, n) => sum + n.notApplicable.length, 0);
  counts.typeCoveredUnenforced = residue.typeCovered.filter((f) => !f.enforced).length;
  counts.typeCoveredUncomputable = residue.typeCoveredUncomputable.length;

  // FULL live boundary via the facade — phantom + declared-only + forbidden-type, joined
  // from the relation pass and the architecture matrix. `null` (the parse genuinely threw)
  // is the ONLY honest "unknown"; a successful parse yields the three classes verbatim.
  // ONE relation pass backs the boundary, the structure panel's detected-edge half, AND (when
  // the tier is on and classified something) the type-level widening below: seeding
  // computePortalBoundary with the SAME typeCoveredMap this run already classified makes the
  // ONE pass it runs also carry the live type-relation gate's edges on `boundaryInput.typedEdges`
  // — so the widening costs NO second, dedicated pass, and the ≤2-pass invariant (runCheck +
  // this one) holds at flag-on too, not only at flag-off.
  const boundaryInput = await computePortalBoundary(
    graph,
    projectRoot,
    typeCoveredMap.size > 0 ? typeCoveredMap : undefined,
  );
  const boundary = buildBoundary(boundaryInput);

  // Structure panel — the same analysis `yg structure` computes (dependency tunnels, module
  // groups, change reach), derived PURELY from the already-flattened detected edges + the graph's
  // declared structural relations, WIDENED with the same type-level augmentation `yg structure`
  // merges into its own universe (every statically-resolved import edge touching a type-covered
  // file) whenever the tier is on and classified something. A null boundaryInput (the parse
  // threw) yields an explicit UNKNOWN structure, never a fabricated zero graph.
  const typeWidening: StructureTypeWidening | undefined =
    typeCoveredMap.size > 0
      ? { edges: boundaryInput?.typedEdges ?? [], nodeIds: [...typeCoveredMap.keys()] }
      : undefined;
  const structure = deriveStructure(
    graph,
    boundaryInput === null ? null : boundaryInput.detectedEdgesByNode ?? [],
    typeWidening,
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

// `buildCounts` — meta.counts from the engine's own results — lives in derive-counts.ts
// (split out so each file stays a focused unit); re-exported here so an existing caller
// importing it from this module's own public surface needs no change.
export { buildCounts };
