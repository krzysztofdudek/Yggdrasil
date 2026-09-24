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
  resolveCommit,
  gitDirPath,
} from '../../utils/git-introspect.js';
import { readTextFile, writeTextFile, statKind } from '../../io/graph-fs.js';
import { debugWrite } from '../../utils/debug-log.js';
import { toPosixPath } from '../../utils/posix.js';
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

/** The git operation found stopped mid-way, whose two sides merge-resolve read. */
export type InProgressOperation = 'merge' | 'rebase' | 'cherry-pick';

export type LogMergeResolveResult =
  /** `wroteUnion`: a merge, rebase or cherry-pick was still in progress with
   *  log.md conflicted, and merge-resolve wrote the union of both sides into it
   *  (to be staged and carried on with the rest of that operation).
   *  `inProgress`: which operation that was, so the caller can name the command
   *  that finishes it. */
  | { ok: true; nodePath: string; wroteUnion?: boolean; inProgress?: InProgressOperation }
  | { ok: false; error: IssueMessage };

/** How each in-progress operation is finished and abandoned — for messages. */
export const OPERATION_COMMANDS: Record<InProgressOperation, { finish: string; abort: string }> = {
  merge: { finish: 'git commit', abort: 'git merge --abort' },
  rebase: { finish: 'git rebase --continue', abort: 'git rebase --abort' },
  'cherry-pick': { finish: 'git cherry-pick --continue', abort: 'git cherry-pick --abort' },
};

/**
 * A rebase or a cherry-pick stopped mid-replay (on a conflict, not yet
 * continued): the commit being replayed onto HEAD — `REBASE_HEAD` or
 * `CHERRY_PICK_HEAD` — or null when neither is under way, outside a repository,
 * or on any git failure. A rebase counts only while its state directory
 * (`rebase-merge/` or `rebase-apply/`) exists, so a `REBASE_HEAD` a finished
 * rebase left behind is not mistaken for one.
 */
async function replayInProgress(repoRoot: string): Promise<{ kind: 'rebase' | 'cherry-pick'; commit: string } | null> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = await gitDirPath(repoRoot, dir);
    if (p === null || (await statKind(p)) !== 'dir') continue;
    const commit = await resolveCommit(repoRoot, 'REBASE_HEAD');
    if (commit !== null) return { kind: 'rebase', commit };
  }
  const picked = await resolveCommit(repoRoot, 'CHERRY_PICK_HEAD');
  return picked === null ? null : { kind: 'cherry-pick', commit: picked };
}

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

/**
 * A side's entry as it stands once it is no longer the last thing in its file.
 *
 * Only the final entry of a log can lack a trailing newline: every other entry
 * runs up to the next header, which starts a line. A union places that entry
 * wherever its datetime falls and gives it the newline it needs there (see
 * {@link unionOfSides}), and a hand resolution has to do the same. The missing
 * final newline of a side is therefore not part of the entry's content, and the
 * side's entry is compared with it restored. Nothing else is normalised: any
 * other difference in the body, whitespace included, is still an altered entry.
 */
function withFinalNewline<E extends { body: string }>(e: E): E {
  return e.body === '' || e.body.endsWith('\n') ? e : { ...e, body: `${e.body}\n` };
}

const entryKeyOf = (e: { datetime: string; body: string }): string =>
  createHash('sha256').update(`${e.datetime}\n${e.body}`).digest('hex');

/** An entry's bytes as it stands in its side, ending in a newline wherever it lands. */
function entryBytes(sideBytes: Buffer, e: { offsetStart: number; offsetEnd: number }): Buffer {
  const raw = sideBytes.subarray(e.offsetStart, e.offsetEnd);
  return raw.length > 0 && raw[raw.length - 1] !== 0x0a ? Buffer.concat([raw, Buffer.from('\n')]) : raw;
}

/**
 * What a replayed commit (the commit a rebase or a cherry-pick is applying)
 * adds to a log: its entries that its own parent did not have — no more. A
 * cherry-pick carries one commit's change, not the history behind it, and a
 * rebase replays one commit at a time, so an entry the parent already had is
 * either on HEAD already (replayed earlier) or deliberately not being carried.
 * Null when the commit dropped or changed an entry its parent had — a rewrite,
 * which no union can carry.
 */
function replayedEntries(parentLog: string, replayedLog: string): ReturnType<typeof parseLog> | null {
  const replayed = parseLog(replayedLog);
  const replayedKeys = new Set(replayed.map((e) => entryKeyOf(withFinalNewline(e))));
  const parentKeys = parseLog(parentLog).map((e) => entryKeyOf(withFinalNewline(e)));
  if (parentKeys.some((k) => !replayedKeys.has(k))) return null;
  const parentKeySet = new Set(parentKeys);
  return replayed.filter((e) => !parentKeySet.has(entryKeyOf(withFinalNewline(e))));
}

/**
 * The log a replay stop resolves to: HEAD's log kept whole and in its order,
 * with every entry the replayed commit added (and HEAD does not already carry)
 * placed where its datetime falls — each entry byte-for-byte as its side wrote
 * it. On equal datetimes HEAD's entry comes first.
 */
function replayUnion(oursLog: string, added: ReturnType<typeof parseLog>, replayedLog: string): string {
  const oursBytes = Buffer.from(oursLog, 'utf-8');
  const replayedBytes = Buffer.from(replayedLog, 'utf-8');
  const ours = parseLog(oursLog);
  const have = new Set(ours.map((e) => entryKeyOf(withFinalNewline(e))));
  const seen = new Set<string>();
  const extra = added
    .filter((e) => {
      const k = entryKeyOf(withFinalNewline(e));
      if (have.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((e) => ({ datetime: e.datetime, raw: entryBytes(replayedBytes, e) }))
    .sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
  if (extra.length === 0) return oursLog;
  let preamble = oursBytes.subarray(0, ours.length > 0 ? ours[0].offsetStart : oursBytes.length);
  if (preamble.length > 0 && preamble[preamble.length - 1] !== 0x0a) preamble = Buffer.concat([preamble, Buffer.from('\n')]);
  const out: Buffer[] = [preamble];
  let j = 0;
  for (const e of ours) {
    while (j < extra.length && extra[j].datetime < e.datetime) out.push(extra[j++].raw);
    out.push(entryBytes(oursBytes, e));
  }
  while (j < extra.length) out.push(extra[j++].raw);
  return Buffer.concat(out).toString('utf-8');
}

/**
 * Verify a log reconciled at a replay stop: it holds exactly HEAD's entries and
 * the replayed commit's added ones — none dropped or altered, none invented —
 * with HEAD's entries in their original order and every added entry in date
 * order against its neighbours. Null when it does.
 */
function verifyReplayResolution(
  currentLog: string,
  oursLog: string,
  added: ReturnType<typeof parseLog>,
  replay: { kind: 'rebase' | 'cherry-pick'; commit: string },
): IssueMessage | null {
  const ours = parseLog(oursLog).map(withFinalNewline);
  const addedNorm = added.map(withFinalNewline);
  const current = parseLog(currentLog);
  const currentKeys = new Set(current.map(entryKeyOf));
  const expected = [...ours, ...addedNorm];
  const expectedKeys = new Set(expected.map(entryKeyOf));
  const short = replay.commit.slice(0, 12);
  const replayed = replay.kind === 'rebase' ? `the commit being rebased (${short})` : `the commit being cherry-picked (${short})`;

  const missing = expected.filter((e) => !currentKeys.has(entryKeyOf(e)));
  if (missing.length > 0) {
    return {
      what: `log.md is missing or has altered ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} from HEAD or ${replayed}`,
      why: `Every entry HEAD carries and every entry ${replayed} adds must survive byte-for-byte in the ${replay.kind} result.`,
      next: `Restore these entries unmodified: ${missing.map((e) => e.datetime).join(', ')}`,
    };
  }
  const fabricated = current.filter((e) => !expectedKeys.has(entryKeyOf(e)));
  if (fabricated.length > 0) {
    return {
      what: `log.md contains ${fabricated.length} entr${fabricated.length === 1 ? 'y' : 'ies'} found neither on HEAD nor added by ${replayed}`,
      why: `A ${replay.kind} resolution may only union HEAD's log with the entries the replayed commit adds — it cannot add or alter entries.`,
      next: `Remove the fabricated or altered entries: ${fabricated.map((e) => e.datetime).join(', ')}`,
    };
  }
  const oursKeys = new Set(ours.map(entryKeyOf));
  const oursOrder = current.filter((e) => oursKeys.has(entryKeyOf(e))).map(entryKeyOf);
  const outOfOrder = oursOrder.some((k, i) => k !== entryKeyOf(ours[i]));
  const addedKeys = new Set(addedNorm.map(entryKeyOf));
  const undated = current.some(
    (e, i) =>
      i > 0 &&
      (addedKeys.has(entryKeyOf(e)) || addedKeys.has(entryKeyOf(current[i - 1]))) &&
      e.datetime <= current[i - 1].datetime,
  );
  if (outOfOrder || undated) {
    return {
      what: 'log.md entries are not in chronological order',
      why: "HEAD's entries keep their order, and each entry the replayed commit adds sits where its timestamp falls, so the log stays one dated, append-only history.",
      next: `Order the entries by datetime (oldest first), keeping HEAD's own entries in their order — or restore the conflicted file (git checkout --conflict=merge -- <log.md>) and let yg log merge-resolve write it.`,
    };
  }
  return null;
}

/**
 * Record the reconciled append-only baseline into the lock's per-node `log`
 * field (spec §9 — the lock is the only home for log integrity state). The
 * prefix_hash covers bytes [0..newest.offsetEnd), matching the
 * validateAppendOnly contract that `yg check` enforces — NOT the whole file.
 * Read-modify-write through the lock store: only the `log` field of this node
 * is touched; every other verdict and node fact survives untouched.
 */
async function recordBaseline(yggRoot: string, nodePath: string, currentLog: string): Promise<IssueMessage | null> {
  const baseline = computeLogBaselineFromContent(currentLog);
  if (!baseline) return null;
  let lock;
  try {
    lock = readLock(yggRoot);
  } catch (err) {
    if (err instanceof LockInvalidError) {
      debugWrite(`[log-merge-resolve] readLock returned an invalid lock for node ${nodePath}: ${err.message}`);
      return err.messageData;
    }
    throw err;
  }
  const entry = lock.nodes[nodePath] ?? {};
  entry.log = baseline;
  lock.nodes[nodePath] = entry;
  // Only the `nodes` section changed — write just the logs file (no verdict
  // partition, so no deterministicAspectIds needed).
  await writeLock(yggRoot, lock, { scope: 'logs' });
  return null;
}

export async function logMergeResolve(input: LogMergeResolveInput): Promise<LogMergeResolveResult> {
  const { graph, repoRoot } = input;
  const yggRoot = graph.rootPath;

  const nv = validateNodePath(toPosixPath(input.nodePath.trim()).replace(/\/+$/, ''));
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
  // needed, and no hand-editing. A merge in progress wins over a merge commit at HEAD: on a branch whose
  // tip is itself a merge (every --no-ff merge), HEAD's parents are the PREVIOUS
  // merge, not the one whose conflict is being resolved now.
  //
  // A rebase or a cherry-pick stopped on a conflict is the same situation with
  // other names: HEAD is the side being built on (the upstream a rebase replays
  // onto, the branch a cherry-pick lands on) and REBASE_HEAD / CHERRY_PICK_HEAD
  // is the commit being replayed. What that commit brings is its own change —
  // the entries it added over its parent — not the merge base's whole branch.
  let sides = input.sides;
  let inProgress: InProgressOperation | null = null;
  let replay: { kind: 'rebase' | 'cherry-pick'; commit: string } | null = null;
  if (sides === undefined) {
    const mergeHead = await mergeInProgressHead(repoRoot);
    if (mergeHead !== null) {
      sides = { ours: 'HEAD', theirs: mergeHead };
      inProgress = 'merge';
    } else {
      replay = await replayInProgress(repoRoot);
      if (replay !== null) {
        inProgress = replay.kind;
      } else if (!(await isMergeCommit(repoRoot, 'HEAD'))) {
        return {
          ok: false,
          error: {
            what: 'HEAD is not a merge commit, and no merge, rebase or cherry-pick is in progress',
            why: 'yg log merge-resolve reconciles a log against the two sides of a merge. It reads them from an operation stopped on a conflict (a merge: HEAD and MERGE_HEAD; a rebase: HEAD and REBASE_HEAD; a cherry-pick: HEAD and CHERRY_PICK_HEAD) or from the merge commit at HEAD; here there is none of them.',
            next: `Run it while the merge, rebase or cherry-pick is stopped on the conflict, or on the merge commit — or, for a merge that left no merge commit, name the two sides: yg log merge-resolve --node ${nodePath} --ours <ref> --theirs <ref>.`,
          },
        };
      }
    }
  }
  const midMerge = inProgress !== null;

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
        why: 'Conflict markers mean the merge of this log was never reconciled. merge-resolve writes the union itself only while the merge, rebase or cherry-pick is still stopped on the conflict; here none is, so it can only verify a log that is already whole.',
        next: `Keep every entry from both sides, remove the markers, order the entries by datetime (oldest first), then run: yg log merge-resolve --node ${nodePath}${input.sides !== undefined ? ` --ours ${input.sides.ours} --theirs ${input.sides.theirs}` : ''}.`,
      },
    };
  }

  if (replay !== null) return resolveReplay({ yggRoot, repoRoot, nodePath, logPath, gitLogPath, currentLog, conflicted, replay });

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
          next: `Abort the merge (${OPERATION_COMMANDS[inProgress ?? 'merge'].abort}), restore the shared entries on the side that changed them, and merge again.`,
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
  const p1New = parseLog(parent1Log).slice(ancestorEntries.length).map(withFinalNewline);
  const p2New = parseLog(parent2Log).slice(ancestorEntries.length).map(withFinalNewline);
  const currentEntries = parseLog(currentLog);
  const currentNew = currentEntries.slice(ancestorEntries.length);

  // Match new entries by CONTENT (datetime + body), not datetime alone, and in
  // BOTH directions: every parent-new entry must survive unmodified (no drops,
  // no body edits), and every result-new entry must originate from a parent (no
  // fabricated entries). Datetime-only matching let an altered body or an
  // invented entry pass integrity verification.
  const entryKey = entryKeyOf;

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

  const lockError = await recordBaseline(yggRoot, nodePath, currentLog);
  if (lockError !== null) return { ok: false, error: lockError };

  return { ok: true, nodePath, ...(wroteUnion ? { wroteUnion } : {}), ...(inProgress !== null ? { inProgress } : {}) };
}

/**
 * merge-resolve at a rebase or cherry-pick stop: HEAD's log plus what the
 * replayed commit added over its own parent, written as their union when the
 * log is conflicted, verified either way, and recorded as the baseline.
 */
async function resolveReplay(args: {
  yggRoot: string;
  repoRoot: string;
  nodePath: string;
  logPath: string;
  gitLogPath: string;
  currentLog: string;
  conflicted: boolean;
  replay: { kind: 'rebase' | 'cherry-pick'; commit: string };
}): Promise<LogMergeResolveResult> {
  const { yggRoot, repoRoot, nodePath, logPath, gitLogPath, conflicted, replay } = args;
  let currentLog = args.currentLog;
  const { abort } = OPERATION_COMMANDS[replay.kind];
  let oursLog: string;
  let parentLog: string;
  let replayedLog: string;
  try {
    oursLog = await getFileAtRef(repoRoot, 'HEAD', gitLogPath);
    replayedLog = await getFileAtRef(repoRoot, replay.commit, gitLogPath);
    const parent = await resolveCommit(repoRoot, `${replay.commit}^1`);
    parentLog = parent === null ? '' : await getFileAtRef(repoRoot, parent, gitLogPath);
  } catch (err) {
    debugWrite(`[log-merge-resolve] could not read the ${replay.kind} sides for ${nodePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: {
        what: `Could not read ${gitLogPath} from HEAD and the commit being replayed`,
        why: `At a ${replay.kind} stop the log is reconciled against HEAD and the replayed commit (with its parent), so each of them must be readable from this repository.`,
        next: `Check git status and the ${replay.kind} state, or ${abort} and start it again.`,
      },
    };
  }

  const added = replayedEntries(parentLog, replayedLog);
  if (added === null) {
    return {
      ok: false,
      error: {
        what: `The commit being replayed (${replay.commit.slice(0, 12)}) rewrote ${gitLogPath}`,
        why: 'A log is append-only: a commit may add entries, never drop or change one its parent had. A union can carry added entries, not a rewrite.',
        next: `${abort}, restore the entries that commit dropped or changed, and run the ${replay.kind} again.`,
      },
    };
  }

  let wroteUnion = false;
  if (conflicted) {
    const union = replayUnion(oursLog, added, replayedLog);
    await writeTextFile(logPath, union);
    currentLog = union;
    wroteUnion = true;
  }

  const bad = verifyReplayResolution(currentLog, oursLog, added, replay);
  if (bad !== null) return { ok: false, error: bad };

  const lockError = await recordBaseline(yggRoot, nodePath, currentLog);
  if (lockError !== null) return { ok: false, error: lockError };
  return { ok: true, nodePath, ...(wroteUnion ? { wroteUnion } : {}), inProgress: replay.kind };
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
