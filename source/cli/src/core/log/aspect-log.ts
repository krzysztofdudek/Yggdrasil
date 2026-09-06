/**
 * source/cli/src/core/log/aspect-log.ts — a rule's own log, beside its source.
 *
 * A component records why it is the way it is in a log next to its description.
 * A rule needs the same thing for the same reason: what a rule is measured
 * against changes over time, and the reason a case was taken into its corpus —
 * which incident, which commit, whether the rule caught it — belongs where the
 * rule lives, not only in the commit message that happened to carry it. A clone
 * has the log; a `git log` archaeology dig does not scale to a rule someone
 * meets for the first time.
 *
 * The file is `log.md` inside the rule's own directory. Nothing parses it as
 * part of the graph — it is prose for whoever reads the rule next — and it is
 * deliberately NOT a verdict input: recording why a case was added invalidates
 * nothing, exactly as a component's log does not.
 *
 * Entry shape, the guards on the text, and the forward-only timestamp are the
 * SHARED composer every log here uses; this module only resolves the path and
 * performs the read and the write.
 */

import path from 'node:path';

import type { IssueMessage } from '../../model/validation.js';
import { readLogSafe, statLogFile, writeLogFile } from '../../io/log-store.js';
import { composeLogEntry } from './log-entry.js';
import { toPosixPath } from '../../utils/posix.js';

export interface AspectLogAddInput {
  /** Absolute path of the `.yggdrasil/` graph root. */
  yggRootPath: string;
  /** The rule's id — also its directory path under `aspects/`. */
  aspectId: string;
  /** The prose to record. */
  reasonText: string;
  /** The caller's clock reading; this module keeps none of its own. */
  nowMs: number;
}

export type AspectLogAddResult =
  | { ok: true; datetime: string; logPath: string }
  | { ok: false; error: IssueMessage };

/**
 * Absolute path of a rule's own log file, in POSIX form.
 *
 * It leaves this module — into a result a command may report — so it is
 * normalized here rather than at each place that shows it. Node's filesystem
 * accepts the forward-slash form on every platform, so the path that is written
 * to and the path that is shown stay the same string.
 */
export function aspectLogPath(yggRootPath: string, aspectId: string): string {
  return toPosixPath(path.join(yggRootPath, 'aspects', ...aspectId.split('/'), 'log.md'));
}

/**
 * Append one entry to a rule's log.
 *
 * The same two file-shape refusals a component's log applies hold here: a
 * symlink or a hard-linked file would let an append land somewhere other than
 * where this rule's history is read from.
 */
export async function appendAspectLogEntry(
  input: AspectLogAddInput,
): Promise<AspectLogAddResult> {
  const logPath = aspectLogPath(input.yggRootPath, input.aspectId);

  const stats = await statLogFile(logPath);
  if (stats !== null) {
    if (stats.isSymbolicLink) {
      return {
        ok: false,
        error: {
          what: `The log for rule '${input.aspectId}' is a symbolic link.`,
          why: 'A symlinked log means an append lands somewhere other than beside the rule, so the history a reader finds next to the rule is not the history that was written.',
          next: 'Remove the symlink and let the tool create a regular file in its place.',
        },
      };
    }
    if (stats.hardLinkCount > 1) {
      return {
        ok: false,
        error: {
          what: `The log for rule '${input.aspectId}' has more than one hard link.`,
          why: 'The log is replaced by an atomic rename, which would break every other link to it and leave two divergent histories of the same rule.',
          next: 'Copy the log to a file of its own and replace the hard link with it.',
        },
      };
    }
  }

  const existing = await readLogSafe(logPath);
  const composed = composeLogEntry(existing, input.reasonText, input.nowMs);
  if (!composed.ok) return { ok: false, error: composed.error };

  await writeLogFile(logPath, composed.content);
  return { ok: true, datetime: composed.datetime, logPath };
}
