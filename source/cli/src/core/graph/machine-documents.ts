import type { Graph, PortDef, Relation } from '../../model/graph.js';
import { IMPACT_JSON_SCHEMA } from '../../formatters/impact-json.js';
import type {
  ImpactJsonDocument,
  ImpactJsonDependent,
  ImpactJsonDependentRelation,
  ImpactJsonPort,
  ImpactJsonPortConsumer,
} from '../../formatters/impact-json.js';
import { NODE_JSON_SCHEMA } from '../../formatters/node-json.js';
import type { NodeJsonDocument, NodeJsonPort, NodeJsonRelation } from '../../formatters/node-json.js';
import { collectReverseDependents, buildTransitivePaths } from './impact-graph.js';
import { toPosixPath } from '../../utils/posix.js';

/**
 * The graph's own machine documents — the versioned JSON forms of "what depends
 * on this component" (`yg-impact/1`) and "what IS this component" (`yg-node/1`).
 *
 * Both are assembled here, in the engine, from the SAME graph queries the text
 * views use: reverse dependency and transitive reach come from `impact-graph.ts`
 * and nothing recomputes them a second way, so a machine consumer and a reading
 * agent can never be told two different things about one graph. Presentation
 * (the JSON serialization itself) stays in the formatters, which also own the
 * document types and the schema constants.
 */

/**
 * A port's declared contract version, or null when it declares none.
 *
 * The DECLARED value, deliberately — not the version the contract check reads a
 * versionless port at. A consumer pinning to a version is reading what the port
 * says about itself, and a number the port never wrote would be a claim it never
 * made.
 */
function portVersion(port: PortDef): number | null {
  return port.version ?? null;
}

/** A port's declared contract test, repo-relative POSIX, or null when it declares none. */
function portTest(port: PortDef): string | null {
  return port.test === undefined ? null : toPosixPath(port.test);
}

/**
 * Every component that consumes `portName` from `nodePath`, in graph order.
 *
 * A port is consumed through the `consumes:` list on a relation, and that list
 * is legal on EVERY relation type — so this walks all declared relations rather
 * than the structural subset the dependency algorithms use. A component that
 * reaches the subject only through an event relation is therefore still counted
 * as a consumer of the contract it names.
 */
function collectPortConsumers(graph: Graph, nodePath: string, portName: string): ImpactJsonPortConsumer[] {
  const consumers: ImpactJsonPortConsumer[] = [];
  for (const [candidatePath, candidate] of graph.nodes) {
    for (const rel of candidate.meta.relations ?? []) {
      if (rel.target !== nodePath) continue;
      if (!rel.consumes?.includes(portName)) continue;
      consumers.push({ node: candidatePath, relation: rel.type });
    }
  }
  return consumers.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}

/** The relations `dependentPath` itself declares onto `nodePath`, with the ports each names. */
function relationsOnto(graph: Graph, dependentPath: string, nodePath: string): ImpactJsonDependentRelation[] {
  const dependent = graph.nodes.get(dependentPath);
  if (!dependent) return [];
  const out: ImpactJsonDependentRelation[] = [];
  for (const rel of dependent.meta.relations ?? []) {
    if (rel.target !== nodePath) continue;
    out.push({ type: rel.type, ports: [...(rel.consumes ?? [])] });
  }
  return out;
}

/**
 * The `yg-impact/1` document for one component.
 *
 * `dependents` is the reverse-dependency closure over the STRUCTURAL relation
 * types — the same set the text view lists as directly and transitively
 * dependent — with `direct` distinguishing a declared edge onto the subject
 * from one reached through other components. `transitive` re-states the
 * indirect half with the path it travels, so a consumer that only wants the
 * chains does not have to reconstruct them.
 *
 * The caller guarantees `nodePath` names a node in `graph`.
 */
export function buildImpactDocument(graph: Graph, nodePath: string): ImpactJsonDocument {
  const node = graph.nodes.get(nodePath)!;
  const { direct, allDependents, reverse } = collectReverseDependents(graph, nodePath);
  const directSet = new Set(direct);

  const ports: ImpactJsonPort[] = Object.entries(node.meta.ports ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, port]) => ({
      name,
      version: portVersion(port),
      test: portTest(port),
      consumers: collectPortConsumers(graph, nodePath, name),
    }));

  const dependents: ImpactJsonDependent[] = allDependents.map((dependentPath) => ({
    node: dependentPath,
    direct: directSet.has(dependentPath),
    relations: relationsOnto(graph, dependentPath, nodePath),
  }));

  const transitive = buildTransitivePaths(nodePath, direct, allDependents, reverse).map(({ node: n, via }) => ({
    node: n,
    via: [...via],
  }));

  return {
    schema: IMPACT_JSON_SCHEMA,
    subject: { kind: 'node', path: nodePath },
    ports,
    dependents,
    transitive,
  };
}

/** One declared port, in machine form. */
function nodeJsonPort(port: PortDef): NodeJsonPort {
  return {
    description: port.description,
    version: portVersion(port),
    test: portTest(port),
    aspects: [...(port.aspects ?? [])],
  };
}

/** One declared relation, in machine form. */
function nodeJsonRelation(relation: Relation): NodeJsonRelation {
  const out: NodeJsonRelation = {
    target: relation.target,
    type: relation.type,
    consumes: [...(relation.consumes ?? [])],
  };
  if (relation.event_name !== undefined) out.event_name = relation.event_name;
  return out;
}

/**
 * The `yg-node/1` document for one component — structure only.
 *
 * Rules are deliberately absent: what a subject must satisfy is the context
 * package's answer (`yg context --json`), assembled from the full seven-channel
 * cascade. A port's `aspects` list is NOT that — it is the contract the port
 * itself declares onto its consumers, part of the component's structure.
 *
 * The caller guarantees `nodePath` names a node in `graph`.
 */
export function buildNodeDocument(graph: Graph, nodePath: string): NodeJsonDocument {
  const node = graph.nodes.get(nodePath)!;
  const ports: Record<string, NodeJsonPort> = {};
  for (const [name, port] of Object.entries(node.meta.ports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    ports[name] = nodeJsonPort(port);
  }

  return {
    schema: NODE_JSON_SCHEMA,
    path: nodePath,
    name: node.meta.name,
    type: node.meta.type,
    description: node.meta.description ?? '',
    mapping: (node.meta.mapping ?? []).map((entry) => toPosixPath(entry)),
    relations: (node.meta.relations ?? []).map(nodeJsonRelation),
    ports,
    children: node.children.map((child) => child.path).sort(),
    parent: node.parent ? node.parent.path : null,
  };
}
