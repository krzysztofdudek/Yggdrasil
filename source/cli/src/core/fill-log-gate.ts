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
 *
 * WHAT THE MESSAGE HAS TO CARRY, and why it is worded the way it is. The gate
 * measures a component's source against the baseline its LAST RECORDED VERDICT
 * was written over — not against the current change. A component can therefore
 * block here because of edits that landed long before the branch under way, and
 * on a project measuring its changes against a reference the plain read will say
 * exactly that (a non-blocking finding, outside the change) while this gate
 * still refuses to record anything. Someone meeting the two answers together
 * has to be able to tell they are not in contradiction, so the WHY names the
 * baseline the drift is measured from rather than implying "you changed this".
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
    what: `No fresh log entry for node '${toPosixPath(node.path)}' — mandatory before recording verdicts when its source drifted.`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. This component's source has drifted from the state its recorded verdicts were written over, which earlier commits can be as much the cause of as anything in progress now. Recording answers for the code as it stands, so it stops here and approves nothing this run until a fresh entry exists.`,
    next: `yg log add --node ${toPosixPath(node.path)} --reason '<justification>', then re-run: yg check --approve`,
  });
  return true;
}
