import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type { FileContentCache } from '../io/file-content-cache.js';
import { classifyFile } from './type-classifier.js';
import { normalizeRoot, matchesRoot } from './check-coverage-tiers.js';

/**
 * Result of classifying every uncovered file against the type-level
 * classification lattice (coverage.type_level). Each file lands in exactly one
 * bucket, or in none at all when it sits under a coverage.excluded root.
 */
export interface TypeCoverageResult {
  /** File → the single non-strict type it matched. Satisfied for coverage purposes. */
  covered: Map<string, string>;
  /** 2+ non-strict types matched, no strict type — the caller turns this into ambiguous-node-type. */
  ambiguous: Array<{ file: string; typeIds: string[] }>;
  /**
   * >=1 strict type matched. The strict backward scan (checkStrictBackwardCoverage)
   * already owns this file — type-strict-orphan, type-strict-misplaced, or (when
   * 2+ strict types match) strict-overlap-conflict — so the lattice must never
   * additionally call it ambiguous or covered.
   */
  strictClaimed: Array<{ file: string; strictTypeId: string; alsoMatches: string[] }>;
  /** No type matched at all — falls through to the ordinary unmapped-files path. */
  unmatched: string[];
  /**
   * A matching type's `when` could not be evaluated on this file (e.g. a
   * content predicate on an oversized file) — one entry PER FILE (not per
   * type: every unreadable type on the same file shares the same underlying
   * FileContentCache read, so the readability verdict — and therefore
   * `reason`/`kind` — is identical across all of them; `typeIds` names every
   * type that could not be evaluated).
   */
  unreadable: Array<{ file: string; typeIds: string[]; reason: string; kind: 'read' | 'too-large' }>;
}

/**
 * Compute the type-level classification lattice over a list of already-
 * uncovered files (files no node mapping owns). Pure: the only I/O is file
 * content reads performed through classifyFile/FileContentCache — no other
 * filesystem or network access, and no writes.
 *
 * For each file, in order:
 *   1. Under a coverage.excluded root -> skipped ENTIRELY. Not classified at
 *      all — contributes to none of the five buckets, exactly like it
 *      contributes to no other coverage issue today.
 *   2. classifyFile reports >=1 type whose `when` could not be evaluated
 *      (e.g. a content predicate on a file over the 5MB scan limit) ->
 *      `unreadable` (one entry per FILE, naming every unreadable type). The file is never
 *      silently treated as covered, ambiguous, or unmatched on the strength
 *      of whatever else it might have matched — mirroring the strict
 *      backward scan's own fail-closed handling of an unreadable file.
 *   3. >=1 STRICT type matched -> `strictClaimed`. Whether that is exactly
 *      one strict match or two-or-more (an architecture-level strict-overlap
 *      conflict) is the strict backward scan's own concern; either way this
 *      lattice must not also call the file ambiguous or covered.
 *   4. Exactly one non-strict type matched (no strict match) -> `covered`.
 *   5. 2+ non-strict types matched (no strict match) -> `ambiguous`.
 *   6. No type matched at all -> `unmatched`.
 *
 * Caller contract: invoke only when graph.config.coverage?.typeLevel is true
 * (coverage.type_level is committed-only — see CoverageConfig.typeLevel); with
 * the flag off, callers never reach this function, so classification cost and
 * the `.yggdrasil/`-auto-exempt behavior classifyFile already applies (routed
 * through here on every call — never bypassed) are paid only when opted in.
 */
export async function computeTypeCoverage(
  graph: Graph,
  uncoveredFiles: string[],
  cache: FileContentCache,
): Promise<TypeCoverageResult> {
  const result: TypeCoverageResult = {
    covered: new Map(),
    ambiguous: [],
    strictClaimed: [],
    unmatched: [],
    unreadable: [],
  };

  const excludedRoots = (graph.config.coverage?.excluded ?? []).map(normalizeRoot);
  const projectRoot = path.dirname(graph.rootPath);

  for (const file of uncoveredFiles) {
    if (excludedRoots.some((r) => matchesRoot(file, r))) continue;

    const absPath = path.join(projectRoot, file);
    const classification = await classifyFile(absPath, file, graph, cache);

    if (classification.unreadable.length > 0) {
      const [first] = classification.unreadable;
      result.unreadable.push({
        file,
        typeIds: classification.unreadable.map((u) => u.typeId),
        reason: first.reason,
        kind: first.kind,
      });
      continue;
    }

    const strictMatches = classification.matches.filter(
      (m) => graph.architecture.node_types[m.typeId]?.enforce === 'strict',
    );
    if (strictMatches.length > 0) {
      const alsoMatches = classification.matches
        .filter((m) => graph.architecture.node_types[m.typeId]?.enforce !== 'strict')
        .map((m) => m.typeId);
      result.strictClaimed.push({ file, strictTypeId: strictMatches[0].typeId, alsoMatches });
      continue;
    }

    if (classification.matches.length === 1) {
      result.covered.set(file, classification.matches[0].typeId);
    } else if (classification.matches.length >= 2) {
      result.ambiguous.push({ file, typeIds: classification.matches.map((m) => m.typeId) });
    } else {
      result.unmatched.push(file);
    }
  }

  return result;
}
