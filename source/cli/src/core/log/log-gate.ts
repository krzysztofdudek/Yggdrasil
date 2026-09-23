/**
 * source/cli/src/core/log/log-gate.ts — shared, read-only log-gate primitives
 * (spec §9).
 *
 * The fill stage (core/fill.ts) USES these to enforce the mandatory-entry gate
 * and record the append-only baseline at positive closure; `yg context` USES the
 * same primitives to DISPLAY the gate state without writing anything. Extracting
 * them here keeps one implementation of the freshness rule and avoids pulling the
 * full fill module (with its LLM-provider dependencies) into the context path.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Graph, GraphNode } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import { parseLog } from '../parsing/log-parser.js';
import { normalizeLogLineEndings } from '../log-integrity.js';
import { readTextFile } from '../../io/graph-fs.js';
import { computeSourceFingerprint, FileUnreadableError } from '../pairs.js';
import { debugWrite } from '../../utils/debug-log.js';
import { toPosixPath } from '../../utils/posix.js';

/**
 * The read-only log-gate state of one node (spec §9), computed ONE way for every
 * surface: the fill gate, positive closure, plain `yg check`, and `yg context`'s
 * display.
 *
 *  - `required`     — the type opts into log_required AND the source changed since
 *                     the stored fingerprint (or none is stored yet), so an entry
 *                     is owed before --approve. Also true when the fingerprint
 *                     cannot be computed: an unverifiable source never counts as
 *                     "unchanged".
 *  - `freshPresent` — an entry newer than the recorded baseline exists now.
 *  - `logHasEntries` — the log holds at least one entry at all; with `required`
 *                     false because a fresh entry already answers, it tells an
 *                     open log cycle (see {@link logCycleOpen}) from a quiet one.
 *  - `unreadable`   — set when a mapped file could not be read, so the
 *                     fingerprint is uncomputable. The real cause to report is
 *                     the file, not a missing log entry.
 */
export interface LogGateState {
  required: boolean;
  freshPresent: boolean;
  logHasEntries: boolean;
  unreadable?: { filePath: string; reason: string };
}

export async function computeLogGateState(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
): Promise<LogGateState> {
  // The default lives HERE and only here (spec §9): false unless the type opts in.
  const archType = graph.architecture.node_types[node.meta.type];
  const logRequired = archType?.log_required ?? false;
  if (!logRequired) return { required: false, freshPresent: false, logHasEntries: false };

  const logContent = await readLogContent(projectRoot, node.path);
  const freshPresent = hasFreshLogEntry(logContent, lock.nodes[node.path]?.log);
  const logHasEntries = parseLog(logContent).length > 0;
  let currentFingerprint: string | undefined;
  try {
    currentFingerprint = await computeSourceFingerprint(graph, node.path);
  } catch (e) {
    if (e instanceof FileUnreadableError) {
      debugWrite(`[log-gate] logGate fingerprint for ${toPosixPath(node.path)}: ${e.message}`);
      return { required: true, freshPresent, logHasEntries, unreadable: { filePath: toPosixPath(e.filePath), reason: e.reason } };
    }
    throw e;
  }
  // A mapping-less node has a constant (undefined) fingerprint — never owed (§9).
  if (currentFingerprint === undefined) return { required: false, freshPresent, logHasEntries };
  return { required: currentFingerprint !== lock.nodes[node.path]?.source, freshPresent, logHasEntries };
}

/**
 * True when a node is blocked by the mandatory-log gate (spec §9): the type opts
 * into log_required (default false) AND the current source fingerprint differs
 * from the stored one (or none is stored and the mapping is non-empty — first
 * verification) AND no fresh log entry exists.
 *
 * This is the SINGLE source of truth for the freshness/fingerprint rule. The fill
 * step-4 gate (logGateBlocks) and positive closure consult it, AND plain
 * `yg check` consults it to enforce the requirement read-only (core/check.ts) —
 * so the requirement bites even on a node that produces no fill pairs, and the
 * three paths can never diverge. It lives HERE (the shared read-only log module)
 * rather than in the fill-specific module so the read path can import it without
 * depending on the write/fill path.
 *
 * A mapping-less node has a constant (undefined) fingerprint — the gate never
 * fires for it (§9). A node with a non-empty mapping but no stored fingerprint is
 * a first verification (drifted = true). An unreadable mapped file makes the
 * fingerprint uncomputable; the node is already a blocking file-unreadable error,
 * so the gate blocks it here too (never fill/close over an unreadable source).
 */
export async function logGateBlocksNode(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
): Promise<boolean> {
  return logGateStateBlocks(await computeLogGateState(graph, projectRoot, node, lock));
}

/** Whether a computed state blocks: an unreadable source always does. */
export function logGateStateBlocks(state: LogGateState): boolean {
  if (state.unreadable) return true;
  return state.required && !state.freshPresent;
}

/**
 * True when a `log_required` node's source has moved past its recorded
 * baseline (or it never had one) while its log holds at least one entry — the
 * log cycle is OPEN. Read off the same {@link LogGateState} the gate itself
 * uses, so the two can never disagree about drift. Paired with
 * {@link logGateStateBlocks} returning false, it means the newest entry is what
 * satisfies the gate for the edit; if no full recording run ever closes the
 * cycle, that same entry keeps answering for every later edit. Unreadable
 * subjects answer false (reported elsewhere).
 */
export function logCycleOpen(state: LogGateState): boolean {
  if (state.unreadable) return false;
  return state.required && state.logHasEntries;
}

/** Read a node's log.md content; empty string when absent. */
export async function readLogContent(projectRoot: string, nodePath: string): Promise<string> {
  const logAbs = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
  try {
    return await readTextFile(logAbs);
  } catch (e: unknown) {
    debugWrite(`[log-gate] readLogContent: could not read ${toPosixPath(logAbs)}: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

/**
 * True when the log contains an entry NEWER than the last baselined one. With no
 * prior log baseline, any entry counts as fresh. (Ported from approve.ts; spec §9.)
 */
export function hasFreshLogEntry(
  logContent: string,
  storedLog: { last_entry_datetime: string } | undefined,
): boolean {
  const newest = parseLog(logContent).at(-1);
  if (!newest) return false;
  if (!storedLog) return true;
  return newest.datetime !== storedLog.last_entry_datetime;
}

/**
 * Compute the append-only log baseline from already-loaded content (boundary
 * datetime + prefix hash over bytes [0..newest.offsetEnd)). Returns undefined
 * when the log has no entries. This is the byte-range the validateAppendOnly
 * contract verifies — NOT the whole file (spec §9). Line endings are
 * normalised first, exactly as validateAppendOnly does, so the baseline does
 * not depend on whether the checkout uses LF or CRLF.
 */
export function computeLogBaselineFromContent(
  content: string,
): { last_entry_datetime: string; prefix_hash: string } | undefined {
  const normalized = normalizeLogLineEndings(content);
  const entries = parseLog(normalized);
  if (entries.length === 0) return undefined;
  const newest = entries[entries.length - 1];
  const bytes = Buffer.from(normalized, 'utf-8');
  const prefix = bytes.subarray(0, newest.offsetEnd);
  return {
    last_entry_datetime: newest.datetime,
    prefix_hash: createHash('sha256').update(prefix).digest('hex'),
  };
}
