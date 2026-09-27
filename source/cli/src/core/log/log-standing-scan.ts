/**
 * source/cli/src/core/log/log-standing-scan.ts — what every log in the graph
 * holds in force, read once for the attention feed.
 *
 * Two questions are asked of it, both about decisions that are in force but
 * should not be left as they are:
 *
 *   1. Does any log hold two entries that each replaced the same earlier one?
 *      That is the shape two branches leave when each superseded one decision
 *      on its own. `yg log merge-resolve` reports it once, at the merge; its
 *      baseline is recorded all the same (history is never dropped), so after
 *      the merge commit nothing else would say it again, and both successors
 *      would keep reading as in force. A node's log, a type's log and a rule's
 *      log are all asked: a rule's log keeps no baseline and is not reconciled
 *      by `merge-resolve` at all, so for it this is the only place the clash
 *      shows.
 *   2. How much does a node of each type read from the type decision logs —
 *      its own type's and every type's above it on the parent chain, which is
 *      what its context carries in full? The answer is data; whether it is too
 *      much is the attention feed's call.
 *
 * Read-only and tolerant: a log that is missing reads as empty, and a log whose
 * format is broken or still carries conflict markers is skipped — `yg check`
 * reports those under codes of its own, and guessing where its entries end
 * here would invent a finding.
 */

import path from 'node:path';

import type { Graph } from '../../model/graph.js';
import { readLogSafe } from '../../io/log-store.js';
import { parseLog } from '../parsing/log-parser.js';
import { logHasConflictMarkers, validateFormat } from '../log-format.js';
import { toPosixPath } from '../../utils/posix.js';
import { walkTypeParentChain } from '../type-effective.js';
import { aspectLogPath } from './aspect-log.js';
import { typeLogNameUsable, typeLogRelPath, TYPE_LOGS_DIR } from './type-log.js';
import { competingSuccessors, withStanding, type EntryStanding } from './log-supersedes.js';

/** One entry that more than one entry in force claims to have replaced. */
export interface LogSupersedeClash {
  /** The log file, relative to the project root, POSIX. */
  logRel: string;
  /** The `yg log` target flag that names this log: `--node <path>`, `--type <id>`, `--aspect <id>`. */
  flag: string;
  /** The datetime of the entry replaced twice. */
  target: string;
  /** The datetimes of the entries in force that each replaced it, oldest first. */
  successors: string[];
}

/** One type's own decisions in force: what it contributes to the context of its nodes and of its subtypes' nodes. */
export interface TypeDecisionShare {
  typeId: string;
  /** Datetimes of the type's own entries in force, oldest first. */
  datetimes: string[];
  /** Characters of those entries as a reader gets them: each header line and its body. */
  chars: number;
}

/** What one type's nodes read from the type decision logs: the type's own share and every share above it. */
export interface TypeDecisionLoad {
  typeId: string;
  /** Nearest first: the type itself (when it has decisions in force), then each type above it that has any. */
  shares: TypeDecisionShare[];
}

export interface LogStandingScan {
  clashes: LogSupersedeClash[];
  /** One per type with decisions of its own in force, in the architecture's declaration order. */
  typeLoads: TypeDecisionLoad[];
}

/** The standing of every entry of one log, or null when there is nothing to read or it cannot be read entry by entry. */
async function standingOf(absPath: string): Promise<EntryStanding[] | null> {
  const content = await readLogSafe(absPath);
  if (content === '' || logHasConflictMarkers(content) || validateFormat(content).length > 0) return null;
  return withStanding(parseLog(content));
}

function clashesOf(entries: EntryStanding[], logRel: string, flag: string): LogSupersedeClash[] {
  return competingSuccessors(entries).map((c) => ({ logRel, flag, target: c.target, successors: c.successors }));
}

/** The characters an entry takes when a reader is handed it: its header line and its body. */
function entryChars(entry: EntryStanding): number {
  return `## [${entry.datetime}]\n${entry.body}`.length;
}

/** Read every node, type and rule log of the graph once, and answer both questions. */
export async function scanLogStanding(graph: Graph): Promise<LogStandingScan> {
  const projectRoot = path.dirname(graph.rootPath);
  const relOf = (abs: string): string => toPosixPath(path.relative(projectRoot, abs));
  const clashes: LogSupersedeClash[] = [];

  for (const nodePath of graph.nodes.keys()) {
    const abs = path.join(graph.rootPath, 'model', nodePath, 'log.md');
    const entries = await standingOf(abs);
    if (entries !== null) clashes.push(...clashesOf(entries, relOf(abs), `--node ${toPosixPath(nodePath)}`));
  }

  const own = new Map<string, TypeDecisionShare>();
  const typeIds = Object.keys(graph.architecture.node_types).filter(typeLogNameUsable);
  for (const typeId of typeIds) {
    const entries = await standingOf(path.join(graph.rootPath, TYPE_LOGS_DIR, typeId, 'log.md'));
    if (entries === null) continue;
    clashes.push(...clashesOf(entries, typeLogRelPath(typeId), `--type ${typeId}`));
    const inForce = entries.filter((e) => e.supersededBy === undefined);
    if (inForce.length > 0) {
      own.set(typeId, { typeId, datetimes: inForce.map((e) => e.datetime), chars: inForce.reduce((n, e) => n + entryChars(e), 0) });
    }
  }

  for (const aspect of graph.aspects) {
    const abs = aspectLogPath(graph.rootPath, aspect.id);
    const entries = await standingOf(abs);
    if (entries !== null) clashes.push(...clashesOf(entries, relOf(abs), `--aspect ${aspect.id}`));
  }

  // A type with nothing of its own in force reads exactly what the nearest
  // type above it with decisions reads, so only the types that contribute get
  // a load: every distinct load is reported once, at the type that can change it.
  const typeLoads: TypeDecisionLoad[] = [];
  for (const typeId of typeIds) {
    const mine = own.get(typeId);
    if (mine === undefined) continue;
    const above = walkTypeParentChain(graph, typeId).chainTypeIds.map((id) => own.get(id)).filter((s): s is TypeDecisionShare => s !== undefined);
    typeLoads.push({ typeId, shares: [mine, ...above] });
  }

  return { clashes, typeLoads };
}
