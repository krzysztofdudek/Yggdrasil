import type { IssueMessage } from '../../model/validation.js';
import type { Graph } from '../../model/graph.js';

export function issueMsg(data: IssueMessage): { messageData: IssueMessage } {
  return { messageData: data };
}

/**
 * True while any graph file failed to load (a yg-node.yaml, a flow's
 * yg-flow.yaml, or yg-architecture.yaml). What the missing file declared is
 * invisible — a flow that did not load attaches its rules to nobody — so a
 * finding about the ABSENCE of a reference (an orphaned or effective-nowhere
 * rule) is a follow-on of the load error rather than a fact, and is withheld.
 */
export function graphLoadIncomplete(graph: Graph): boolean {
  return (graph.nodeParseErrors?.length ?? 0) > 0 || (graph.flowParseErrors?.length ?? 0) > 0 || graph.architectureError !== undefined;
}
