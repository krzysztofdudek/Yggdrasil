import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { IssueMessage } from '../../model/validation.js';
import { validateNodePath } from '../../utils/node-path-validator.js';
import { parseLog } from '../parsing/log-parser.js';
import {
  isMergeCommit,
  getMergeParents,
  getMergeBase,
  getFileAtRef,
} from '../../utils/git-introspect.js';
import { readTextFile } from '../../io/graph-fs.js';
import { debugWrite } from '../../utils/debug-log.js';
import { toPosix } from '../../utils/posix.js';
import { readLock, writeLock, LockInvalidError } from '../../io/lock-store.js';
import { computeLogBaselineFromContent } from './log-gate.js';

export interface LogMergeResolveInput {
  graph: Graph;
  nodePath: string;
  repoRoot: string;
}

export type LogMergeResolveResult =
  | { ok: true; nodePath: string }
  | { ok: false; error: IssueMessage };

export async function logMergeResolve(input: LogMergeResolveInput): Promise<LogMergeResolveResult> {
  const { graph, repoRoot } = input;
  const yggRoot = graph.rootPath;

  const nv = validateNodePath(toPosix(input.nodePath.trim()).replace(/\/$/, ''));
  if (!nv.ok) {
    return {
      ok: false,
      error: {
        what: `Invalid --node value: ${nv.reason}`,
        why: 'Node path must be POSIX-relative to .yggdrasil/model/ without .. or absolute prefixes.',
        next: 'Use a path like billing/cancel (no leading slash, no model/ prefix).',
      },
    };
  }
  const nodePath = nv.normalized;

  if (!graph.nodes.has(nodePath)) {
    return {
      ok: false,
      error: {
        what: `Node not found: ${nodePath}`,
        why: 'Node must exist in the graph before its log can be merge-resolved.',
        next: 'Check the --node argument, or create the node first.',
      },
    };
  }

  if (!(await isMergeCommit(repoRoot, 'HEAD'))) {
    return {
      ok: false,
      error: {
        what: 'HEAD is not a merge commit',
        why: 'yg log merge-resolve must run on a merge commit to verify log integrity across branches.',
        next: 'Run this command only after completing a merge (git merge --no-ff).',
      },
    };
  }

  const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
  let currentLog: string;
  try {
    currentLog = await readTextFile(logPath);
  } catch (err) {
    debugWrite(`[log-merge-resolve] log.md unreadable for node ${nodePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: {
        what: `log.md not found for node ${nodePath}`,
        why: 'merge-resolve reconciles an existing per-node log; this node has no log.md in the working tree.',
        next: 'Confirm the --node path. If the node has no log yet, there is nothing to merge-resolve.',
      },
    };
  }

  // Match ONLY the unambiguous open/close markers (7 `<` or 7 `>` at line
  // start), matching core/check.ts's log-conflict guard. DEVIATION from the
  // JSON-lock parity check (io/lock-store.ts, which also keys off `=======`):
  // log.md is markdown, where a line-leading run of `=` is a legitimate setext
  // H1 underline / horizontal rule and would false-positive. A real git
  // conflict always also emits the `<<<<<<<`/`>>>>>>>` markers, so dropping the
  // `=` alternative loses no true-positive detection.
  if (/^<{7}/m.test(currentLog) || /^>{7}/m.test(currentLog)) {
    return {
      ok: false,
      error: {
        what: 'log.md still contains conflict markers',
        why: 'Conflict markers indicate the merge conflict was not fully resolved.',
        next: 'Resolve all conflicts in log.md, then run yg log merge-resolve again.',
      },
    };
  }

  const [parent1, parent2] = await getMergeParents(repoRoot, 'HEAD');
  const ancestorSha = await getMergeBase(repoRoot, parent1, parent2);
  const gitLogPath = `.yggdrasil/model/${nodePath}/log.md`;
  const ancestorLog = await getFileAtRef(repoRoot, ancestorSha, gitLogPath);
  const parent1Log = await getFileAtRef(repoRoot, parent1, gitLogPath);
  const parent2Log = await getFileAtRef(repoRoot, parent2, gitLogPath);

  const ancestorBytes = Buffer.from(ancestorLog, 'utf-8');
  const currentBytes = Buffer.from(currentLog, 'utf-8');
  if (
    currentBytes.length < ancestorBytes.length ||
    !currentBytes.subarray(0, ancestorBytes.length).equals(ancestorBytes)
  ) {
    return {
      ok: false,
      error: {
        what: 'log.md ancestor prefix does not match merge base',
        why: 'The shared history portion of the log must be preserved byte-for-byte during merge resolution.',
        next: 'Restore the ancestor entries at the start of log.md without modification.',
      },
    };
  }

  const ancestorEntries = parseLog(ancestorLog);
  const p1New = parseLog(parent1Log).slice(ancestorEntries.length);
  const p2New = parseLog(parent2Log).slice(ancestorEntries.length);
  const currentEntries = parseLog(currentLog);
  const currentNew = currentEntries.slice(ancestorEntries.length);

  // Match new entries by CONTENT (datetime + body), not datetime alone, and in
  // BOTH directions: every parent-new entry must survive unmodified (no drops,
  // no body edits), and every result-new entry must originate from a parent (no
  // fabricated entries). Datetime-only matching let an altered body or an
  // invented entry pass integrity verification.
  const entryKey = (e: { datetime: string; body: string }): string =>
    createHash('sha256').update(`${e.datetime}\n${e.body}`).digest('hex');

  const parentNew = [...p1New, ...p2New];
  const parentNewKeys = new Set(parentNew.map(entryKey));
  const currentNewKeys = new Set(currentNew.map(entryKey));

  const missing = parentNew.filter(e => !currentNewKeys.has(entryKey(e)));
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        what: `log.md is missing or has altered ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} from merge parents`,
        why: 'Every new log entry from both branches must be preserved byte-for-byte in the merge result.',
        next: `Restore these entries unmodified: ${missing.map(e => e.datetime).join(', ')}`,
      },
    };
  }

  const fabricated = currentNew.filter(e => !parentNewKeys.has(entryKey(e)));
  if (fabricated.length > 0) {
    return {
      ok: false,
      error: {
        what: `log.md contains ${fabricated.length} new entr${fabricated.length === 1 ? 'y' : 'ies'} not present in either merge parent`,
        why: 'A merge resolution may only union the entries from the two branches — it cannot add or alter entries.',
        next: `Remove the fabricated or altered entries: ${fabricated.map(e => e.datetime).join(', ')}`,
      },
    };
  }

  for (let i = 1; i < currentNew.length; i++) {
    if (currentNew[i].datetime <= currentNew[i - 1].datetime) {
      return {
        ok: false,
        error: {
          what: 'New log entries are not in chronological order',
          why: 'Log entries must be ordered by timestamp to maintain a consistent history.',
          next: 'Sort the new entries by datetime (oldest first) after the ancestor entries.',
        },
      };
    }
  }

  // Record the reconciled append-only baseline into the lock's per-node `log`
  // field (spec §9 — the lock is the only home for log integrity state). The
  // prefix_hash covers bytes [0..newest.offsetEnd), matching the
  // validateAppendOnly contract that `yg check` enforces — NOT the whole file.
  // Read-modify-write through the lock store: only the `log` field of this node
  // is touched; every other verdict and node fact survives untouched.
  const baseline = computeLogBaselineFromContent(currentLog);
  if (baseline) {
    let lock;
    try {
      lock = readLock(yggRoot);
    } catch (err) {
      if (err instanceof LockInvalidError) {
        debugWrite(`[log-merge-resolve] readLock returned an invalid lock for node ${nodePath}: ${err.message}`);
        return { ok: false, error: err.messageData };
      }
      throw err;
    }
    const entry = lock.nodes[nodePath] ?? {};
    entry.log = baseline;
    lock.nodes[nodePath] = entry;
    // Only the `nodes` section changed — write just the logs file (no verdict
    // partition, so no deterministicAspectIds needed).
    await writeLock(yggRoot, lock, { scope: 'logs' });
  }

  return { ok: true, nodePath };
}
