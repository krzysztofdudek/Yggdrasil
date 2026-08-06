/**
 * source/cli/src/core/check-log-state.ts — everything a plain, read-only check
 * asks of a node's `log.md` (spec §9).
 *
 * Two independent questions, deliberately kept in one module because both read
 * the SAME committed baseline out of the lock and both run over every node:
 *
 *   1. Is the log HONEST — free of conflict markers, append-only against its
 *      recorded baseline, and parseable?
 *   2. Is the log OWED — did a `log_required` node's mapped source change with
 *      no fresh entry to say why?
 *
 * Both are computed live, read-only and at zero reviewer cost. Neither writes
 * anything, and neither depends on a node having any rules or pairs at all —
 * which is exactly what makes the second question bite on a node the fill stage
 * would never even look at.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { readTextFile } from '../io/graph-fs.js';
import { validateAppendOnly } from './log-integrity.js';
import { validateFormat } from './log-format.js';
import { toPosixPath } from '../utils/posix.js';
import { logGateBlocksNode } from './log/log-gate.js';
import type { CheckIssue } from './check-contract.js';

/**
 * Log integrity + format for ALL nodes, reading the append-only baseline from
 * the LOCK (`lock.nodes[path].log`) instead of per-node drift state (spec §9).
 * `validateAppendOnly` / `validateFormat` logic is unchanged. Restore strings
 * reference `.yggdrasil/yg-lock.logs.json` (the committed per-node log baseline).
 */
export async function classifyLogStateFromLock(
  graph: Graph,
  projectRoot: string,
  lock: LockFileForCheck,
  issues: CheckIssue[],
): Promise<void> {
  for (const [nodePath] of graph.nodes) {
    // Normalize the node path for OUTPUT (what/next message text), mirroring the sibling
    // classifyLogRequirement: nodePath is exempt from normalization only for graph-internal
    // lookups, never for values rendered into stdout-facing strings (posix-paths-output).
    const nodePathPosix = toPosixPath(nodePath);
    const logRel = `.yggdrasil/model/${nodePathPosix}/log.md`;
    const logAbs = path.join(projectRoot, logRel);
    let logContent: string | null = null;
    try {
      logContent = await readTextFile(logAbs);
    } catch { /* missing — keep null */ }

    const logBaseline = lock.nodes[nodePath]?.log;

    // Detect git conflict markers FIRST — a conflict-markered log.md cannot be
    // validated for integrity or format, and hand-stitching the two sides would
    // break the append-only integrity hashes. Route to `yg log merge-resolve`.
    //
    // DEVIATION from the JSON-lock parity check (io/lock-store.ts:145, which keys
    // off `<<<<<<<` | `=======` | `>>>>>>>`): we match ONLY the unambiguous
    // open/close markers (7 `<` or 7 `>` at line start). A bare `=======` line is
    // NOT a trigger here — `log.md` is markdown (unlike the JSON lock), where a
    // run of `=` at line start is a legitimate setext H1 underline / horizontal
    // rule and would false-positive. A markdown log body never legitimately starts
    // a line with seven `<` or `>`.
    if (logContent !== null && (/^<{7}/m.test(logContent) || /^>{7}/m.test(logContent))) {
      issues.push({
        severity: 'error',
        code: 'log-conflict',
        rule: 'log-conflict',
        messageData: {
          what: `Log contains git conflict markers at ${logRel}`,
          why: 'A conflict-markered log.md cannot be validated; hand-stitching the two sides breaks the append-only integrity hashes — the merge must be reconciled structurally.',
          next: `yg log merge-resolve --node ${nodePathPosix}`,
        },
        nodePath,
      });
      continue;
    }

    if (logBaseline) {
      const check = validateAppendOnly(
        logContent ?? '',
        logBaseline.last_entry_datetime,
        logBaseline.prefix_hash,
      );
      if (!check.ok) {
        const logIntegrityMd = {
          what: `Log integrity broken (${check.reason}) at ${logRel}${logContent === null ? ' (file missing)' : ''}`,
          why: check.reason === 'prefix_modified'
            ? 'Historical (pre-baseline) log content was modified — append-only violated.'
            : 'Baseline boundary entry not found — log was deleted or reset.',
          next: `Restore from git: git checkout HEAD -- ${logRel} .yggdrasil/yg-lock.logs.json`,
        };
        issues.push({
          severity: 'error',
          code: 'log-integrity',
          rule: 'log-integrity',
          messageData: logIntegrityMd,
          nodePath,
        });
        continue;
      }
    }

    if (logContent === null) continue;

    const violations = validateFormat(logContent);
    if (violations.length > 0) {
      const logFormatMd = {
        what: `Log format invalid at ${logRel}:\n${violations.map((v) => `  line ${v.line}: ${v.reason} — ${v.detail}`).join('\n')}`,
        why: 'Log format must be parseable for indexing and integrity.',
        next: 'Fix format violations (or git checkout) and re-run yg check.',
      };
      issues.push({
        severity: 'error',
        code: 'log-format',
        rule: 'log-format',
        messageData: logFormatMd,
        nodePath,
      });
    }
  }
}

/**
 * The mandatory-log requirement, enforced LIVE on plain `yg check` (spec §9).
 *
 * Independently of any aspect or pair state, a node whose TYPE has
 * `log_required: true` and whose mapped source fingerprint differs from the
 * lock's stored baseline (or has none yet) MUST carry a fresh log entry. The
 * requirement is a property of node TYPE plus a source change, fully DECOUPLED
 * from whether the node has any aspects or pairs — detected here, read-only and
 * at zero LLM cost, not only at `--approve` fill time. This is what makes the
 * requirement bite on a node that produces NO fill pairs (all aspects draft, no
 * effective aspects, or a change touching only non-subject files): such a node
 * is never in the fill's pair-scoped node set, so without this live check an
 * unlogged source change would pass `yg check` green. `--approve` writes
 * nothing new for it — positive closure already refuses to advance the
 * baseline until an entry exists, and the final re-check surfaces this error.
 *
 * Reuses logGateBlocksNode — the single source of truth for the
 * freshness/fingerprint rule shared with the fill gate and positive closure.
 * Nodes with an unreadable mapped subject are skipped: they already surface a
 * blocking file-unreadable error and their fingerprint is uncomputable.
 */
export async function classifyLogRequirement(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  unreadableNodes: Set<string>,
  issues: CheckIssue[],
): Promise<void> {
  for (const [nodePath, node] of graph.nodes) {
    if (unreadableNodes.has(nodePath)) continue;
    if (!(await logGateBlocksNode(graph, projectRoot, node, lock))) continue;
    issues.push({
      severity: 'error',
      code: 'log-entry-missing',
      rule: 'log-entry-missing',
      messageData: {
        what: `No fresh log entry for node '${toPosixPath(nodePath)}' — its source changed but no justification entry exists.`,
        why: `Node type '${node.meta.type}' has log_required: true — every source change needs a log entry capturing WHY. The requirement is a property of the node type plus a source change, independent of aspects; yg check stays red until a fresh entry exists.`,
        next: `yg log add --node ${toPosixPath(nodePath)} --reason '<justification>', then re-run: yg check --approve`,
      },
      nodePath,
    });
  }
}

/** Minimal shape of the lock needed by the check live path. */
export interface LockFileForCheck {
  nodes: Record<string, { log?: { last_entry_datetime: string; prefix_hash: string } }>;
}
