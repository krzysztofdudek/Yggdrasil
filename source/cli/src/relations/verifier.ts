export interface ResolvedDep { fromFile: string; line: number; ownerNode: string }
export interface RelationGraphView {
  isAncestorOf(a: string, b: string): boolean;     // true if a is a STRICT ancestor of b
  declaredTargets(nodeId: string): Set<string>;     // targets of the STRUCTURAL relations declared on nodeId
  parentChain(nodeId: string): string[];            // ancestors of nodeId
}
export interface Violation { fromFile: string; line: number; ownerNode: string }

export function verifyNodeDeps(nodeId: string, deps: ResolvedDep[], g: RelationGraphView): Violation[] {
  const out: Violation[] = [];
  const declared = g.declaredTargets(nodeId);
  for (const d of deps) {
    const m = d.ownerNode;
    if (m === nodeId) continue;                                            // intra-node
    if (g.isAncestorOf(m, nodeId) || g.isAncestorOf(nodeId, m)) continue;  // ancestor/descendant
    if (declared.has(m)) continue;                                         // direct relation
    if (g.parentChain(m).some((anc) => declared.has(anc))) continue;       // relation to an ancestor of M sanctions
    out.push({ fromFile: d.fromFile, line: d.line, ownerNode: m });
  }
  return out;
}
