import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ArchitectureDef, Graph, GraphNode } from '../model/graph.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import { allowedRelationTypes } from '../core/allowed-relation-types.js';
// Type-only: relations/owner-index.ts's buildOwnerIndex() call itself stays
// with the CALLER (core/fill-det.ts, which already declares a relation to
// cli/relations/core) — a whole-statement `import type` here creates no code
// edge for the relation-conformance pass to see, so this module never needs
// its own relation to relations-adapter just to spell the resolver's type.
import type { OwnerIndex } from '../relations/owner-index.js';
import { expandMappingPathsWithinOwnGraph } from '../io/hash.js';

/**
 * Computes the set of repo-relative paths a structure aspect on `nodePath`
 * is allowed to read via ctx.fs.* and ctx.graph.*:
 *   1. own mapping minus child mapping (child wins)
 *   2. declared relation target mappings + their transitive descendants
 *      (covers port owners — port is on target)
 *   3. ancestor mappings
 *   4. descendant mappings
 *
 * Mapping entries are stored as literal file or directory paths (per the
 * normalizeMappingPaths convention in io/paths.ts). Membership tests against
 * the returned set use isPathInMapping for prefix semantics.
 *
 * Child wins rule: when the parent's own mapping lists an entry in the same
 * directory as a direct child's entry, the child's entry takes precedence and
 * is excluded from the parent's allowed reads. This applies to step 1 (exact
 * matches) and step 4 (sibling carve-out for direct children). Grandchildren
 * and deeper descendants are never carved out.
 */
export function collectAllowedReadsForAspect(nodePath: string, graph: Graph): Set<string> {
  const allowed = new Set<string>();
  const node = graph.nodes.get(nodePath);
  if (!node) return allowed;

  const addMapping = (n: GraphNode): void => {
    const mapping = n.meta.mapping ?? [];
    for (const raw of mapping) {
      const p = normalizeMappingPath(raw);
      if (p) allowed.add(p);
    }
  };

  // Collect immediate children's explicit mapping entries (literal paths).
  const childPaths = new Set<string>();
  for (const child of node.children) {
    for (const raw of child.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) childPaths.add(p);
    }
  }

  // 1. Own mapping minus child mapping (child wins).
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (p && !childPaths.has(p)) allowed.add(p);
  }

  // 2. Relation targets (covers port owners) + their transitive descendants.
  for (const rel of node.meta.relations ?? []) {
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    addMapping(target);
    const relStack: GraphNode[] = [...target.children];
    while (relStack.length > 0) {
      const n = relStack.pop()!;
      addMapping(n);
      relStack.push(...n.children);
    }
  }

  // 3. Ancestors
  let cursor: GraphNode | null = node.parent;
  while (cursor) {
    addMapping(cursor);
    cursor = cursor.parent;
  }

  // Determine which child paths should be carved out: those that share a
  // directory with the parent's own mappings (sibling carve-out for "child wins").
  const parentDirs = new Set<string>();
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (p) {
      const lastSlash = p.lastIndexOf('/');
      if (lastSlash > 0) {
        parentDirs.add(p.substring(0, lastSlash));
      }
    }
  }
  const siblingCarveOut = new Set<string>();
  for (const cp of childPaths) {
    const lastSlash = cp.lastIndexOf('/');
    if (lastSlash > 0) {
      const cpDir = cp.substring(0, lastSlash);
      if (parentDirs.has(cpDir)) {
        siblingCarveOut.add(cp);
      }
    }
  }

  // 4. Descendants — child wins: skip direct-child entries that share a
  // directory with parent's own mappings (sibling carve-out). Grandchildren
  // and deeper are never carved out.
  const stack: GraphNode[] = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const raw of n.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p && !siblingCarveOut.has(p)) allowed.add(p);
    }
    stack.push(...n.children);
  }

  return allowed;
}

// ============================================================
// collectArchitectureReach — the allowance for a component-free unit
// ============================================================

/**
 * Input to {@link collectArchitectureReach}. All four fields describe ONE run's
 * worth of shared, run-constant facts — never anything that varies per pair —
 * so a caller computes this once and reuses it across every nodeless file this
 * run reviews.
 */
export interface ArchitectureReachInput {
  /** The matched type of the subject file. */
  fromType: string;
  /** file → matched type, for every file enforced by its type alone. */
  typeCovered: Map<string, string>;
  architecture: ArchitectureDef;
  graph: Graph;
  /**
   * Repo root the graph's mappings resolve against. Needed to expand a
   * declared component's directory/glob mapping entries to the real, on-disk
   * files they cover — the SAME expansion `structure/hook-loader.ts`'s
   * `buildUnitCtx` already performs for a component's own files (via
   * `expandMappingPathsWithinOwnGraph`) — so ownership can be resolved
   * file-by-file instead of trusting the raw mapping entry alone.
   */
  projectRoot: string;
  /**
   * Child-wins file-ownership resolver — the SAME authority the live type
   * gate's `fileOwnerType` is built from (`buildOwnerIndex(graph.nodes)`,
   * relations/owner-index.ts). Built by the caller (pure and graph-only, no
   * I/O — cheap to build once per run) so this module only ever needs the
   * TYPE, never a value import of the builder itself.
   */
  ownerIndex: OwnerIndex;
}

/**
 * The files a rule running on one file — with no component of its own — may
 * read. The subject file itself, plus every file whose TRUE OWNER's type the
 * subject's type is permitted to depend on under the architecture's relation
 * allow-list — whether that owner is a declared component or the file is
 * itself enforced by its type alone. There is no per-component narrowing to
 * apply here (there is no component), so the architecture's allow-list is the
 * ONLY statement of what may reach what — the SAME authority
 * {@link allowedRelationTypes} gives the live type-relation gate over derived
 * edges.
 *
 * Ownership of a declared component's mapped files is resolved with the SAME
 * child-wins authority the gate's own `fileOwnerType` is built from
 * (`buildOwnerIndex`, relations/owner-index.ts) — never the raw mapping entry
 * alone. A parent component's mapping can name a whole directory a deeper
 * child component maps one specific file inside of; textually, the parent's
 * entry covers that file too, but the child owns it (child-wins), so a type
 * permitted to depend on the PARENT's type must not thereby gain the CHILD's
 * file if the child's own type is not itself permitted. Distinguishing the two
 * requires the real, expanded, on-disk file list and the graph's ownership
 * resolution — a raw mapping entry cannot tell them apart on its own.
 *
 * `allowedRelationTypes(architecture, fromType, toType) !== []` is the
 * membership test for both a file's true-owner component type and a
 * type-covered file's matched type — any ONE permitted relation kind admits
 * the read; the exact kind is never inspected.
 *
 * `fromType` unknown to the architecture makes `allowedRelationTypes` return
 * `[]` for every target, so the reach degrades to `{ subjectFile }` alone —
 * fail-closed by construction, never a throw.
 *
 * This is a fill-time guard only, exactly like a component's own allowed-reads
 * set: it is computed once, at fill time, from the architecture and graph as
 * they stand THEN. A later narrowing of the architecture's relation allow-list
 * does not retroactively invalidate an already-stored result — nothing that
 * was actually observed changed. There is no continuous re-enforcement of this
 * boundary the way `yg check` continuously re-verifies a live import graph.
 */
export async function collectArchitectureReach(subjectFile: string, input: ArchitectureReachInput): Promise<Set<string>> {
  const { fromType, typeCovered, architecture, graph, projectRoot, ownerIndex } = input;
  const reach = new Set<string>([subjectFile]);

  // Declared components. Only a node whose OWN type this fromType may depend
  // on is worth expanding — a node of an unreachable type contributes nothing:
  // any file ownerIndex later attributes to IT is excluded regardless, and any
  // file a DEEPER, reachable descendant genuinely owns is independently
  // discovered when THIS SAME loop reaches that descendant's own entry (every
  // node in the graph is visited, not just direct children).
  for (const node of graph.nodes.values()) {
    if (allowedRelationTypes(architecture, fromType, node.meta.type).length === 0) continue;
    const rawMapping = (node.meta.mapping ?? [])
      .map(normalizeMappingPath)
      .filter((p): p is string => p !== '');
    if (rawMapping.length === 0) continue;
    // A separate project's own subtree (a directory carrying its own
    // `.yggdrasil/` graph, or its own `.git` checkout/submodule/worktree) is
    // dropped here too: a foreign file must never earn a reach entry just
    // because the enumerating node's mapping happens to contain it — that
    // file belongs to, and is governed by, a different project entirely.
    const expanded = await expandMappingPathsWithinOwnGraph(projectRoot, rawMapping);
    for (const file of expanded) {
      // Re-resolve the file's TRUE owner (child-wins) — never assume the
      // enumerating node still owns it once expanded to a real path.
      const ownerPath = ownerIndex.ownerOf(file);
      const ownerNode = ownerPath !== undefined ? graph.nodes.get(ownerPath) : undefined;
      if (!ownerNode) continue;
      if (allowedRelationTypes(architecture, fromType, ownerNode.meta.type).length === 0) continue;
      // Mirror the live dependency gate's own enumeration (relations/pass.ts):
      // a mapped file it cannot read is skipped BEFORE it ever earns an
      // owner-type entry in fileOwnerType, so the gate treats it as though it
      // does not exist. Admitting it into this allowance anyway would be a
      // needless divergence from the one authority (child-wins ownership +
      // the architecture's relations:) this allowance exists to mirror — even
      // though an actual ctx.fs.read would fail regardless (conservative
      // either way).
      try {
        await readFile(path.join(projectRoot, file), 'utf-8');
      } catch {
        continue;
      }
      reach.add(file);
    }
  }

  // Other files enforced by their type alone (no component of their own) — a
  // pure map lookup: computeTypeCoverage has already established each entry is
  // a real, individually-classified file, so no expansion is needed here.
  for (const [file, toType] of typeCovered) {
    if (allowedRelationTypes(architecture, fromType, toType).length === 0) continue;
    reach.add(file);
  }

  return reach;
}
