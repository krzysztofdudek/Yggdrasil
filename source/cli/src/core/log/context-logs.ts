/**
 * source/cli/src/core/log/context-logs.ts — the logs `yg context` puts in front
 * of an agent about to edit a file.
 *
 * Two logs speak about the code an agent is about to touch, and they answer
 * different questions, so the context carries them apart:
 *
 *  - The DECISIONS IN FORCE for the subject's type and for every type above it.
 *    A decision recorded on a type holds for the whole subtree of types below
 *    it, so the cascade walks the type's parent chain upward, nearest type
 *    first — the order in which they take precedence. Each is given in full: a
 *    type decision is written only when every agent touching any file of the
 *    type has to know it, so none of them is noise to cut. A decision a later
 *    one replaced stays in the file as history and is left out here.
 *  - The NODE's own log — why this one component is the way it is. Given whole,
 *    except on a node whose type requires an entry for every source change
 *    (`log_required`): such a log grows with every edit, so only its newest
 *    {@link CONTEXT_NODE_LOG_TRIM} entries in force are given, with a count of
 *    the ones left out and the command that reads them. Replaced entries are
 *    left out here too.
 *
 * A rule's own log is never part of it: that history is for whoever changes the
 * rule, not for whoever writes code under it.
 *
 * Read-only: nothing here writes a log, a lock or a verdict, and no log entry is
 * part of any pair's hash, so what the context shows can never re-open a pair.
 */

import path from 'node:path';

import type { Graph } from '../../model/graph.js';
import { toPosixPath } from '../../utils/posix.js';
import { readLogSafe } from '../../io/log-store.js';
import { parseLog } from '../parsing/log-parser.js';
import { validateFormat, logHasConflictMarkers } from '../log-format.js';
import { withStanding } from './log-supersedes.js';
import { typeDecisionCascade, typeLogRelPath } from './type-log.js';
import type { ContextLogEntry, ContextLogs, ContextLogUnreadable, ContextNodeLog, ContextTypeDecisions } from '../../model/context-logs.js';

/** How many entries in force a `log_required` node's log contributes to its context — the same count `yg log read` shows by default. */
const CONTEXT_NODE_LOG_TRIM = 10;

/**
 * The logs for a component (its own log and its type's decisions) or for a
 * file governed by its type alone (its type's decisions only).
 */
export async function collectContextLogs(
  graph: Graph,
  subject: { nodePath: string } | { typeId: string },
): Promise<ContextLogs> {
  const node = 'nodePath' in subject ? graph.nodes.get(subject.nodePath) : undefined;
  const typeId = 'typeId' in subject ? subject.typeId : node?.meta.type;
  const typeDecisions: ContextTypeDecisions[] = typeId === undefined
    ? []
    : (await typeDecisionCascade(graph, typeId)).map((d) => ({
        typeId: d.typeId,
        logPath: typeLogRelPath(d.typeId),
        entries: d.entries.map(toContextEntry),
        ...(d.unreadable !== undefined && { unreadable: d.unreadable }),
      }));
  if (node === undefined) return { typeDecisions };
  const trimmed = graph.architecture.node_types[node.meta.type]?.log_required === true;
  const nodeLog = await readNodeLogForContext(graph, node.path, trimmed);
  return nodeLog === undefined ? { typeDecisions } : { typeDecisions, nodeLog };
}

/** A log that does not parse: none of its entries can be given as in force, and the file has to be repaired first. */
function brokenLog(what: string, logPath: string): ContextLogUnreadable {
  return {
    what,
    why: 'The log does not parse entry by entry, so none of its entries can be given as in force; yg check reports the same file as log-format.',
    next: `Fix ${logPath} (or restore it from git: git checkout HEAD -- ${logPath}), then re-run yg context.`,
  };
}

function toContextEntry(e: { datetime: string; body: string }): ContextLogEntry {
  return { datetime: e.datetime, body: e.body };
}

async function readNodeLogForContext(graph: Graph, nodePath: string, trimmed: boolean): Promise<ContextNodeLog | undefined> {
  const posixNode = toPosixPath(nodePath);
  const logPath = `.yggdrasil/model/${posixNode}/log.md`;
  const content = await readLogSafe(path.join(graph.rootPath, 'model', nodePath, 'log.md'));
  if (content === '') return undefined;
  const base = { nodePath: posixNode, logPath, trimmed };
  if (logHasConflictMarkers(content)) {
    return {
      ...base,
      entries: [],
      omitted: 0,
      unreadable: {
        what: `${logPath} still contains git conflict markers`,
        why: 'A merge left both sides of the log in the file, so which entries hold cannot be told until the two sides are reconciled.',
        next: `yg log merge-resolve --node ${posixNode}`,
      },
    };
  }
  const violations = validateFormat(content);
  if (violations.length > 0) {
    return { ...base, entries: [], omitted: 0, unreadable: brokenLog(`${logPath} format violation at line ${violations[0].line}: ${violations[0].reason}`, logPath) };
  }
  const inForce = withStanding(parseLog(content)).filter((e) => e.supersededBy === undefined);
  if (inForce.length === 0) return undefined;
  const given = trimmed ? inForce.slice(-CONTEXT_NODE_LOG_TRIM) : inForce;
  return { ...base, entries: given.map(toContextEntry), omitted: inForce.length - given.length };
}
