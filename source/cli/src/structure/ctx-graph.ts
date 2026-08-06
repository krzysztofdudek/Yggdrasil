import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { GraphNode, Relation, File, Port } from './types.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import type { ObservationRecorder } from './observations.js';

export class UndeclaredGraphReadError extends Error {
  constructor(public readonly nodePath: string) {
    super(`structure-aspect-undeclared-graph-read: ${nodePath}`);
    this.name = 'UndeclaredGraphReadError';
  }
}

/**
 * Thrown by every method of the nodeless `ctx.graph` (a unit reviewing a file
 * enforced by its architecture type alone, with no owning component) and by
 * the nodeless `ctx.node` Proxy in hook-loader.ts. `member` names the accessed
 * property/method (e.g. `'graph.node'`, `'node.type'`) so the boundary
 * translation (structure/runner.ts) can build one specific message naming it.
 *
 * A local class, not `StructureRunnerError` itself: `StructureRunnerError`
 * lives in hook-loader.ts, which already imports FROM this module — importing
 * it back here would create the exact circular import hook-loader.ts's own
 * comment on `StructureRunnerError` was written to avoid. Mirrors
 * `UndeclaredGraphReadError` above: a local error class thrown from the ctx
 * layer, translated to a typed `StructureRunnerError` at the runner boundary.
 */
export class StructureNodeContextUnavailableError extends Error {
  constructor(public readonly member: string) {
    super(`structure-node-context-unavailable: ${member}`);
    this.name = 'StructureNodeContextUnavailableError';
  }
}

/**
 * Build a File view of a graph-reachable node's mapped file whose `content` is
 * available immediately but whose read: OBSERVATION is folded LAZILY — recorded
 * only the first time the check reads `.content`. This is the invalidation-width
 * fix: a check that inspects only `.path` (e.g. enumerating sibling files by
 * name) must not fold every sibling's bytes into its deterministic verdict, so a
 * later edit to a never-read sibling does not needlessly re-verify it. A check
 * that DOES read `.content` still folds it byte-symmetrically (`bytes` is the raw
 * disk content the verifier re-observes), so no content-dependent verdict can go
 * stale-green. Subject files (already hashed as subject inputs) and the no-
 * recorder case get a plain content property — nothing to defer. Mirrors
 * wrapNonSubjectFile in structure/hook-loader.ts.
 */
function makeGraphFile(
  repoRelPosixPath: string,
  content: string,
  bytes: Buffer,
  recorder: ObservationRecorder | undefined,
  subjectFiles: Set<string> | undefined,
): File {
  if (!recorder || subjectFiles?.has(repoRelPosixPath)) {
    return { path: repoRelPosixPath, content };
  }
  const rec = recorder;
  let recorded = false;
  const file = { path: repoRelPosixPath } as File;
  Object.defineProperty(file, 'content', {
    enumerable: true,
    configurable: true,
    get(): string {
      if (!recorded) {
        rec.recordRead(repoRelPosixPath, bytes);
        recorded = true;
      }
      return content;
    },
  });
  return file;
}

export interface CtxGraphParams {
  currentNodePath: string;
  graph: Graph;
  projectRoot: string;
  /** mutable touched files list */
  touchedFiles: string[];
  /**
   * Per-node concrete file paths (repo-relative, POSIX), pre-expanded by the
   * async runner so directory and glob mapping entries resolve to real files.
   * Keyed by node path. When absent for a node, toPublicNode falls back to the
   * raw mapping entries (file-only, no glob/dir expansion). Each file's read:
   * observation folds LAZILY (only when the check reads `.content`), so a check
   * that inspects only `.path` does not widen its verdict's invalidation.
   */
  expandedFilesByNode?: Map<string, string[]>;
  /**
   * Optional observation recorder. When provided, each node returned to the check
   * records a graph: observation (keyed by node path, hashed from nodeYamlRaw).
   * File reads inside toPublicNode additionally record read: observations for
   * files NOT in `subjectFiles`.
   */
  recorder?: ObservationRecorder;
  /**
   * Set of repo-relative POSIX paths that are subject files for the current run.
   * File reads of these paths inside toPublicNode are NOT recorded as read:
   * observations (they are already hashed as subject inputs).
   */
  subjectFiles?: Set<string>;
}

export interface CtxGraph {
  node(id: string): GraphNode | undefined;
  nodesByType(type: string): GraphNode[];
  relationsFrom(node: GraphNode): Relation[];
  relationsTo(node: GraphNode): Relation[];
  children(node: GraphNode): GraphNode[];
  flowParticipants(flowName: string): GraphNode[];
}

/**
 * Record a `graph:<node>` observation for one model node into the recorder,
 * folding the node's RAW yg-node.yaml DISK bytes — byte-identical to what the
 * verifier re-observes (it reads the same file from disk). Reading disk here,
 * rather than re-encoding the in-memory nodeYamlRaw as UTF-8, keeps the two
 * sides symmetric for a non-UTF-8 yg-node.yaml. Falls back to the in-memory raw
 * when the disk read fails (tests with minimal stubs); an absent file with no
 * in-memory raw records the MISSING token so creating the file later invalidates.
 *
 * Shared by ctx.graph node probes AND the ctx.node self-observation (hook-loader),
 * so a check that reads ctx.node.type / ctx.node.ports folds the node's identity
 * exactly as a ctx.graph.node(self) call would — closing the stale-green hole
 * where a type/ports change left a deterministic verdict wrongly valid.
 */
export function recordNodeGraphObservation(
  recorder: ObservationRecorder | undefined,
  projectRoot: string,
  m: ModelNode,
): void {
  if (!recorder) return;
  const ygNodePath = path.join(projectRoot, '.yggdrasil', 'model', m.path, 'yg-node.yaml');
  let yamlBytes: Buffer | undefined;
  try {
    yamlBytes = fs.readFileSync(ygNodePath);
  } catch {
    yamlBytes = m.nodeYamlRaw !== undefined ? Buffer.from(m.nodeYamlRaw, 'utf8') : undefined;
  }
  if (yamlBytes === undefined) {
    recorder.recordGraphNodeAbsent(m.path);
  } else {
    recorder.recordGraphNode(m.path, yamlBytes);
  }
}

export function computeAllowedNodePaths(currentPath: string, graph: Graph): Set<string> {
  const allowed = new Set<string>([currentPath]);
  const current = graph.nodes.get(currentPath);
  if (!current) return allowed;

  for (const rel of current.meta.relations ?? []) {
    allowed.add(rel.target);
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    const relStack: ModelNode[] = [...target.children];
    while (relStack.length > 0) {
      const n = relStack.pop()!;
      allowed.add(n.path);
      relStack.push(...n.children);
    }
  }

  let cursor = current.parent;
  while (cursor) { allowed.add(cursor.path); cursor = cursor.parent; }

  const stack: ModelNode[] = [...current.children];
  while (stack.length) {
    const n = stack.pop()!;
    allowed.add(n.path);
    stack.push(...n.children);
  }
  return allowed;
}

/**
 * `ctx.graph` for a unit with no owning component (a file enforced by its
 * architecture type alone). Every method refuses — there is no yg-node.yaml to
 * resolve `currentNodePath` against, no ancestors/descendants, and no declared
 * relations to walk. This is not a narrower VIEW of the graph (which would
 * produce graph:/graph-children:/graph-bytype:/graph-flow: observations the
 * verifier's `reObserve` cannot reproduce without knowing the unit's type —
 * see verify-lock.ts's `reObserve`, which only ever re-reads disk-backed
 * read:/list:/exists: keys and recomputes graph-* keys from a real node path)
 * — it is an unconditional refusal, so NONE of those observation kinds can
 * ever be recorded for a nodeless unit, and re-verification needs no
 * component. Every entry point `CtxGraph` exposes is enumerated here; a new
 * method added to the interface must be added here too.
 */
export function createNodelessCtxGraph(): CtxGraph {
  return {
    node(): GraphNode | undefined {
      throw new StructureNodeContextUnavailableError('graph.node');
    },
    nodesByType(): GraphNode[] {
      throw new StructureNodeContextUnavailableError('graph.nodesByType');
    },
    relationsFrom(): Relation[] {
      throw new StructureNodeContextUnavailableError('graph.relationsFrom');
    },
    relationsTo(): Relation[] {
      throw new StructureNodeContextUnavailableError('graph.relationsTo');
    },
    children(): GraphNode[] {
      throw new StructureNodeContextUnavailableError('graph.children');
    },
    flowParticipants(): GraphNode[] {
      throw new StructureNodeContextUnavailableError('graph.flowParticipants');
    },
  };
}

export function createCtxGraph(params: CtxGraphParams): CtxGraph {
  const { currentNodePath, graph, projectRoot, touchedFiles, expandedFilesByNode, recorder, subjectFiles } = params;
  const allowed = computeAllowedNodePaths(currentNodePath, graph);

  function assertAllowed(id: string): void {
    if (!allowed.has(id)) throw new UndeclaredGraphReadError(id);
  }

  function recordGraphNode(m: ModelNode): void {
    recordNodeGraphObservation(recorder, projectRoot, m);
  }

  function toPublicNode(m: ModelNode): GraphNode {
    const files: File[] = [];
    // Prefer the runner's pre-expanded concrete file list (directory and glob
    // entries already resolved to real files). Fall back to the raw mapping
    // entries when no expansion was supplied (file-only, as before).
    const preExpanded = expandedFilesByNode?.get(m.path);
    const candidatePaths = preExpanded ?? (m.meta.mapping ?? []).map(normalizeMappingPath);
    for (const p of candidatePaths) {
      if (!p) continue;
      const abs = path.resolve(projectRoot, p);
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          const bytes = fs.readFileSync(abs);
          const content = bytes.toString('utf8');
          // touchedFiles reflects the files HANDED to the check (violation-emit
          // permission), so it stays eager and node-scoped. The read: OBSERVATION
          // — which is what widens the verdict's invalidation — folds LAZILY: only
          // when the check actually reads this file's `.content`. A check that
          // inspects only `.path` (e.g. listing sibling test files by name) must
          // NOT fold every sibling's bytes into its verdict. Subject files are
          // already hashed as subject inputs, so they are never double-recorded
          // and get a plain content property. (Mirrors wrapNonSubjectFile in
          // hook-loader.ts.)
          touchedFiles.push(p);
          files.push(makeGraphFile(p, content, bytes, recorder, subjectFiles));
        }
      } catch {
        // missing path — skip silently
      }
    }
    // Record graph: observation for this node — after materializing files so the
    // observation is registered even if the node has no mapped files.
    recordGraphNode(m);
    return {
      id: m.path,
      type: m.meta.type,
      mapping: m.meta.mapping ?? [],
      files,
      ports: (m.meta.ports ?? {}) as Record<string, Port>,
    };
  }

  return {
    node(id) {
      // Every ctx.graph.node() reachability decision derives ENTIRELY from the
      // CALLING node's own yg-node.yaml (its declared relations, via
      // computeAllowedNodePaths) — the probed target's bytes are reachability-blind.
      // Fold the CALLING node's graph: observation on EVERY probe, reachable OR not,
      // so a relation change in EITHER direction invalidates the cached verdict:
      //   - ADDING the relation that makes `id` reachable (was throwing → now found), and
      //   - REMOVING the relation that makes `id` unreachable again (was found → now throws),
      // both change the calling node's yaml bytes ⇒ the verdict re-verifies. The
      // verifier's reObserve('graph:<currentNodePath>') re-reads that same yg-node.yaml
      // from disk, so the two sides stay byte-symmetric (spec §3.1 over-record — a probe
      // is always an observation; deterministic, free; idempotent with toPublicNode's
      // own graph:<target> fold when id === the calling node).
      const self = graph.nodes.get(currentNodePath);
      if (self) recordGraphNode(self);

      if (!allowed.has(id)) {
        assertAllowed(id); // throws UndeclaredGraphReadError
      }
      const m = graph.nodes.get(id);
      if (!m) {
        // NEGATIVE lookup: the node is absent. Record an absent graph:
        // observation so creating it later invalidates the cached verdict
        // (spec §3.1 over-record — a negative probe is still an observation).
        if (recorder) recorder.recordGraphNodeAbsent(id);
        return undefined;
      }
      return toPublicNode(m);
    },
    nodesByType(type) {
      const out: GraphNode[] = [];
      const matchedIds: string[] = [];
      for (const id of allowed) {
        const m = graph.nodes.get(id);
        if (m && m.meta.type === type) {
          matchedIds.push(m.path);
          out.push(toPublicNode(m));
        }
      }
      // Fold the SET of matched node ids — adding/removing a node of this type
      // changes membership and invalidates the verdict, even though each member
      // already folds its own graph: observation (spec §3.1).
      if (recorder) recorder.recordGraphNodesByType(type, matchedIds);
      return out;
    },
    relationsFrom(node) {
      assertAllowed(node.id);
      const m = graph.nodes.get(node.id);
      if (m) recordGraphNode(m);
      return (m?.meta.relations ?? []) as Relation[];
    },
    relationsTo(node) {
      const out: Relation[] = [];
      for (const id of allowed) {
        const m = graph.nodes.get(id);
        if (!m) continue;
        // Record every scanned node — its relation declarations (including the
        // absence of a relation to `node`) are inputs to the result.
        recordGraphNode(m);
        for (const rel of m.meta.relations ?? []) {
          if (rel.target === node.id) out.push(rel as Relation);
        }
      }
      return out;
    },
    children(node) {
      assertAllowed(node.id);
      const m = graph.nodes.get(node.id);
      const childIds = m ? m.children.map((c) => c.path) : [];
      // Fold the SET of child node ids for this parent — adding/removing a child
      // changes membership and invalidates, independent of each child's own
      // graph: observation (spec §3.1). Recorded even for an empty result so a
      // later first child invalidates.
      if (recorder) recorder.recordGraphChildren(node.id, childIds);
      return m ? m.children.map(toPublicNode) : [];
    },
    flowParticipants(flowName) {
      const flow = graph.flows.find(f => f.name === flowName || f.path === flowName);
      if (!flow) return [];
      const participates = flow.nodes.some(n => {
        if (n === currentNodePath) return true;
        let cursor = graph.nodes.get(currentNodePath)?.parent;
        while (cursor) { if (cursor.path === n) return true; cursor = cursor.parent; }
        return false;
      });
      if (!participates) throw new UndeclaredGraphReadError(`flow:${flowName}`);
      // Fold the flow's declared participant set (the flow DEFINITION membership)
      // so adding/removing a participant invalidates even when every still-present
      // participant node is unchanged (spec §3.1). Keyed by the flow's canonical
      // name so the verifier re-observation matches.
      if (recorder) recorder.recordFlowParticipants(flow.name, [...flow.nodes]);
      const out: GraphNode[] = [];
      for (const nodeId of flow.nodes) {
        const m = graph.nodes.get(nodeId);
        if (m) out.push(toPublicNode(m));
      }
      return out;
    },
  };
}
