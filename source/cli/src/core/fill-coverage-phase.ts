/**
 * source/cli/src/core/fill-coverage-phase.ts — the fill stage's preparation
 * (spec §7): the type-level classification and the relation pass the whole run
 * decides with.
 *
 * The type-level classification lattice (coverage.type_level) is computed ONCE
 * for a fill run and threaded into every downstream consumer: the structural
 * gate's own reviewer-presence check (validate → checkReviewerPresence), pair
 * classification (verifyLock — critically, the one thing that keeps a nodeless
 * pair from being pruned as detached), GC (garbageCollectAndRewrite), and both
 * of the run's own runCheck calls (as precomputedTypeCoverage — otherwise
 * runCheck would classify a second time from scratch, reading every uncovered
 * file's bytes twice). Everything is undefined at flag-off or when no file walk
 * ran this call (coverageVisibleFiles === null) — every consumer already treats
 * that as "nothing to do." computeTypeCoverageCached constructs its own
 * persistent .yggdrasil/.type-class-cache/ instance, so `yg check --approve`
 * reads and writes it exactly like a plain `yg check` does, instead of the
 * classification-cache bypass that shipped before.
 */

import type { Graph } from '../model/graph.js';
import type { TypeCoverageInput } from './pairs.js';
import type { TypeCoverageResult } from './type-coverage.js';
import { scanUncoveredFiles } from './check.js';
import { computeTypeCoverageCached } from './type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
// ── Relation pass (parse + resolve) — same index runCheck's own pass builds,
//    so a `relations:` applicability atom is answered identically here. ──
import { runProjectRelationPass } from '../relations/pass.js';
import type { RelationPassResult } from '../relations/pass.js';

/** What the fill run classified and resolved before its structural gate. */
export interface FillCoverage {
  /** The classification in the shape pair computation, validation and GC take. */
  typeCoverageInput: TypeCoverageInput | undefined;
  /** The raw classification, handed to runCheck so it does not classify again. */
  typeCoverageResult: TypeCoverageResult | undefined;
  /**
   * The import-resolution pass this call made, if it made one. Held so the
   * report can be handed it instead of parsing every mapped source file a
   * second time — see runCheck's `precomputedRelationPass`. Stays undefined when
   * type-level coverage is off, in which case the stage never needed the pass
   * and the report runs the run's ONLY one.
   */
  relPassResult: RelationPassResult | undefined;
}

/** Classify type-level coverage and run the relation pass, once per fill run. */
export async function prepareFillCoverage(
  graph: Graph,
  coverageVisibleFiles: string[] | null,
  projectRoot: string,
): Promise<FillCoverage> {
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
  if (coverageVisibleFiles === null || !coverage.typeLevel) {
    return { typeCoverageInput: undefined, typeCoverageResult: undefined, relPassResult: undefined };
  }
  const uncoveredForGate = scanUncoveredFiles(graph, coverageVisibleFiles);
  const typeCoverageResult = await computeTypeCoverageCached(graph, uncoveredForGate, new FileContentCache());

  // Relation pass (parse + resolve), run ONCE for this fill call — after the
  // type coverage is classified (so its typeCoveredFiles map is available)
  // and BEFORE the structural gate / verifyLock, so a `relations:` atom in an
  // aspect's `when:` is answered from the SAME edge index runCheck's own pass
  // builds. Without this, the run's own pair computation (which pairs get
  // filled) would silently disagree with a separate `yg check`'s (which pairs
  // are expected) — a positively-gated rule never filled, a negated one always
  // filled.
  const relPassResult = await runProjectRelationPass(graph, projectRoot, typeCoverageResult.covered);

  const typeCoverageInput: TypeCoverageInput = {
    covered: typeCoverageResult.covered,
    ambiguousPaths: typeCoverageResult.ambiguous.map((a) => a.file),
    edges: relPassResult.typedEdges,
  };
  return { typeCoverageInput, typeCoverageResult, relPassResult };
}
