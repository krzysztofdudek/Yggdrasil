import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { IssueMessage } from '../../model/validation.js';
import { validateNodePath } from '../../utils/node-path-validator.js';
import { parseLog } from '../parsing/log-parser.js';
import { firstParentAncestors,
  isMergeCommit,
  getMergeParents,
  getMergeBase,
  getFileAtRef,
  mergeInProgressHead,
} from '../../utils/git-introspect.js';
import { readTextFile, writeTextFile } from '../../io/graph-fs.js';
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
  /** `wroteUnion`: the merge was still in progress with log.md conflicted, and
   *  merge-resolve wrote the union of both sides into it (to be staged and
   *  committed with the rest of the merge). */
  | { ok: true; nodePath: string; wroteUnion?: boolean }
  | { ok: false; error: IssueMessage };

/** Git conflict markers at line start — see the note at the check below. */
const hasConflictMarkers = (text: string): boolean => /^<{7}/m.test(text) || /^>{7}/m.test(text);

/**
 * The union a conflicted log resolves to: the history both sides share, then
 * every entry either side added after it, oldest first, each byte-for-byte as
 * its side wrote it. An entry both sides carry (same datetime and body) appears
 * once. Null when a side does not start with the shared history — a rewritten
 * log is not something a union can repair.
 */
function unionOfSides(ancestorLog: string, oursLog: string, theirsLog: string): string | null {
  const ancestorBytes = Buffer.from(ancestorLog, 'utf-8');
  const sideBytes = [Buffer.from(oursLog, 'utf-8'), Buffer.from(theirsLog, 'utf-8')];
  for (const b of sideBytes) {
    if (b.length < ancestorBytes.length || !b.subarray(0, ancestorBytes.length).equals(ancestorBytes)) return null;
  }
  const ancestorCount = parseLog(ancestorLog).length;
  const seen = new Set<string>();
  const added: Array<{ datetime: string; raw: Buffer }> = [];
  for (const [i, text] of [oursLog, theirsLog].entries()) {
    for (const e of parseLog(text).slice(ancestorCount)) {
      const key = `${e.datetime}\n${e.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let raw = sideBytes[i].subarray(e.offsetStart, e.offsetEnd);
      // The last entry of a side may end without a newline; it may not be last here.
      if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) raw = Buffer.concat([raw, Buffer.from('\n')]);
      added.push({ datetime: e.datetime, raw });
    }
  }
  // Stable sort: equal datetimes keep ours-then-theirs order.
  added.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
  let prefix = ancestorBytes;
  if (prefix.length > 0 && added.length > 0 && prefix[prefix.length - 1] !== 0x0a) prefix = Buffer.concat([prefix, Buffer.from('\n')]);
  return Buffer.concat([prefix, ...added.map((a) => a.raw)]).toString('utf-8');
}

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

  // A merge still in progress (stopped on a conflict, not yet committed) has
  // its two sides on record: HEAD and MERGE_HEAD. That is exactly when a
  // conflicted log.md is met, so it is resolved right there — no merge commit
  // needed, and no hand-editing.
  let sides = input.sides;
  let midMerge = false;
  if (sides === undefined && !(await isMergeCommit(repoRoot, 'HEAD'))) {
    const mergeHead = await mergeInProgressHead(repoRoot);
    if (mergeHead === null) {
      return {
        ok: false,
        error: {
          what: 'HEAD is not a merge commit, and no merge is in progress',
          why: 'yg log merge-resolve reconciles a log against the two sides of a merge. It reads them from a merge in progress (HEAD and MERGE_HEAD) or from the merge commit at HEAD; here there is neither.',
          next: `Run it while the merge is in progress or on the merge commit, or, for a merge that left no merge commit, name the two sides: yg log merge-resolve --node ${nodePath} --ours <ref> --theirs <ref>.`,
        },
      };
    }
    sides = { ours: 'HEAD', theirs: mergeHead };
    midMerge = true;
  }

  const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
  const gitLogPath = `.yggdrasil/model/${nodePath}/log.md`;
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
  const conflicted = hasConflictMarkers(currentLog);
  if (conflicted && !midMerge) {
    return {
      ok: false,
      error: {
        what: 'log.md still contains conflict markers',
        why: 'Conflict markers mean the merge of this log was never reconciled. merge-resolve writes the union itself only while the merge is still in progress; here it is not, so it can only verify a log that is already whole.',
        next: `Keep every entry from both sides, remove the markers, order the entries by datetime (oldest first), then run: yg log merge-resolve --node ${nodePath}${input.sides !== undefined ? ` --ours ${input.sides.ours} --theirs ${input.sides.theirs}` : ''}.`,
      },
    };
  }

  let ancestorLog: string;
  let parent1Log: string;
  let parent2Log: string;
  try {
    const [parent1, parent2] =
      sides === undefined
        ? await getMergeParents(repoRoot, 'HEAD')
        : [sides.ours, sides.theirs];
    const ancestorSha = sides?.base ?? (await getMergeBase(repoRoot, parent1, parent2));
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

  // Mid-merge with the log conflicted: write the union of both sides, then
  // verify it like any other resolution.
  let wroteUnion = false;
  if (conflicted) {
    const union = unionOfSides(ancestorLog, parent1Log, parent2Log);
    if (union === null) {
      return {
        ok: false,
        error: {
          what: `The two sides of the merge do not share ${gitLogPath}'s history`,
          why: 'A union keeps the shared history byte-for-byte and adds what each side appended. One side here rewrote that shared part, so there is no union to write — the rewrite has to be undone on that side.',
          next: `Abort the merge (git merge --abort), restore the shared entries on the side that changed them, and merge again.`,
        },
      };
    }
    await writeTextFile(logPath, union);
    currentLog = union;
    wroteUnion = true;
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

  return { ok: true, nodePath, ...(wroteUnion ? { wroteUnion } : {}) };
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
/** How far back the first-parent line is searched for the version a baseline was recorded from. */
const ANCESTOR_WALK_LIMIT = 50;

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
    // A squash or a rebase that is already committed leaves HEAD holding the interleaved log itself, so
    // HEAD says nothing about the history before it. The version the recorded baseline was taken from
    // then sits further back on the first-parent line; a bounded walk finds it.
    if ((await getFileAtRef(repoRoot, 'HEAD', gitLogPath)) === currentLog) {
      refs.push(...(await firstParentAncestors(repoRoot, 'HEAD', ANCESTOR_WALK_LIMIT)));
    }
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
