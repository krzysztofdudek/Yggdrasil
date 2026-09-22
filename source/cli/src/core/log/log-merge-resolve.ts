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
import { validateAppendOnly } from '../log-integrity.js';
import { validateFormat } from '../log-format.js';

export interface LogMergeResolveInput {
  graph: Graph;
  nodePath: string;
  repoRoot: string;
  /**
   * The two sides of a merge that left no merge commit behind — a script that
   * merges branch logs into the working tree, a squash, a rebase. Absent ⇒ HEAD
   * must be the merge commit and its two parents are the sides. `base` defaults
   * to the merge base of `ours` and `theirs`.
   */
  sides?: { ours: string; theirs: string; base?: string };
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

  if (input.sides === undefined && !(await isMergeCommit(repoRoot, 'HEAD'))) {
    return {
      ok: false,
      error: {
        what: 'HEAD is not a merge commit',
        why: 'yg log merge-resolve verifies the merged log against the two sides of the merge, and with no merge commit at HEAD it has no sides to read.',
        next: `Run it on the merge commit (git merge --no-ff), or, for a merge that left no merge commit, name the two sides: yg log merge-resolve --node ${nodePath} --ours <ref> --theirs <ref>.`,
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

  const gitLogPath = `.yggdrasil/model/${nodePath}/log.md`;
  let ancestorLog: string;
  let parent1Log: string;
  let parent2Log: string;
  try {
    const [parent1, parent2] =
      input.sides === undefined
        ? await getMergeParents(repoRoot, 'HEAD')
        : [input.sides.ours, input.sides.theirs];
    const ancestorSha = input.sides?.base ?? (await getMergeBase(repoRoot, parent1, parent2));
    ancestorLog = await getFileAtRef(repoRoot, ancestorSha, gitLogPath);
    parent1Log = await getFileAtRef(repoRoot, parent1, gitLogPath);
    parent2Log = await getFileAtRef(repoRoot, parent2, gitLogPath);
  } catch (err) {
    debugWrite(`[log-merge-resolve] could not read the merge sides for ${nodePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: {
        what: `Could not read ${gitLogPath} from the two sides of the merge`,
        why: 'The merged log is verified against the log each side had and the log they shared, so every one of those refs must resolve in this repository.',
        next: 'Check the refs with git rev-parse, then re-run with --ours and --theirs naming the two branches that were merged (and --base when they share no merge base).',
      },
    };
  }

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

/**
 * True when a log that fails its append-only check has the shape an
 * interleaving merge leaves: the version at HEAD (or at one of HEAD's parents,
 * when HEAD is the merge commit) still matches the recorded baseline, every one
 * of its entries survives unchanged, and the current log is well formed — so the
 * only change is whole entries sitting before the recorded last entry. `yg
 * check` uses it to point at `yg log merge-resolve` instead of at restoring the
 * file. Best effort: outside a git repository, or on any git failure, false.
 */
export async function looksLikeInterleavedMerge(
  repoRoot: string,
  gitLogPath: string,
  currentLog: string,
  baseline: { last_entry_datetime: string; prefix_hash: string },
): Promise<boolean> {
  if (validateFormat(currentLog).length > 0) return false;
  const key = (e: { datetime: string; body: string }): string => `${e.datetime}\n${e.body}`;
  const current = new Set(parseLog(currentLog).map(key));
  try {
    const refs = ['HEAD'];
    if (await isMergeCommit(repoRoot, 'HEAD')) refs.push(...(await getMergeParents(repoRoot, 'HEAD')));
    for (const ref of refs) {
      const side = await getFileAtRef(repoRoot, ref, gitLogPath);
      if (side === '' || side === currentLog) continue;
      if (!validateAppendOnly(side, baseline.last_entry_datetime, baseline.prefix_hash).ok) continue;
      if (parseLog(side).every((e) => current.has(key(e)))) return true;
    }
  } catch (err) {
    debugWrite(`[log-merge-resolve] could not compare ${gitLogPath} with its git history: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}
