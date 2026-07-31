import type { Graph } from '../model/graph.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { mappingEntryMatchesFile, isGlobPattern, isBetterMappingOwner } from '../utils/mapping-path.js';
import { toPosixPath } from '../utils/posix.js';
import { isExcludedFromGraph, type GraphExclusionSet } from '../io/repo-scanner.js';

/**
 * How the winning mapping entry matched the file:
 *   - 'exact'     — a non-glob entry equal to the file path.
 *   - 'directory' — a non-glob entry that is a directory prefix of the file
 *                   (`file.startsWith(entry + '/')`).
 *   - 'glob'      — a glob entry (`isGlobPattern`) that matched the file.
 */
export interface OwnerEntry {
  nodePath: string;
  mapping: string;
  kind: 'exact' | 'directory' | 'glob';
}

export interface OwnerIndex {
  ownerOf(repoRelPosix: string): string | undefined;
  ownerEntryOf(repoRelPosix: string): OwnerEntry | undefined;
}

export function buildOwnerIndex(nodes: Graph['nodes']): OwnerIndex {
  const entries: Array<{ nodePath: string; mapping: string; glob: boolean }> = [];

  for (const [nodePath, node] of nodes) {
    for (const m of normalizeMappingPaths(node.meta.mapping)
      .map((s) => toPosixPath(s.trim()))
      .filter((s) => s.length > 0)) {
      entries.push({ nodePath, mapping: m, glob: isGlobPattern(m) });
    }
  }

  function ownerEntryOf(file: string): OwnerEntry | undefined {
    const f = toPosixPath(file.trim());
    let best: { nodePath: string; mapping: string; len: number; kind: OwnerEntry['kind'] } | undefined;

    for (const e of entries) {
      // Classify the match kind and hit together — the same predicate ownerOf
      // used, split by which branch matched so presentation callers can render
      // exact / directory / glob without re-deriving it.
      let kind: OwnerEntry['kind'];
      let hit: boolean;
      if (e.glob) {
        hit = mappingEntryMatchesFile(e.mapping, f);
        kind = 'glob';
      } else if (f === e.mapping) {
        hit = true;
        kind = 'exact';
      } else {
        hit = f.startsWith(e.mapping + '/');
        kind = 'directory';
      }
      if (!hit) continue;

      if (
        !best ||
        isBetterMappingOwner(
          { nodePath: e.nodePath, mappingLen: e.mapping.length },
          { nodePath: best.nodePath, mappingLen: best.len },
        )
      ) {
        best = { nodePath: e.nodePath, mapping: e.mapping, len: e.mapping.length, kind };
      }
    }

    return best ? { nodePath: best.nodePath, mapping: best.mapping, kind: best.kind } : undefined;
  }

  return {
    // Thin node-only accessor — re-expressed through ownerEntryOf so the two can
    // never diverge on which node wins.
    ownerOf(file: string): string | undefined {
      return ownerEntryOf(file)?.nodePath;
    },
    ownerEntryOf,
  };
}

/**
 * Wrap an `OwnerIndex` so a query for an EXCLUDED path (a nested project's own
 * boundary, or a `coverage.excluded` root) answers "no owner" — same as a
 * genuinely unmapped path — instead of the textual match a node's mapping
 * happens to sweep it in with. `buildOwnerIndex` itself stays the raw,
 * config-free text matcher it has always been: most callers legitimately need
 * it unguarded, because they only ever query it with a path ALREADY known to
 * be non-excluded (e.g. re-pointing a file the dependency-conformance pass has
 * already enumerated through the exclusion-guarded expansion to its true
 * child-precedence owner). This wrapper is for the other kind of caller — one
 * that hands the index a path it has NOT already filtered, such as an
 * import/reference TARGET resolved fresh from source, which can name any file
 * on disk, excluded or not, and must answer ownership questions the same way
 * every other exclusion-aware surface in the graph does.
 */
export function guardOwnerIndex(index: OwnerIndex, exclusion: GraphExclusionSet): OwnerIndex {
  return {
    ownerOf(repoRelPosix: string): string | undefined {
      if (isExcludedFromGraph(repoRelPosix, exclusion)) return undefined;
      return index.ownerOf(repoRelPosix);
    },
    ownerEntryOf(repoRelPosix: string): OwnerEntry | undefined {
      if (isExcludedFromGraph(repoRelPosix, exclusion)) return undefined;
      return index.ownerEntryOf(repoRelPosix);
    },
  };
}
