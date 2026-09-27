import { parseLog } from '../parsing/log-parser.js';
import { logHasConflictMarkers } from '../log-format.js';
import { sharedHistoryOf, unionOf, droppedSinceBase, verifyUnion } from './log-merge-resolve.js';
import { competingSuccessors, withStanding } from './log-supersedes.js';

/**
 * The text merge git's `yg-log` driver performs on one append-only log.md — a
 * node's, a type's or a rule's — given the three versions git hands a merge
 * driver: the merge base, ours and theirs. It is a pure function of the three
 * texts: it reads no graph, no lock and no repository, because a driver is
 * handed one file and nothing else. The lock is never touched here; the
 * baseline of a merged log is recorded afterwards by `yg log merge-resolve`
 * run with no target (the post-merge step), which does see the repository.
 *
 * Clean: the union `yg log merge-resolve` itself would write — the history both
 * sides share, byte for byte, then every entry either side added after it, in
 * date order — and it verifies under the same rule merge-resolve verifies a
 * hand resolution with, so what the driver writes is exactly what
 * merge-resolve accepts afterwards.
 *
 * Refused (the file gets conflict markers and the driver exits non-zero, so
 * git stops the merge on it, exactly as with no driver at all):
 *   - `history-rewritten`: the two sides share no history, one side rewrote an
 *     entry the other still holds, or a side dropped an entry the base had;
 *   - `out-of-order`: the union would not verify — an added entry dated at or
 *     before the last shared one, or two added entries with one timestamp;
 *   - `supersedes-conflict`: each side replaced the same entry with a decision
 *     of its own, so the union would hold two successors in force (a conflict
 *     already present on one side alone is that side's, not this merge's, and
 *     does not refuse);
 *   - `conflict-markers`: a side already carries markers.
 */
export type LogTextMerge =
  | { ok: true; text: string }
  | { ok: false; reason: LogTextMergeRefusal; detail: string; text: string };

export type LogTextMergeRefusal = 'history-rewritten' | 'out-of-order' | 'supersedes-conflict' | 'conflict-markers';

/** The labels the markers carry, the ones `git merge-file -L ours -L base -L theirs` writes. */
const OURS_MARK = '<<<<<<< ours';
const SPLIT_MARK = '=======';
const THEIRS_MARK = '>>>>>>> theirs';

export function mergeLogTexts(base: string, ours: string, theirs: string): LogTextMerge {
  if (ours === theirs) return { ok: true, text: ours };
  if (logHasConflictMarkers(ours) || logHasConflictMarkers(theirs)) {
    return refused('conflict-markers', 'one side already carries conflict markers', '', ours, theirs);
  }
  const shared = sharedHistoryOf(ours, theirs);
  if (shared === null) return refused('history-rewritten', 'the two sides differ before their first entry', '', ours, theirs);
  const prefix = shared.prefix.toString('utf-8');
  if (shared.clash !== null) {
    return refused('history-rewritten', `both sides hold a different entry dated ${shared.clash}`, prefix, ours, theirs);
  }
  for (const [label, side] of [['ours', ours], ['theirs', theirs]] as const) {
    const dropped = droppedSinceBase(base, side);
    if (dropped.length > 0) {
      return refused('history-rewritten', `${label} dropped or changed ${dropped.join(', ')} from the merge base`, prefix, ours, theirs);
    }
  }
  const union = unionOf(shared);
  const bad = verifyUnion(union, shared);
  if (bad !== null) return refused('out-of-order', bad.what, prefix, ours, theirs);
  const already = new Set([...conflictKeys(ours), ...conflictKeys(theirs)]);
  const fresh = competingSuccessors(withStanding(parseLog(union))).filter((c) => !already.has(keyOf(c)));
  if (fresh.length > 0) {
    const what = fresh.map((c) => `${c.target} replaced by ${c.successors.join(' and ')}`).join('; ');
    return refused('supersedes-conflict', `both sides superseded the same entry: ${what}`, prefix, ours, theirs);
  }
  return { ok: true, text: union };
}

function keyOf(c: { target: string; successors: string[] }): string {
  return `${c.target}\n${[...c.successors].sort().join('\n')}`;
}

function conflictKeys(log: string): string[] {
  return competingSuccessors(withStanding(parseLog(log))).map(keyOf);
}

/**
 * A refusal's file: what both sides share, then ours' remainder and theirs'
 * remainder between conflict markers — the shape `yg log merge-resolve` and
 * `yg check` already recognise as an unreconciled merge, and the one a person
 * resolves by hand. With no shared prefix the whole of both sides is marked.
 */
function refused(reason: LogTextMergeRefusal, detail: string, prefix: string, ours: string, theirs: string): LogTextMerge {
  const tail = (s: string): string => {
    const rest = s.startsWith(prefix) ? s.slice(prefix.length) : s;
    return rest === '' || rest.endsWith('\n') ? rest : `${rest}\n`;
  };
  const head = prefix === '' || prefix.endsWith('\n') ? prefix : `${prefix}\n`;
  const text = `${head}${OURS_MARK}\n${tail(ours)}${SPLIT_MARK}\n${tail(theirs)}${THEIRS_MARK}\n`;
  return { ok: false, reason, detail, text };
}
