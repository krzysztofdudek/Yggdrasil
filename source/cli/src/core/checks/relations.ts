import type { Graph } from '../../model/graph.js';
import type { ValidationIssue } from '../../model/validation.js';
import { issueMsg } from './shared.js';
import { toPosixPath } from '../../utils/posix.js';

// --- Rule 1: Relation targets exist ---

function findSimilar(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const c of candidates) {
    if (c === target) return c;
    // Simple similarity: shared path segments
    const targetParts = target.split('/');
    const candParts = c.split('/');
    let score = 0;
    for (let i = 0; i < Math.min(targetParts.length, candParts.length); i++) {
      if (targetParts[i] === candParts[i]) score++;
      else break;
    }
    if (score > bestScore && score > 0) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function checkRelationTargets(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = [...graph.nodes.keys()];
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) {
        const suggestion = findSimilar(rel.target, nodePaths);
        const parts = rel.target.split('/');
        const parentPrefix = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
        const existingInParent = nodePaths
          .filter((p) => p.startsWith(parentPrefix) && p !== rel.target)
          .map((p) => {
            const rest = p.slice(parentPrefix.length);
            return rest.split('/')[0];
          })
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        const parentDisplay = (parentPrefix || 'model/').replace(/\/$/, '');
        // Plain sentences, no layout: the renderer decides indentation. The
        // sibling list is capped so a wide parent cannot turn one finding into
        // a paragraph of names.
        const SIBLING_CAP = 12;
        const siblings = existingInParent.length > SIBLING_CAP
          ? `${existingInParent.slice(0, SIBLING_CAP).join(', ')}, … (${existingInParent.length} in all)`
          : existingInParent.join(', ');
        const existingSentence = existingInParent.length > 0 ? ` Nodes under ${parentDisplay}: ${siblings}.` : '';
        // A suggestion that is only the target's own parent (the closest match
        // for any missing child) is no suggestion; offer a real near-miss only.
        const parentPath = parentPrefix.replace(/\/$/, '');
        const hint = suggestion && suggestion !== parentPath ? ` (did you mean '${suggestion}'?)` : '';
        issues.push({
          severity: 'error',
          code: 'relation-broken',
          rule: 'broken-relation',
          ...issueMsg({
            what: `Relation target '${rel.target}' does not exist.`,
            why: `This node declares a dependency on a node the graph does not contain, so the relation cannot be checked.${existingSentence}`,
            next: `Correct the target in .yggdrasil/model/${toPosixPath(nodePath)}/yg-node.yaml relations${hint}, or remove the relation.`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 4: No circular dependencies ---

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const CYCLE_MEMBER_CAP = 12;

/**
 * Strongly connected components of the structural-relation graph (Tarjan,
 * iterative so a deep graph cannot overflow the stack). Returns only the
 * cyclic ones: more than one member, or one member relating to itself. Members
 * are sorted, and components are ordered by their first member, so the report
 * is stable run to run.
 */
export function structuralCycleComponents(graph: Graph): string[][] {
  const edges = new Map<string, string[]>();
  for (const [nodePath, node] of graph.nodes) {
    const targets: string[] = [];
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_RELATION_TYPES.has(rel.type)) continue;
      if (!graph.nodes.has(rel.target)) continue;
      targets.push(rel.target);
    }
    edges.set(nodePath, targets);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of graph.nodes.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = edges.get(frame.node)!;
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter++;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.node);
        const selfLoop = members.length === 1 && edges.get(members[0]!)!.includes(members[0]!);
        if (members.length > 1 || selfLoop) components.push(members.sort());
      }
    }
  }
  return components.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

/** The shortest cycle through the component's first member, staying inside the component. */
function shortestCycleIn(graph: Graph, members: string[]): string[] {
  const inside = new Set(members);
  const start = members[0]!;
  const targetsOf = (n: string): string[] =>
    (graph.nodes.get(n)?.meta.relations ?? [])
      .filter((r) => STRUCTURAL_RELATION_TYPES.has(r.type) && inside.has(r.target))
      .map((r) => r.target);
  const prev = new Map<string, string>();
  const queue: string[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    for (const t of targetsOf(n)) {
      if (t === start) {
        const pathBack: string[] = [n];
        let cur = n;
        while (cur !== start) {
          cur = prev.get(cur)!;
          pathBack.push(cur);
        }
        return [...pathBack.reverse(), start];
      }
      if (!prev.has(t)) {
        prev.set(t, n);
        queue.push(t);
      }
    }
  }
  return [start, start];
}

function formatCycle(cycle: string[]): string {
  const hops = cycle.length - 1;
  if (hops <= CYCLE_MEMBER_CAP) return cycle.join(' -> ');
  return `${cycle.slice(0, CYCLE_MEMBER_CAP).join(' -> ')} -> … -> ${cycle[cycle.length - 1]!} (${hops} hops)`;
}

export function checkNoCycles(graph: Graph): ValidationIssue[] {
  // One finding per strongly connected component, not per DFS path: the
  // component is what has to be untangled, and a DFS path carried the walk's
  // non-cycle prefix, so the reader chased hops that were never in a cycle.
  // The members travel on the issue (cycleMembers) so `yg context` blocks only
  // the nodes the cycle actually touches, not every node in the repository.
  return structuralCycleComponents(graph).map((members) => {
    const cycle = shortestCycleIn(graph, members);
    const shown = members.length > CYCLE_MEMBER_CAP
      ? `${members.slice(0, CYCLE_MEMBER_CAP).join(', ')}, … (${members.length} in all)`
      : members.join(', ');
    const what = members.length === cycle.length - 1
      ? `Circular dependency: ${formatCycle(cycle)}.`
      : `Circular dependency among ${members.length} nodes (${shown}); one cycle through them: ${formatCycle(cycle)}. The error clears when no structural relation leads back into the group.`;
    return {
      severity: 'error' as const,
      code: 'structural-cycle',
      rule: 'structural-cycle',
      ...issueMsg({
        what,
        why: `Cycles prevent deterministic context assembly and cascade tracking.`,
        next: `Break the cycle: extract a shared interface, invert a dependency, or merge nodes.`,
      }),
      cycleMembers: members,
    };
  });
}

// --- flow-node-broken: Broken flow refs (flow.nodes) ---

export function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  for (const flow of graph.flows) {
    for (const n of flow.nodes) {
      if (!nodePaths.has(n)) {
        // A participant whose yg-node.yaml did not parse is not missing — it
        // failed to load. Name that, and send the reader to the file that
        // actually needs fixing, never to "create the missing node".
        const failedToLoad = (graph.nodeParseErrors ?? []).some((e) => e.nodePath === n);
        issues.push({
          severity: 'error',
          code: 'flow-node-broken',
          rule: 'broken-flow-ref',
          ...issueMsg(failedToLoad
            ? {
                what: `Flow '${flow.name}' names node '${n}', whose yg-node.yaml did not parse.`,
                why: `The component was not loaded, so the flow cannot resolve it — a symptom of the yaml-invalid error on '${n}', not a missing node.`,
                next: `Fix the YAML in .yggdrasil/model/${n}/yg-node.yaml; the flow resolves once the component loads.`,
              }
            : {
                what: `Flow '${flow.name}' references non-existent node '${n}'.`,
                why: `Flow participants must exist in the graph.`,
                next: `Fix the nodes list in yg-flow.yaml or create the missing node.`,
              }),
        });
      }
    }
  }
  return issues;
}

// --- high-fan-out: Exceeds max_direct_relations ---

export function checkHighFanOut(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const globalMax = graph.config.quality?.max_direct_relations ?? 10;
  for (const [nodePath, node] of graph.nodes) {
    const count = node.meta.relations?.length ?? 0;
    // A node may declare its OWN ceiling (with a recorded justification) in its
    // yg-node.yaml, which REPLACES the global default for that node — the declared
    // limit may be HIGHER (a deliberate single-responsibility seam) or LOWER (a
    // stricter per-node budget) than the global. The global default governs every
    // node WITHOUT an override, and a node still warns when it exceeds its OWN
    // declared ceiling — the allowance sanctions a specific, reviewed count, it
    // does not silence genuine over-connection.
    const maxRel = node.meta.maxDirectRelations?.limit ?? globalMax;
    if (count > maxRel) {
      issues.push({
        severity: 'warning',
        code: 'high-fan-out',
        rule: 'high-fan-out',
        ...issueMsg({
          what: `Node has ${count} direct relations (max: ${maxRel}).`,
          why: `High fan-out makes context packages large and suggests unclear separation of concerns.`,
          next: `Consider splitting responsibilities or introducing an intermediary node.`,
        }),
        nodePath,
      });
    }
  }
  return issues;
}

// --- unpaired-event: Unpaired event relations (emits without listens or vice versa) ---

export function checkUnpairedEvents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const emitsTo = new Map<string, Set<string>>();
  const listensFrom = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (rel.type === 'emits') {
        const set = emitsTo.get(nodePath) ?? new Set();
        set.add(rel.target);
        emitsTo.set(nodePath, set);
      }
      if (rel.type === 'listens') {
        const set = listensFrom.get(nodePath) ?? new Set();
        set.add(rel.target);
        listensFrom.set(nodePath, set);
      }
    }
  }
  for (const [emitter, targets] of emitsTo) {
    for (const target of targets) {
      const listenerSet = listensFrom.get(target);
      if (!listenerSet?.has(emitter)) {
        issues.push({
          severity: 'error',
          code: 'event-unpaired',
          rule: 'unpaired-event',
          ...issueMsg({
            what: `Node '${emitter}' emits to '${target}' but '${target}' has no listens from '${emitter}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
          nodePath: emitter,
        });
      }
    }
  }
  for (const [listener, sources] of listensFrom) {
    for (const source of sources) {
      const emitterSet = emitsTo.get(source);
      if (!emitterSet?.has(listener)) {
        issues.push({
          severity: 'error',
          code: 'event-unpaired',
          rule: 'unpaired-event',
          ...issueMsg({
            what: `Node '${listener}' listens from '${source}' but '${source}' has no emits to '${listener}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
          nodePath: listener,
        });
      }
    }
  }
  return issues;
}

// --- missing-description: Missing description on nodes, aspects, and flows ---

export function checkMissingDescriptions(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Node has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-node.yaml.`,
        }),
        nodePath,
      });
    }
  }

  // Aspects
  for (const aspect of graph.aspects) {
    if (!aspect.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Aspect '${aspect.id}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-aspect.yaml.`,
        }),
        aspectId: aspect.id,
      });
    }

  }

  // Flows
  for (const flow of graph.flows) {
    if (!flow.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Flow '${flow.name}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-flow.yaml.`,
        }),
        flowName: flow.name,
      });
    }
  }

  return issues;
}

