/**
 * source/cli/src/core/check-aspect-status.ts — reporting a rule whose standing
 * moved without anybody writing it down.
 *
 * The pure classify half of the two described in `core/log/aspect-status.ts`.
 * It only compares and reports; the recording half runs in an approving pass,
 * because that is the one place allowed to write.
 *
 * WARNING, never an error. A rule that was promoted or demoted by hand is not a
 * violation of anything — the change may be exactly right — it is an unrecorded
 * fact. Failing a build over it would punish the wrong act and teach people to
 * avoid the tool; saying it plainly, until the next approving run writes it into
 * that rule's history, is the whole job.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { CheckIssue } from './check-contract.js';
import { findStatusDrift } from './log/aspect-status.js';

/**
 * Report every rule standing somewhere other than where the tool last saw it.
 *
 * A rule with no remembered standing is silent by construction (see
 * findStatusDrift): the first approving run remembers it, and only a LATER move
 * can be reported — which is exactly right, since nobody can say what an unseen
 * rule moved from.
 */
export function classifyAspectStatusDrift(graph: Graph, lock: LockFile, issues: CheckIssue[]): void {
  for (const drift of findStatusDrift(graph, lock)) {
    issues.push({
      severity: 'warning',
      code: 'aspect-status-changed-outside-cli',
      rule: 'aspect-status-changed-outside-cli',
      messageData: {
        what: `Rule '${drift.aspectId}' now stands at ${drift.to}; the last standing recorded for it was ${drift.from}.`,
        why: "A rule's standing is the whole of its authority — draft enforces nothing, advisory reports, enforced refuses — and this one moved without a word about why. The rule's own log is where that belongs, so the reason travels with the rule instead of living in one commit message.",
        next: `Record why it moved: yg aspects log add --aspect ${drift.aspectId} --status ${drift.to} --evidence '<what justified it>' --reason '<why it moved>'. The next yg check --approve otherwise writes the bare fact into that rule's log for you.`,
      },
      aspectId: drift.aspectId,
    });
  }
}
