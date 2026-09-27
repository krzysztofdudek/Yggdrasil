/**
 * source/cli/src/core/check-type-law.ts — reporting law on a node type that
 * nobody admitted.
 *
 * The classify half of core/log/type-law.ts: it reads which rules stand
 * enforced on a type without a ratification of their current version, and says
 * so, one finding per rule. It writes nothing; a ratification is written only
 * by `yg log add --aspect --ratify`, on the user's word, and the law a graph
 * already had is recorded once by the upgrade that turns the requirement on.
 *
 * Severity follows the committed `type_law.ratification` setting: an error
 * where it is on, a warning where it is not. A graph that has not taken the
 * requirement up yet therefore hears about every such rule without a build
 * turning red on the day the CLI is upgraded, and the message names the one
 * command that takes it up.
 */

import type { Graph } from '../model/graph.js';
import type { CheckIssue } from './check-contract.js';
import { findUnratifiedTypeLaw, type UnratifiedTypeLaw } from './log/type-law.js';

const quoteList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

function what(item: UnratifiedTypeLaw): string {
  const noun = item.types.length === 1 ? 'type' : 'types';
  const head = `Rule '${item.aspectId}' stands enforced on node ${noun} ${quoteList(item.types)}, and its log holds no ratification of the version that stands now (${item.version}) for ${item.types.length === 1 ? 'it' : 'them'}.`;
  if (item.logUnreadable !== undefined) return `${head} Its log could not be read: ${item.logUnreadable}`;
  if (item.earlier !== undefined) return `${head} It was last admitted at ${item.earlier.datetime}, as version ${item.earlier.version}; it has changed since.`;
  return head;
}

/** One finding per rule standing enforced on a type without a ratification of what it demands now. */
export async function classifyTypeLaw(graph: Graph): Promise<CheckIssue[]> {
  if (graph.config.typeLaw?.ratification !== true) return [];
  const issues: CheckIssue[] = [];
  for (const item of await findUnratifiedTypeLaw(graph)) {
    const ratify = `yg log add --aspect ${item.aspectId} --ratify --by '<who admitted it>' --reason '<what they admitted>'`;
    issues.push({
      severity: 'error',
      code: 'type-law-unratified',
      rule: 'type-law-unratified',
      messageData: {
        what: what(item),
        why: "A rule on a node type governs every file of that type, today's and every later one — it is shared vocabulary, and the people who own the code admit it. Until they do, it belongs at status: advisory; an enforced rule nobody admitted is law an agent gave itself.",
        next: `Ask the user whether they admit it on ${quoteList(item.reach)}. If they do: ${ratify}. If not: set status: advisory in the rule's yg-aspect.yaml, and drop any status: enforced its entry under node_types in yg-architecture.yaml adds (the user's decision).`,
      },
      aspectId: item.aspectId,
    });
  }
  return issues;
}
