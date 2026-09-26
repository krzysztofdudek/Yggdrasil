/**
 * source/cli/src/core/fill-log-gate.ts — the per-node mandatory-log gate for the
 * fill stage (spec §9).
 *
 * The freshness/fingerprint predicate (logGateBlocksNode) is the SINGLE source of
 * truth and lives in the shared read-only module core/log/log-gate.ts so the read
 * path (core/check.ts) and positive closure can consult it without depending on
 * the fill stage. This module adds only the fill-stage WRAPPER (logGateBlocks)
 * that emits the `log-entry-missing` diagnostic when the gate blocks a node whose
 * pairs are being filled, and the phase (runLogGatePhase) that asks it of every
 * such node and stops the run when any of them blocks.
 */

import type { Graph, GraphNode } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { CheckIssue } from './check.js';
import { logGateBlocksNode } from './log/log-gate.js';
import { FillGatingError } from './fill-contract.js';
import { toPosixPath } from '../utils/posix.js';
import { count } from '../utils/count.js';

/**
 * Step 3 of the fill stage: the log gate over every component the run fills a
 * pair of. A node whose log_required type saw its own source change (or first
 * verification) with no fresh entry needs a justification entry first. If ANY
 * such node needs one, --approve approves NOTHING this run and stops (no fill,
 * no report) — the per-node messages tell the user which entries to add, then
 * re-run. Returns the (empty) blocked set when nothing blocks.
 */
export async function runLogGatePhase(params: {
  graph: Graph;
  projectRoot: string;
  /** The components this run fills a pair of — the same ones the report counts. */
  nodePaths: Iterable<string>;
  lock: LockFile;
  retry: string;
  /** See RunFillOptions.gateIssuesOnError. */
  gateIssuesOnError: boolean | undefined;
  emitIssue: (msg: IssueMessage) => void;
}): Promise<Set<string>> {
  const { graph, projectRoot, lock, retry, emitIssue } = params;
  const blockedNodes = new Set<string>();
  const logGateIssues: CheckIssue[] = [];
  for (const nodePath of params.nodePaths) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, retry);
    if (blocked === null) continue;
    blockedNodes.add(nodePath);
    logGateIssues.push({ code: 'log-entry-missing', severity: 'error', rule: 'log-entry-missing', messageData: blocked, nodePath });
    if (params.gateIssuesOnError !== true) emitIssue(blocked);
  }
  if (blockedNodes.size > 0) {
    throw new FillGatingError([{
      code: 'log-entry-required',
      what: `${count(blockedNodes.size, 'node')} ${blockedNodes.size === 1 ? 'needs' : 'need'} a fresh log entry before --approve.`,
      why: 'Their source has drifted from the state their recorded verdicts were written over — by earlier commits as easily as by anything in progress now — and log_required nodes owe a justification entry for that. Nothing was filled this run.',
      next: `Add the log entries listed above (yg log add), then re-run: ${retry}`,
    }], 'log-gate', logGateIssues, retry);
  }
  return blockedNodes;
}

/**
 * Step-4 log gate: consults logGateBlocksNode (the shared predicate) and returns
 * the `log-entry-missing` message when a node blocks (null when it does not).
 * The caller decides where the message goes: onto the diagnostic stream, or
 * into the abort it raises. runLogGatePhase asks it of every component the run would
 * fill a pair of, collects every blocked one and, if any exist, throws
 * FillGatingError so the run fills NOTHING (no pair on any node is verified until
 * each of those entries exists). A changed component the run fills nothing of is
 * not asked here; the plain read reports it.
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
 *
 * A component that has NEVER recorded a baseline did not drift from anything:
 * its first verdicts are simply owed an entry. Calling that "drifted" sent the
 * reader looking for a change that never happened, so the message says which
 * of the two it is.
 */
async function logGateBlocks(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
  retry = 'yg check --approve',
): Promise<IssueMessage | null> {
  const blocked = await logGateBlocksNode(graph, projectRoot, node, lock);
  if (!blocked) return null;

  const nodePath = toPosixPath(node.path);
  const next = `yg log add --node ${nodePath} --reason '<why this change was made>'\nThen re-run ${retry}. If you did not make this change, ask the user for the reason — never invent one.`;
  if (lock.nodes[node.path]?.source === undefined) {
    return {
      what: `No log entry for node '${nodePath}' — mandatory before its first verdicts are recorded.`,
      why: `Node type '${node.meta.type}' has log_required: true — every component of it needs a justification entry capturing WHY before verdicts are recorded over its code. This one has never been verified, so there is no earlier state it drifted from: its first entry is simply owed. Recording answers for the code as it stands, so it stops here and approves nothing this run until the entry exists.`,
      next,
    };
  }
  return {
    what: `No fresh log entry for node '${nodePath}' — mandatory before recording verdicts when its source drifted.`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. This component's source has drifted from the state its recorded verdicts were written over, which earlier commits can be as much the cause of as anything in progress now. Recording answers for the code as it stands, so it stops here and approves nothing this run until a fresh entry exists.`,
    next,
  };
}
