/**
 * source/cli/src/core/node-churn.ts — PURE per-node churn counting for the advise
 * "uncovered hot spot" nomination (a node whose mapped source changes often yet
 * carries no enforced rule).
 *
 * The one impure input — the git history — is captured at the CLI boundary and
 * handed in here as ALREADY-PARSED per-commit touch sets, so this module runs git
 * nothing and touches the filesystem never. Output is deterministic given its
 * inputs (the engine's contract): the churn count and file sample depend only on
 * the touch sets and the owner resolver passed in.
 */

import path from 'node:path';
import type { Graph } from '../model/graph.js';
import { buildOwnerIndex, guardOwnerIndex } from '../relations/owner-index.js';
import { NO_COVERAGE_EXCLUDED, resolveGraphExclusionSet } from '../io/repo-scanner.js';

/** How many mapped source files to name as evidence before collapsing to a count. */
const CHURN_FILE_CAP = 5;

/** Per-node churn: window commits touching the node + a capped file sample. */
export interface NodeChurn {
  /** Number of window commits that touched at least one of the node's mapped files. */
  churn: number;
  /**
   * Up to CHURN_FILE_CAP mapped files (sorted) as evidence, then a `+N more`
   * marker when more distinct files were touched than fit — N is the TRUE overflow.
   */
  files: string[];
}

/** Resolve a repo-relative POSIX path to its owning node id, or undefined. */
export type OwnerOf = (repoRelPosix: string) => string | undefined;

/**
 * The file→node resolver churn attributes files by — the SAME owner index the
 * relation-conformance pass and coverage use, so a file's churn is charged to its
 * node exactly as every other subsystem sees ownership. This thin adapter lives in
 * the engine layer so the CLI boundary — which is not permitted to depend on the
 * relations adapter directly — can obtain the resolver through an allowed channel.
 *
 * Guarded against the graph's own exclusion set (the nested-project boundary plus
 * the adopter's `coverage.excluded` roots) — the SAME guard every other ownership
 * answer in the graph applies. A file the graph excludes must never be attributed
 * to a node's churn count or named as that node's evidence: `yg owner --file` and
 * every other ownership surface already answer "no owner" for it, and a hot-spot
 * nomination whose churn count and file sample disagreed with them would name a
 * path the adopter could look up and be told does not belong to that node.
 */
export async function ownerOfForGraph(graph: Graph): Promise<OwnerOf> {
  const projectRoot = path.dirname(graph.rootPath);
  const exclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  return guardOwnerIndex(buildOwnerIndex(graph.nodes), exclusion).ownerOf;
}

/**
 * Count, per node, how many of the given commits touched ANY of the node's mapped
 * source files, and collect a bounded sample of those files as evidence.
 *
 * `touchesByCommit` is one entry per commit: the repo-relative POSIX paths that
 * commit changed (parsed from `git log --name-only`). A commit that touches
 * several files of the SAME node counts ONCE for that node — churn is a commit
 * count, not a file-change count. Files whose owner is undefined (unmapped) are
 * ignored. The returned file list is sorted, capped at CHURN_FILE_CAP, and given a
 * trailing `+N more` marker computed from the true distinct-file count when it
 * overflows — bounded evidence that stays honest about how much it elides. A node
 * with zero attributable churn never appears in the map.
 *
 * PURE: no git, no filesystem, no clock. Deterministic given its inputs.
 */
export function countChurnByNode(
  touchesByCommit: readonly (readonly string[])[],
  ownerOf: OwnerOf,
): Map<string, NodeChurn> {
  const churn = new Map<string, number>();
  const filesByNode = new Map<string, Set<string>>();

  for (const touches of touchesByCommit) {
    const nodesThisCommit = new Set<string>();
    for (const file of touches) {
      const node = ownerOf(file);
      if (node === undefined) continue;
      nodesThisCommit.add(node);
      let set = filesByNode.get(node);
      if (set === undefined) {
        set = new Set<string>();
        filesByNode.set(node, set);
      }
      set.add(file);
    }
    // One increment per node per commit, however many of its files were touched.
    for (const node of nodesThisCommit) {
      churn.set(node, (churn.get(node) ?? 0) + 1);
    }
  }

  const out = new Map<string, NodeChurn>();
  for (const [node, count] of churn) {
    const all = [...(filesByNode.get(node) ?? new Set<string>())].sort();
    const shown = all.slice(0, CHURN_FILE_CAP);
    const extra = all.length - shown.length;
    out.set(node, { churn: count, files: extra > 0 ? [...shown, `+${extra} more`] : shown });
  }
  return out;
}

/**
 * Per-type-covered-file churn: window commits touching that ONE file. `files` is
 * always exactly `[thisFile]` — kept as an array only for rendering symmetry with
 * {@link NodeChurn} (a single-file record has nothing to sample beyond itself).
 */
export interface TypeCoveredFileChurn {
  /** Number of window commits that touched this file. */
  churn: number;
  /** Always `[thisFile]`. */
  files: string[];
}

/**
 * Count, per FILE, how many of the given commits touched it — the sibling of
 * {@link countChurnByNode} for files a node does not own.
 *
 * {@link countChurnByNode} attributes churn via `ownerOf(file)` and SILENTLY DROPS
 * every file whose owner is `undefined` (line above: `if (node === undefined)
 * continue;`) — correct for its own purpose (a node's churn), but a trap for a
 * type-covered file: EVERY type-covered file has no owning node by definition, so
 * reusing `countChurnByNode` over them always returns an empty map. That reads as
 * "no churn" when the real answer is "wrong function" — this sibling keys by the
 * file path directly (`typeCoveredFiles.has(file)`) instead of node ownership, so a
 * type-covered file's churn is counted at all.
 *
 * `typeCoveredFiles` is the CURRENT run's `computeTypeCoverage(...).covered` key
 * set — already filtered by the caller against `coverage.excluded`, nested-project
 * boundaries, and node ownership, so a file this function counts is, by
 * construction, one the graph currently classifies as type-covered and nothing
 * else. PURE: no git, no filesystem, no clock — deterministic given its inputs,
 * mirroring `countChurnByNode`'s own contract.
 */
export function countChurnByTypeCoveredFile(
  touchesByCommit: readonly (readonly string[])[],
  typeCoveredFiles: ReadonlySet<string>,
): Map<string, TypeCoveredFileChurn> {
  const churn = new Map<string, number>();

  for (const touches of touchesByCommit) {
    const filesThisCommit = new Set<string>();
    for (const file of touches) {
      if (!typeCoveredFiles.has(file)) continue;
      filesThisCommit.add(file);
    }
    // One increment per file per commit, mirroring countChurnByNode's per-node dedup
    // (defensive here too, though `git log --name-only` never repeats a path within
    // one commit's file list).
    for (const file of filesThisCommit) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }

  const out = new Map<string, TypeCoveredFileChurn>();
  for (const [file, count] of churn) {
    out.set(file, { churn: count, files: [file] });
  }
  return out;
}
