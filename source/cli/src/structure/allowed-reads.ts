import type { ArchitectureDef, Graph, GraphNode } from '../model/graph.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import { allowedRelationTypes } from '../core/allowed-relation-types.js';

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
}

/**
 * The files a rule running on one file — with no component of its own — may
 * read. The subject file itself, plus every file whose type the subject's type
 * is permitted to depend on under the architecture's relation allow-list —
 * whether that file belongs to a declared component or is itself enforced by
 * its type alone. There is no per-component narrowing to apply here (there is
 * no component), so the architecture's allow-list is the ONLY statement of
 * what may reach what — the SAME authority {@link allowedRelationTypes} gives
 * the live type-relation gate over derived edges.
 *
 * `allowedRelationTypes(architecture, fromType, toType) !== []` is the
 * membership test for both declared-component targets (`toType` = the
 * component's own node type) and other type-covered files (`toType` = the
 * file's matched type) — any ONE permitted relation kind admits the read; the
 * exact kind is never inspected.
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
export function collectArchitectureReach(subjectFile: string, input: ArchitectureReachInput): Set<string> {
  const { fromType, typeCovered, architecture, graph } = input;
  const reach = new Set<string>([subjectFile]);

  // Declared components: every file of a component whose own node type this
  // subject's type may depend on (any permitted relation kind admits it).
  for (const node of graph.nodes.values()) {
    const toType = node.meta.type;
    if (allowedRelationTypes(architecture, fromType, toType).length === 0) continue;
    for (const raw of node.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) reach.add(p);
    }
  }

  // Other files enforced by their type alone (no component of their own).
  for (const [file, toType] of typeCovered) {
    if (allowedRelationTypes(architecture, fromType, toType).length === 0) continue;
    reach.add(file);
  }

  return reach;
}
