import type { Graph } from '../../model/graph.js';
import { scanUncoveredFiles } from '../../core/check.js';
import { computeTypeCoverageCached, type TypeCoverageResult } from '../../core/type-coverage.js';
import { FileContentCache } from '../../io/file-content-cache.js';
import type { TypeCoverageInput } from '../../core/pairs.js';

/**
 * portal/api/type-coverage — the type-level classification lattice
 * (coverage.type_level), behind the portal facade.
 *
 * Classifies ONCE for a whole portal extraction run — mirroring the same
 * single-classification-per-run discipline runCheck and runFill each follow —
 * so every consumer counts the SAME universe instead of the portal running an
 * independent classify per call. Undefined when the flag is off.
 */
export async function computePortalTypeCoverage(graph: Graph, gitFiles: string[]): Promise<TypeCoverageResult | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  return computeTypeCoverageCached(graph, uncovered, new FileContentCache());
}

/** Reduce a full classification to the denominator / lock-verification shape. */
export function toPortalTypeCoverageInput(result: TypeCoverageResult | undefined): TypeCoverageInput | undefined {
  return result
    ? { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) }
    : undefined;
}
