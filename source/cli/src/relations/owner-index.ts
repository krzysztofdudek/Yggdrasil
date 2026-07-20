import type { Graph } from '../model/graph.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { mappingEntryMatchesFile, isGlobPattern, isBetterMappingOwner } from '../utils/mapping-path.js';
import { toPosixPath } from '../utils/posix.js';

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
