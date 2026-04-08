import path from 'node:path';
import type { Graph, GraphNode, AspectDef } from '../model/graph.js';
import { tokenize } from '../utils/tokenizer.js';

export interface SelectionResult {
  node: string;
  score: number;
  name: string;
}

function countHits(tokens: string[], text: string): number {
  const lower = text.toLowerCase();
  return tokens.filter((t) => lower.includes(t)).length;
}

function collectAspectContent(graphNode: GraphNode, aspects: AspectDef[]): string {
  const aspectIds = graphNode.meta.aspects ?? [];
  if (aspectIds.length === 0) return '';
  const aspectMap = new Map(aspects.map((a) => [a.id, a]));
  const parts: string[] = [];
  for (const id of aspectIds) {
    const aspect = aspectMap.get(id);
    if (aspect) {
      for (const artifact of aspect.artifacts) {
        parts.push(artifact.content);
      }
    }
  }
  return parts.join(' ');
}

function scoreNodeS1(
  graphNode: GraphNode,
  tokens: string[],
  aspects: AspectDef[],
): number {
  let score = 0;
  for (const artifact of graphNode.artifacts) {
    const hits = countHits(tokens, artifact.content);
    if (artifact.filename === 'responsibility.md') {
      score += hits * 3;
    } else if (artifact.filename === 'interface.md') {
      score += hits * 2;
    } else {
      score += hits * 1;
    }
  }
  const aspectText = collectAspectContent(graphNode, aspects);
  if (aspectText) {
    score += countHits(tokens, aspectText) * 2;
  }
  return score;
}

/** Count path segments — deeper nodes are more specific */
function pathDepth(nodePath: string): number {
  return nodePath.split('/').length;
}

export function selectNodes(
  graph: Graph,
  task: string,
  limit: number,
): SelectionResult[] {
  const tokens = tokenize(task);
  if (tokens.length === 0) return [];

  const scored: SelectionResult[] = [];
  for (const [nodePath, node] of graph.nodes) {
    const score = scoreNodeS1(node, tokens, graph.aspects);
    if (score > 0) {
      scored.push({ node: nodePath, score, name: node.meta.name });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreaker: prefer deeper (more specific) nodes
      return pathDepth(b.node) - pathDepth(a.node);
    });
    return scored.slice(0, limit);
  }

  return selectFromFlows(graph, tokens, limit);
}

function selectFromFlows(
  graph: Graph,
  tokens: string[],
  limit: number,
): SelectionResult[] {
  const flowScores: Array<{ flow: string; score: number; participants: string[] }> = [];

  for (const flow of graph.flows) {
    let score = 0;
    for (const artifact of flow.artifacts) {
      score += countHits(tokens, artifact.content);
    }
    score += countHits(tokens, flow.name);
    if (score > 0) {
      flowScores.push({ flow: flow.name, score, participants: flow.nodes });
    }
  }

  if (flowScores.length === 0) return [];
  flowScores.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: SelectionResult[] = [];
  for (const fs of flowScores) {
    for (const participant of fs.participants) {
      if (seen.has(participant)) continue;
      seen.add(participant);
      const node = graph.nodes.get(participant);
      if (node) {
        results.push({ node: participant, score: fs.score, name: node.meta.name });
      }
    }
  }

  return results.slice(0, limit);
}

// ============================================================
// Enriched select — three-dimensional search
// ============================================================

export interface AspectMatch {
  aspectId: string;
  name: string;
  matched: boolean;
  nodeCount: number;
  readPaths: string[];
}

export interface FlowMatch {
  flowPath: string;
  name: string;
  matched: boolean;
  nodeCount: number;
  readPath: string;
}

export interface EnrichedSelectResult {
  nodes: SelectionResult[];
  aspects: AspectMatch[];
  flows: FlowMatch[];
}

export function selectTask(
  graph: Graph,
  task: string,
  limit: number,
): EnrichedSelectResult {
  const tokens = tokenize(task);
  if (tokens.length === 0) return { nodes: [], aspects: [], flows: [] };

  const projectRoot = path.dirname(graph.rootPath);

  // ── 1. Score and rank nodes (existing scoreNodeS1 logic) ──
  const scored: SelectionResult[] = [];
  for (const [nodePath, node] of graph.nodes) {
    const score = scoreNodeS1(node, tokens, graph.aspects);
    if (score > 0) scored.push({ node: nodePath, score, name: node.meta.name });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return pathDepth(b.node) - pathDepth(a.node);
  });
  const topNodes = scored.slice(0, limit);

  // ── 2. Score aspects directly ──
  const aspectScores = new Map<string, number>();
  const aspectMap = new Map(graph.aspects.map((a) => [a.id, a]));

  for (const aspect of graph.aspects) {
    let score = countHits(tokens, aspect.name) * 3;
    if (aspect.description) score += countHits(tokens, aspect.description) * 2;
    for (const artifact of aspect.artifacts) {
      score += countHits(tokens, artifact.content);
    }
    if (score > 0) aspectScores.set(aspect.id, score);
  }

  // ── 3. Count aspect occurrences on returned nodes ──
  const aspectNodeCounts = new Map<string, number>();
  for (const nodeResult of topNodes) {
    const node = graph.nodes.get(nodeResult.node);
    if (!node) continue;
    for (const aspectId of node.meta.aspects ?? []) {
      aspectNodeCounts.set(aspectId, (aspectNodeCounts.get(aspectId) ?? 0) + 1);
    }
  }

  // ── 4. Merge aspects ──
  const allAspectIds = new Set([...aspectScores.keys(), ...aspectNodeCounts.keys()]);
  const aspects: AspectMatch[] = [];
  for (const id of allAspectIds) {
    const aspect = aspectMap.get(id);
    if (!aspect) continue;
    const readPaths = aspect.artifacts.map((artifact) =>
      path
        .relative(projectRoot, path.join(graph.rootPath, 'aspects', id, artifact.filename))
        .replace(/\\/g, '/'),
    );
    aspects.push({
      aspectId: id,
      name: aspect.name,
      matched: aspectScores.has(id),
      nodeCount: aspectNodeCounts.get(id) ?? 0,
      readPaths,
    });
  }
  aspects.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return b.nodeCount - a.nodeCount;
  });
  const topAspects = aspects.slice(0, limit);

  // ── 5. Score flows directly ──
  const flowScores = new Map<string, number>();
  for (const flow of graph.flows) {
    let score = countHits(tokens, flow.name) * 3;
    if (flow.description) score += countHits(tokens, flow.description) * 2;
    for (const artifact of flow.artifacts) {
      score += countHits(tokens, artifact.content);
    }
    if (score > 0) flowScores.set(flow.path, score);
  }

  // ── 6. Count flow occurrences on returned nodes ──
  const flowNodeCounts = new Map<string, number>();
  const nodePathSet = new Set(topNodes.map((n) => n.node));
  for (const flow of graph.flows) {
    const participantCount = flow.nodes.filter((n) => nodePathSet.has(n)).length;
    if (participantCount > 0) {
      flowNodeCounts.set(flow.path, participantCount);
    }
  }

  // ── 7. Merge flows ──
  const allFlowPaths = new Set([...flowScores.keys(), ...flowNodeCounts.keys()]);
  const flows: FlowMatch[] = [];
  const flowMap = new Map(graph.flows.map((f) => [f.path, f]));
  for (const fp of allFlowPaths) {
    const flow = flowMap.get(fp);
    if (!flow) continue;
    const readPath = path
      .relative(projectRoot, path.join(graph.rootPath, 'flows', fp, 'description.md'))
      .replace(/\\/g, '/');
    flows.push({
      flowPath: fp,
      name: flow.name,
      matched: flowScores.has(fp),
      nodeCount: flowNodeCounts.get(fp) ?? 0,
      readPath,
    });
  }
  flows.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return b.nodeCount - a.nodeCount;
  });
  const topFlows = flows.slice(0, limit);

  return { nodes: topNodes, aspects: topAspects, flows: topFlows };
}
