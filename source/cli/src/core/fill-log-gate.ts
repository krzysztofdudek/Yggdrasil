/**
 * source/cli/src/core/fill-log-gate.ts — the per-node mandatory-log gate for the
 * fill stage (spec §9).
 *
 * The freshness/fingerprint predicate (logGateBlocksNode) is the SINGLE source of
 * truth and lives in the shared read-only module core/log/log-gate.ts so the read
 * path (core/check.ts) and positive closure can consult it without depending on
 * the fill stage. This module adds only the fill-stage WRAPPER (logGateBlocks)
 * that emits the `log-entry-missing` diagnostic when the gate blocks a node whose
 * pairs are being filled.
 */

import type { Graph, GraphNode } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { logGateBlocksNode } from './log/log-gate.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * Step-4 log gate: consults logGateBlocksNode (the shared predicate) and emits the
 * `log-entry-missing` message when a node blocks. The gate is ALL-OR-NOTHING —
 * fill.ts collects every blocked node and, if any exist, throws FillGatingError so
 * the run fills NOTHING (no pair on any node is verified until every entry exists).
 */
export async function logGateBlocks(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
  emitIssue: (msg: IssueMessage) => void,
): Promise<boolean> {
  const blocked = await logGateBlocksNode(graph, projectRoot, node, lock);
  if (!blocked) return false;

  emitIssue({
    what: `No fresh log entry for node '${toPosixPath(node.path)}' — mandatory before --approve when source changed.`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. --approve stops here and approves nothing this run until a fresh entry exists.`,
    next: `yg log add --node ${toPosixPath(node.path)} --reason '<justification>', then re-run: yg check --approve`,
  });
  return true;
}
