/**
 * Agent-facing what/why/next messages for the relation-conformance check code
 * (`relation-undeclared-dependency`). The refusal message is fully actionable:
 * it names the exact yg-node.yaml to edit, and for each undeclared target it
 * computes the allowed relation types from the architecture's allow-list (the
 * same source of truth the `relation-target-forbidden` validator reads), shows
 * the `relations:` stanza to paste, and flags dead-ends (no relation type may
 * connect the two node types). Structured `IssueMessage` objects only; the check
 * renderer (cli/check.ts) presents them, exactly like every other lock issue.
 */

import type { IssueMessage } from '../model/validation.js';
import type { Graph } from '../model/graph.js';
import type { Violation } from './verifier.js';
import { allowedRelationTypes } from './allowed-types.js';
import type { TypeGateFinding } from './type-gate.js';

/** The node-type of a graph node, or undefined if the node is unknown. */
function typeOf(graph: Graph, nodeId: string): string | undefined {
  return graph.nodes.get(nodeId)?.meta.type;
}

/**
 * Refused: the node has undeclared dependencies on other nodes. Builds a
 * fully-actionable message: the exact file to edit, and per distinct target the
 * allowed relation types + the `relations:` stanza to add (or a dead-end note
 * pointing at the architecture when no relation type is allowed).
 */
export function relationRefusedMessage(
  graph: Graph,
  nodeId: string,
  violations: Violation[],
): IssueMessage {
  const fromType = typeOf(graph, nodeId);

  // Distinct targets, in first-seen order, each with the violating sites.
  const bySite = violations
    .map((v) => `${v.fromFile}:${v.line} → ${v.ownerNode}`)
    .join('\n');

  const targets: string[] = [];
  for (const v of violations) if (!targets.includes(v.ownerNode)) targets.push(v.ownerNode);

  const nodeFile = `.yggdrasil/model/${nodeId}/yg-node.yaml`;

  const blocks: string[] = [];
  for (const target of targets) {
    const toType = typeOf(graph, target);
    const allowed =
      fromType !== undefined && toType !== undefined
        ? allowedRelationTypes(graph.architecture, fromType, toType)
        : [];

    if (allowed.length === 0) {
      // Dead-end: no relation type connects these two node types.
      const fromDesc = fromType ?? '(unknown type)';
      const toDesc = toType ?? '(unknown type)';
      blocks.push(
        `${target}: no relation type is allowed from ${fromDesc} to ${toDesc}; ` +
          `either change a node's type or update the allowed relations in ` +
          `.yggdrasil/yg-architecture.yaml (requires confirming the architecture change).`,
      );
    } else {
      blocks.push(
        `${target}: allowed relation type(s) [${allowed.join(', ')}]. Add to ${nodeFile}:\n` +
          `relations:\n` +
          `  - target: ${target}\n` +
          `    type: ${allowed[0]}`,
      );
    }
  }

  return {
    what: `Node '${nodeId}' has undeclared dependencies on other nodes:\n${bySite}`.trimEnd(),
    why: 'A dependency on another component must be a sanctioned, declared relation. Undeclared edges erode the architecture allow-list of who may depend on whom.',
    next: `Declare the missing relation(s) in ${nodeFile} (or remove the dependency if it is not legitimate):\n${blocks.join('\n')}`,
  };
}

/** Unverified: inputs changed since the last approval. */
export function relationUnverifiedMessage(nodeId: string): IssueMessage {
  return {
    what: `Relation conformance for node '${nodeId}' is unverified — its source, relations, or a dependency target changed since the last approval.`,
    why: 'A relation verdict is valid only while its inputs are unchanged; an input changed, so the verdict must be recomputed before it can be trusted.',
    next: 'Run: yg check --approve',
  };
}

/**
 * Forbidden: every statically-resolved import edge from `finding.fromType` to
 * `finding.toType` — one message per distinct (fromType, toType) pair, aggregating
 * every violating edge in that bucket rather than emitting one issue per edge. Samples
 * the first five edges (with a remainder count) so a large bucket stays readable. NEXT
 * lists exits cheapest-first: allow-listing the pair clears the whole group in one
 * edit; graduating the target to an explicit node restores declared-edge semantics for
 * just that file; removing the dependency is always available but the most costly.
 */
export function typeGateForbiddenMessage(finding: TypeGateFinding): IssueMessage {
  const sample = finding.edges.slice(0, 5);
  const rest = finding.edges.length - sample.length;
  const sampleText = sample.map((e) => `  ${e.fromFile} -> ${e.toFile}`).join('\n');
  return {
    what: `${finding.edges.length} import${finding.edges.length === 1 ? '' : 's'} from type '${finding.fromType}' to type '${finding.toType}' — no relation type is allowed between them:\n${sampleText}${rest > 0 ? `\n... and ${rest} more` : ''}`,
    why: `The architecture's relation allow-list governs every dependency between classified files, not just ones an explicit node declared — an unsanctioned import erodes the same boundary a declared relation protects.`,
    next: `Cheapest first:\n  1. Allow it: add a relations entry for '${finding.fromType}' -> '${finding.toType}' in yg-architecture.yaml (clears this whole group).\n  2. Graduate the target: create an explicit node for the imported file(s) with a curated relation (restores declared-edge semantics; run yg impact --type ${finding.toType} to preview the cost).\n  3. Remove the dependency.`,
  };
}
