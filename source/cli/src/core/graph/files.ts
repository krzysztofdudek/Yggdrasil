/**
 * Graph file-path helpers: questions about where a file sits relative to the
 * graph's mappings.
 */
import type { Graph } from '../../model/graph.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { toPosixPath } from '../../utils/posix.js';

/** A component that maps files in the same directory as a file no component owns. */
export interface CandidateOwner {
  nodePath: string;
  /** How many of its mapping entries sit in that directory. */
  fileCount: number;
}

/**
 * The components whose mapping a file no component owns most likely belongs
 * in: those that map other entries in the same directory, most entries first.
 * Empty when nothing in that directory is mapped — the answer is then a new
 * component, not an existing one. `yg context --file` and `yg owner --file`
 * both name these, so the two never suggest different owners.
 */
export function findCandidateOwners(graph: Graph, unmappedFile: string): CandidateOwner[] {
  // Normalized first so the directory compares like-for-like against the
  // POSIX-normalized mapping directories below.
  const normalized = toPosixPath(unmappedFile);
  const dir = normalized.replace(/\/[^/]+$/, '');
  if (!dir || dir === normalized) return [];

  const candidates = new Map<string, number>();
  for (const [nodePath, node] of graph.nodes) {
    let inDir = 0;
    for (const mp of normalizeMappingPaths(node.meta.mapping)) {
      if (toPosixPath(mp).replace(/\/[^/]+$/, '') === dir) inDir++;
    }
    if (inDir > 0) candidates.set(nodePath, inDir);
  }
  return Array.from(candidates.entries())
    .map(([nodePath, fileCount]) => ({ nodePath, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.nodePath.localeCompare(b.nodePath, 'en'));
}
