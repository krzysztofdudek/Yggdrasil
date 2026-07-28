/**
 * source/cli/src/core/fill-closure.ts — positive closure for the fill stage
 * (spec §7 step 5 / §9). After all fills, advances each log_required node's source
 * fingerprint + log baseline IFF every enforced effective pair is FRESHLY
 * verified-approved this run (a single post-fill verifyLock pass is the only
 * source of truth — never the raw stored verdict token).
 *
 * The `nodes.<path>.source` fingerprint is the log gate's drift basis and the gate
 * runs ONLY for log_required nodes — so closure records a source fingerprint ONLY
 * for log_required nodes. A non-log_required node never carries one (it would be
 * dead data that churns the committed logs lock on every source change); it gets
 * an entry only when it owns a log.md, holding just the append-only log baseline.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile, LockNodeEntry } from '../model/lock.js';
import { computeSourceFingerprint, FileUnreadableError } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { computeLogBaselineFromContent, readLogContent } from './log/log-gate.js';
import { validateAppendOnly } from './log-integrity.js';
import { debugWrite } from '../utils/debug-log.js';
import { logGateBlocksNode } from './log/log-gate.js';

/**
 * Positive closure (spec §7 step 5 / §9). For every node, reconcile its
 * `yg-lock.logs.json` entry:
 *
 * NON-log_required nodes — the source fingerprint is the log gate's drift basis,
 * and the gate never runs for them, so recording it would be dead data that churns
 * the committed logs lock on every source change. Such a node is reconciled to its
 * MINIMAL entry: just the append-only log baseline when it owns a log.md (history
 * integrity is independent of log_required), never a source fingerprint, and no
 * entry at all when it has no log.md. A stale source fingerprint left by an earlier
 * CLI version is stripped; an existing log baseline is preserved even if the log.md
 * vanished, so a deleted log is still caught as an integrity violation.
 *
 * log_required nodes — for a node with a missing/stale source fingerprint, advance
 * its fingerprint + log baseline IFF, AT THE END OF THIS RUN, ALL of the following
 * hold:
 *
 *   (a) the node was NOT log-gate-blocked this run (blockedNodes), AND
 *   (b) the node is not blocked by the mandatory-log gate when re-checked here —
 *       this catches a drifted log_required node that never entered the run's
 *       nodeSet (its source change touched only scope/binary-excluded files, so
 *       it produced zero unverified pairs and step 4 never saw it), AND a drifted
 *       log_required node with ZERO enforced pairs (which must NOT vacuously
 *       close without a fresh entry), AND
 *   (c) every ENFORCED effective pair of the node is approved AGAINST CURRENT
 *       INPUTS — i.e. its post-fill verifyLock state is `verified` (a valid entry
 *       carrying an approved token). A pair that is merely stored-`approved` but
 *       is currently `unverified` (inputs changed, not re-verified this run),
 *       `refused`, or `prompt-too-large` does NOT count.
 *
 * INVARIANT: the closure decision NEVER reads lock.verdicts[...].verdict
 * directly. Fresh validity is sourced from a single post-fill verifyLock pass —
 * the authoritative per-pair classification for THIS run — so a stale-but-stored
 * approved token can never advance a fingerprint over code the run did not
 * actually verify (false-green of both the verdict and the §9 log gate).
 *
 * Advisory refusals never block closure (they are not enforced pairs). A
 * log_required node with no enforced pairs at all closes vacuously ONLY when
 * (a)+(b) also hold — for a drifted log_required node that means a fresh log entry
 * is required. Mapping-less log_required nodes have no source fingerprint; their
 * log baseline is still recorded at closure if a log.md exists (spec §9).
 */
export async function applyPositiveClosure(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  blockedNodes: Set<string>,
  persistLock: () => Promise<void>,
): Promise<void> {
  // Single post-fill verification pass: the authoritative per-pair validity for
  // THIS run, computed against the freshly-written lock. This is the ONLY source
  // of truth for closure — never the raw stored verdict token.
  const verification = await verifyLock(graph, lock);
  const byNode = new Map<string, typeof verification.pairs>();
  for (const vp of verification.pairs) {
    // A file with no component has no fingerprint and no log baseline to close —
    // skip nodeless pairs when building the per-node grouping below.
    if (vp.pair.nodePath === undefined) continue;
    const list = byNode.get(vp.pair.nodePath) ?? [];
    list.push(vp);
    byNode.set(vp.pair.nodePath, list);
  }

  let mutated = false;
  for (const [nodePath, node] of graph.nodes) {
    const archType = graph.architecture.node_types[node.meta.type];
    const logRequired = archType?.log_required ?? false;

    // NON-log_required: reconcile to the minimal entry (log baseline only, no
    // source fingerprint). Independent of verdict/gate state.
    if (!logRequired) {
      if (await reconcileNonLogRequiredEntry(projectRoot, nodePath, lock)) mutated = true;
      continue;
    }

    // log_required: record the source fingerprint (the gate's drift basis).
    let currentFingerprint: string | undefined;
    try {
      currentFingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch (e) {
      // An unreadable mapped file makes the fingerprint uncomputable. The node is
      // a blocking file-unreadable error this run — never close over it (advancing
      // the fingerprint/log baseline here would be a stale-green of the §9 gate).
      if (e instanceof FileUnreadableError) {
        debugWrite(`[fill] closure fingerprint for ${nodePath}: ${e.message}`);
        continue;
      }
      throw e;
    }
    if (currentFingerprint === undefined) {
      // Mapping-less log_required node: no source fingerprint to record. Its log
      // baseline is still recorded at closure if a log.md exists (spec §9).
      if (await closeLogBaselineOnly(projectRoot, nodePath, lock)) mutated = true;
      continue;
    }
    const stored = lock.nodes[nodePath]?.source;
    if (currentFingerprint === stored) continue; // fingerprint current — nothing to close

    // (a) A node whose pairs were skipped by the step-4 log gate this run must
    // never close over its stale verdicts.
    if (blockedNodes.has(nodePath)) continue;

    // (b) Re-check the mandatory-log gate here. This independently blocks a
    // drifted log_required node that step 4 never saw (zero unverified pairs) and
    // a drifted log_required node with zero enforced pairs (no vacuous close).
    if (await logGateBlocksNode(graph, projectRoot, node, lock)) continue;

    // (c) Every ENFORCED effective pair must be FRESHLY verified-approved this
    // run (state.kind === 'verified'); stored-approved-but-unverified does NOT
    // count. Advisory refusals are not enforced pairs and never block closure.
    const nodePairs = byNode.get(nodePath) ?? [];
    const allEnforcedApproved = nodePairs
      .filter((vp) => vp.pair.status === 'enforced')
      .every((vp) => vp.state.kind === 'verified');
    if (!allEnforcedApproved) continue; // a red/unverified enforced pair keeps the cycle open

    const entry = lock.nodes[nodePath] ?? {};
    entry.source = currentFingerprint;
    const content = await readLogContent(projectRoot, nodePath);
    const logBaseline = computeLogBaselineFromContent(content);
    // Advance the log baseline only when current content is a pure append over the
    // stored one — never launder a tampered history green (advancing the source
    // fingerprint is unaffected: the read-path integrity check still refuses while
    // the log baseline stays the last known-good value).
    if (logBaseline && !baselineTampered(content, entry.log)) entry.log = logBaseline;
    lock.nodes[nodePath] = entry;
    mutated = true;
  }
  if (mutated) await persistLock();
}

/** True when two log baselines are byte-identical (or both absent). */
function logBaselineEquals(a: LockNodeEntry['log'], b: LockNodeEntry['log']): boolean {
  if (!a || !b) return !a && !b;
  return a.last_entry_datetime === b.last_entry_datetime && a.prefix_hash === b.prefix_hash;
}

/**
 * True when a prior stored baseline exists AND current log content is NOT a pure
 * append over it — i.e. a historical entry inside the hashed prefix was edited.
 * Closure must NEVER overwrite the stored baseline from such tampered content: the
 * freshly-computed baseline would hash the tampered bytes, laundering the break
 * green and hiding it from the read-path integrity check (classifyLogStateFromLock
 * / validateAppendOnly) that otherwise refuses on every `yg check`. When this trips,
 * closure keeps the last known-good baseline so that refusal survives.
 */
function baselineTampered(content: string, priorLog: LockNodeEntry['log']): boolean {
  if (!priorLog) return false;
  return !validateAppendOnly(content, priorLog.last_entry_datetime, priorLog.prefix_hash).ok;
}

/**
 * Reconcile a NON-log_required node's logs-lock entry to its minimal form: the
 * append-only log baseline when it owns a log.md (advance it, like any closure),
 * else preserve an existing baseline so a DELETED log.md is still caught as an
 * integrity violation — and NEVER a source fingerprint. A stale source left by an
 * earlier CLI version is stripped; a node with neither a log.md nor a prior
 * baseline holds no entry at all. Returns true when it changed the lock.
 */
async function reconcileNonLogRequiredEntry(
  projectRoot: string,
  nodePath: string,
  lock: LockFile,
): Promise<boolean> {
  const content = await readLogContent(projectRoot, nodePath);
  const logBaseline = computeLogBaselineFromContent(content);
  const existing = lock.nodes[nodePath];
  // Never launder a tampered history: if current content is not a pure append over
  // the stored baseline, keep the last known-good baseline instead of advancing to
  // the freshly-computed (tampered) one — the read-path integrity check keeps refusing.
  const desiredLog = baselineTampered(content, existing?.log)
    ? existing?.log
    : (logBaseline ?? existing?.log);

  // Desired entry: { log } when a baseline applies, otherwise no entry. Never a source.
  if (!desiredLog) {
    if (existing === undefined) return false;
    delete lock.nodes[nodePath];
    return true;
  }
  if (existing !== undefined && existing.source === undefined && logBaselineEquals(existing.log, desiredLog)) {
    return false; // already minimal + current
  }
  lock.nodes[nodePath] = { log: desiredLog };
  return true;
}

/**
 * Record only the log baseline for a mapping-less log_required node (spec §9).
 * Returns true when it changed the lock.
 */
async function closeLogBaselineOnly(projectRoot: string, nodePath: string, lock: LockFile): Promise<boolean> {
  const content = await readLogContent(projectRoot, nodePath);
  const logBaseline = computeLogBaselineFromContent(content);
  if (!logBaseline) return false;
  const existing = lock.nodes[nodePath];
  if (logBaselineEquals(existing?.log, logBaseline)) return false;
  // Never launder a tampered history green: keep the last known-good baseline.
  if (baselineTampered(content, existing?.log)) return false;
  lock.nodes[nodePath] = { ...(existing ?? {}), log: logBaseline };
  return true;
}
