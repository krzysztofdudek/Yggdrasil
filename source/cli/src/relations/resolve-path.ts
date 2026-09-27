import { makeResolvePathToFile } from '@chrisdudek/runes/relations';
import { buildOwnerIndex } from './owner-index.js';
import { resolveGraphExclusionSet, isExcludedFromGraph, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import type { Graph } from '../model/graph.js';

/**
 * Build the production `resolvePathToFile` against the SAME exclusion set (the
 * nested-project boundary plus the adopter's own `coverage.excluded` roots)
 * `runRelationPass`'s own file enumeration and ownership re-pointing already honor.
 * Every caller that resolves an import/reference specifier fresh from source — `yg
 * check`'s live relation gate (including its hidden `--attention-dump` diagnostic) and
 * the portal's boundary computation (which backs `yg structure`'s navigation and `yg
 * advise`'s detected-edge signal) — must build `resolvePathToFile` through this
 * constructor rather than calling `makeResolvePathToFile` with a raw owner index and no
 * exclusion awareness. `yg find` never resolves an import specifier at all (it searches
 * graph documents, not code edges), so it is not among these callers.
 *
 * The per-language path resolvers themselves (`makeResolvePathToFile`) come from
 * `@chrisdudek/runes/relations`, which groups files by an injected owner lookup and knows
 * nothing of graph nodes; this wrapper is where the graph comes in. It passes the node owner
 * index together with a same-set `isExcluded` predicate: `isExcluded` drops an excluded
 * file from a package's candidate list before the owner index is ever asked about it,
 * so the split-or-single-owner decision is made from what remains — an exclusion can
 * remove its own file from consideration, never rewrite what is true of any other file.
 */
export async function guardedResolve(
  projectRoot: string,
  graph: Graph,
): Promise<(specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined> {
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const exclusion = await resolveGraphExclusionSet(projectRoot, coverage);
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const isExcluded = (repoRelPosix: string): boolean => isExcludedFromGraph(repoRelPosix, exclusion);
  return makeResolvePathToFile(projectRoot, ownerOf, isExcluded);
}
