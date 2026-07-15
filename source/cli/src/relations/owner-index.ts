import type { Graph } from '../model/graph.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { mappingEntryMatchesFile, isGlobPattern, isBetterMappingOwner } from '../utils/mapping-path.js';
import { toPosixPath } from '../utils/posix.js';

export interface OwnerIndex {
  ownerOf(repoRelPosix: string): string | undefined;
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

  return {
    ownerOf(file: string): string | undefined {
      const f = toPosixPath(file.trim());
      let best: { nodePath: string; len: number } | undefined;

      for (const e of entries) {
        const hit = e.glob
          ? mappingEntryMatchesFile(e.mapping, f)
          : f === e.mapping || f.startsWith(e.mapping + '/');
        if (!hit) continue;

        if (
          !best ||
          isBetterMappingOwner(
            { nodePath: e.nodePath, mappingLen: e.mapping.length },
            { nodePath: best.nodePath, mappingLen: best.len },
          )
        ) {
          best = { nodePath: e.nodePath, len: e.mapping.length };
        }
      }

      return best?.nodePath;
    },
  };
}
