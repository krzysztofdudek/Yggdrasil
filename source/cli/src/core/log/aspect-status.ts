/**
 * source/cli/src/core/log/aspect-status.ts — a rule's STANDING as part of its
 * history.
 *
 * A rule's status is the whole of its authority: draft enforces nothing,
 * advisory reports without blocking, enforced refuses. Moving a rule between
 * those is the most consequential thing anyone does to it, and until now it left
 * no trace at all — the status lives in the rule's own file, people edit that
 * file by hand, and a diff in a commit is not a history anyone can read a year
 * later from the rule itself.
 *
 * Two halves close that, mirroring the port-contract check beside it:
 *
 *  - RECORDING. A change made through the CLI is written into the rule's log in
 *    ONE fixed shape — from, to, who decided, on what evidence — chosen so that
 *    a person reads it as a sentence and a later run reads it back as a fact.
 *  - NOTICING. The standing each rule was last seen at is remembered beside the
 *    local verdict cache. A change made by hand therefore shows up on the next
 *    run as a difference from that memory, and is written into the rule's own
 *    history exactly once: the approving run records it and advances the memory,
 *    so no later run repeats it, and a plain read-only run reports it without
 *    writing. The memory is deliberately local rather than committed — it says
 *    what THIS checkout has witnessed, so a checkout that has never seen a rule
 *    stays silent about it instead of narrating a change it did not observe.
 *
 * The one thing this must never do is claim a change nobody made. So a status
 * recorded by a caller is checked against the rule's file first, and a drift
 * whose entry the caller already wrote (the log's last recorded standing already
 * names the current one) advances the memory silently instead of saying it twice.
 */

import type { AspectDef, Graph } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import { appendAspectLogEntry, readAspectLog } from './aspect-log.js';

/** The statuses a rule can stand at. The default, when its file names none, is `enforced`. */
export const ASPECT_STATUSES = ['draft', 'advisory', 'enforced'] as const;
export type AspectStatusName = (typeof ASPECT_STATUSES)[number];

/** The status a rule currently stands at, with the default made explicit. */
export function currentStatus(aspect: AspectDef): string {
  return aspect.status ?? 'enforced';
}

/**
 * The fixed opening of a status entry.
 *
 * It is a prefix, not a schema: the line reads as an English sentence, and the
 * part a later run needs — where the rule ended up — is the last quoted status
 * on it. Keeping the machine's needs inside the sentence, rather than in a
 * separate metadata block, is what keeps the log a thing people can read.
 */
const STATUS_PREFIX = 'Status:';

/** Compose the one line every status entry opens with. */
export function statusLine(args: {
  from: string;
  to: string;
  by: string;
  evidence: string;
}): string {
  return `${STATUS_PREFIX} ${args.from} → ${args.to}, decided by ${args.by}. Evidence: ${args.evidence}`;
}

/** The line the tool writes for itself when it finds a standing changed behind its back. */
export function driftLine(from: string, to: string): string {
  return `${STATUS_PREFIX} ${from} → ${to}, changed outside the CLI. Evidence: none was recorded — the rule's file was edited directly, and this entry is the tool writing down what it found so the change is not lost.`;
}

/**
 * The standing the rule's own log last recorded, or null when it has recorded
 * none.
 *
 * Read from the newest entry backwards, because a rule's standing is whatever
 * the most recent record says it is; an older entry is history, not the answer.
 */
export function lastRecordedStatus(entriesNewestFirst: ReadonlyArray<{ body: string }>): string | null {
  for (const entry of entriesNewestFirst) {
    const parsed = parseStatusEntry(entry.body);
    if (parsed !== null) return parsed.to;
  }
  return null;
}

/**
 * The standing an entry recorded, when it recorded one.
 *
 * The same sentence `statusLine` writes, read back: everything before the arrow
 * is where the rule stood, the first word after it is where it ended up. An
 * entry that is not a status entry returns null, which is how a reader tells
 * "this said something else about the rule" from "this moved the rule".
 */
export function parseStatusEntry(body: string): { from: string; to: string } | null {
  const line = body.split('\n').find((l) => l.trimStart().startsWith(STATUS_PREFIX));
  if (line === undefined) return null;
  const arrow = line.indexOf('→');
  if (arrow === -1) return null;
  const from = line.slice(line.indexOf(STATUS_PREFIX) + STATUS_PREFIX.length, arrow).trim();
  const to = line.slice(arrow + 1).trim().split(/[\s,.]+/)[0] ?? '';
  if (from === '' || to === '') return null;
  return { from, to };
}

/** A rule whose standing differs from what the tool last saw. */
export interface AspectStatusDrift {
  aspectId: string;
  from: string;
  to: string;
}

/**
 * Every rule whose current standing differs from the remembered one.
 *
 * A rule the tool has never seen is NOT drift: there is no "from", so there is
 * nothing to report and nothing anybody could act on. Its standing is simply
 * remembered the first time an approving run looks, which is what makes the
 * NEXT change visible.
 */
export function findStatusDrift(graph: Graph, lock: LockFile): AspectStatusDrift[] {
  const remembered = lock.aspects ?? {};
  const drifted: AspectStatusDrift[] = [];
  for (const aspect of graph.aspects) {
    const from = remembered[aspect.id]?.status;
    if (from === undefined) continue;
    const to = currentStatus(aspect);
    if (from !== to) drifted.push({ aspectId: aspect.id, from, to });
  }
  return drifted.sort((a, b) => (a.aspectId < b.aspectId ? -1 : a.aspectId > b.aspectId ? 1 : 0));
}

/** What an approving run did about the standings it found. */
export interface RecordStatusResult {
  /** True when the remembered standings changed and the lock must be persisted. */
  changed: boolean;
  /** The rules whose change was written into their own log by this run. */
  recorded: AspectStatusDrift[];
}

/**
 * Bring the remembered standings up to date, writing one log entry for every
 * change that was made outside the CLI and is not already recorded.
 *
 * Called only from an approving run — the sanctioned writer of the lock — so a
 * plain read-only run keeps its promise to write nothing while still being able
 * to report the same difference.
 */
export async function recordAspectStatuses(
  graph: Graph,
  lock: LockFile,
  nowMs: number,
): Promise<RecordStatusResult> {
  const remembered = (lock.aspects ??= {});
  const recorded: AspectStatusDrift[] = [];
  let changed = false;

  for (const aspect of graph.aspects) {
    const to = currentStatus(aspect);
    const from = remembered[aspect.id]?.status;

    if (from === undefined) {
      // First sighting: remember it silently. There is no change to narrate —
      // writing "this rule stands at enforced" into every rule's log would be
      // noise, and noise is what stops a log from being read.
      remembered[aspect.id] = { status: to };
      changed = true;
      continue;
    }
    if (from === to) continue;

    // The caller may already have recorded this change themselves. Deciding that
    // by reading the rule's own log — rather than by trusting a flag — is what
    // makes the two paths agree even when they are run days apart.
    const log = await readAspectLog(graph.rootPath, aspect.id);
    const alreadyRecorded = log.ok && lastRecordedStatus(log.entries) === to;

    if (!alreadyRecorded) {
      const entry = await appendAspectLogEntry({
        yggRootPath: graph.rootPath,
        aspectId: aspect.id,
        reasonText: driftLine(from, to),
        nowMs,
      });
      // A log that cannot be written must not advance the memory: the change
      // would then be neither recorded nor noticeable ever again.
      if (!entry.ok) continue;
      recorded.push({ aspectId: aspect.id, from, to });
    }

    remembered[aspect.id] = { status: to };
    changed = true;
  }

  return { changed, recorded };
}
