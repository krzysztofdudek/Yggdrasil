import type { Graph, GraphNode, AspectDef } from '../model/types.js';
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
