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
import { readTextFile } from '../../io/graph-fs.js';
import { computeSourceFingerprint, FileUnreadableError } from '../pairs.js';
import { debugWrite } from '../../utils/debug-log.js';
import { toPosixPath } from '../../utils/posix.js';

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
  // The default lives HERE and only here (spec §9): false unless the type opts in.
  const archType = graph.architecture.node_types[node.meta.type];
  const logRequired = archType?.log_required ?? false;
  if (!logRequired) return false;

  let currentFingerprint: string | undefined;
  try {
    currentFingerprint = await computeSourceFingerprint(graph, node.path);
  } catch (e) {
    if (e instanceof FileUnreadableError) {
      debugWrite(`[log-gate] logGate fingerprint for ${toPosixPath(node.path)}: ${e.message}`);
      return true;
    }
    throw e;
  }
  if (currentFingerprint === undefined) return false;
  const storedFingerprint = lock.nodes[node.path]?.source;
  const drifted = currentFingerprint !== storedFingerprint;
  if (!drifted) return false;

  const logContent = await readLogContent(projectRoot, node.path);
  return !hasFreshLogEntry(logContent, lock.nodes[node.path]?.log);
}

/** Read a node's log.md content; empty string when absent. */
/**
 * True when a `log_required` node's source has moved past its recorded
 * baseline (or it never had one) while its log holds at least one entry — the
 * log cycle is OPEN. Paired with {@link logGateBlocksNode} returning false, it
 * means the newest entry is what satisfies the gate for the edit; if no full
 * recording run ever closes the cycle, that same entry keeps answering for
 * every later edit. Unreadable subjects answer false (reported elsewhere).
 */
export async function logCycleOpen(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
): Promise<boolean> {
  if (graph.architecture.node_types[node.meta.type]?.log_required !== true) return false;
  let fingerprint: string | undefined;
  try {
    fingerprint = await computeSourceFingerprint(graph, node.path);
  } catch (e) {
    if (e instanceof FileUnreadableError) {
      debugWrite(`[log-gate] logCycleOpen fingerprint for ${toPosixPath(node.path)}: ${e.message}`);
      return false;
    }
    throw e;
  }
  if (fingerprint === undefined || fingerprint === lock.nodes[node.path]?.source) return false;
  return parseLog(await readLogContent(projectRoot, node.path)).length > 0;
}

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
 * Compute the append-only log baseline (boundary datetime + prefix hash over
 * bytes [0..newest.offsetEnd)). Returns undefined when the log has no entries.
 * (Ported from approve.ts computeLogBaseline; spec §9.)
 */
export async function computeLogBaselineForNode(
  projectRoot: string,
  nodePath: string,
): Promise<{ last_entry_datetime: string; prefix_hash: string } | undefined> {
  const content = await readLogContent(projectRoot, nodePath);
  return computeLogBaselineFromContent(content);
}

/**
 * Compute the append-only log baseline from already-loaded content (boundary
 * datetime + prefix hash over bytes [0..newest.offsetEnd)). Returns undefined
 * when the log has no entries. This is the byte-range the validateAppendOnly
 * contract verifies — NOT the whole file (spec §9).
 */
export function computeLogBaselineFromContent(
  content: string,
): { last_entry_datetime: string; prefix_hash: string } | undefined {
  const entries = parseLog(content);
  if (entries.length === 0) return undefined;
  const newest = entries[entries.length - 1];
  const bytes = Buffer.from(content, 'utf-8');
  const prefix = bytes.subarray(0, newest.offsetEnd);
  return {
    last_entry_datetime: newest.datetime,
    prefix_hash: createHash('sha256').update(prefix).digest('hex'),
  };
}
