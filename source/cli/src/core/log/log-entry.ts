/**
 * source/cli/src/core/log/log-entry.ts — how ONE entry is added to ANY log this
 * tool keeps, in one place.
 *
 * Two things keep a log: a component (its decisions and the reasoning behind
 * them) and a rule (what it is measured against, and why that changed). Both are
 * append-only prose read back by people and by later runs, so both need exactly
 * the same three guarantees, and a second implementation of them would be a
 * second set of bugs:
 *
 *  - ONE entry shape. `## [<ISO datetime>]` on its own line, then the body. The
 *    header is the entry boundary every reader splits on.
 *  - TEXT THAT CANNOT DESTROY THAT BOUNDARY. A body carrying its own level-2
 *    header, or an unclosed code fence, silently swallows every later entry into
 *    itself for anything that parses the file afterwards. Both are refused up
 *    front rather than written and regretted.
 *  - TIME THAT ONLY MOVES FORWARD. A new entry never carries a timestamp at or
 *    before the previous one, whatever the machine clock says — freshness is
 *    decided by comparing datetimes, so a clock that steps backwards would make
 *    a new entry look older than the one it follows.
 *
 * Pure: it takes the existing text and the clock reading and returns the text to
 * write. Reading and writing the file stay with the caller.
 */

import { parseLog } from '../parsing/log-parser.js';
import type { IssueMessage } from '../../model/validation.js';

/** What composing an entry produced: the whole new file, or the reason it was refused. */
export type ComposeLogEntryResult =
  | { ok: true; content: string; datetime: string }
  | { ok: false; error: IssueMessage };

/**
 * Compose the new contents of a log file with one entry appended.
 *
 * `existing` is the file's current text ('' when it does not exist yet), and
 * `nowMs` is the caller's clock reading — this module keeps none of its own.
 */
export function composeLogEntry(
  existing: string,
  reasonText: string,
  nowMs: number,
): ComposeLogEntryResult {
  const trimmed = reasonText.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        what: 'Reason cannot be empty after trim',
        why: 'A log entry must carry justification text.',
        next: 'Provide --reason "<non-empty text>" or a non-empty --reason-file.',
      },
    };
  }

  if (reasonHasLevel2HeaderOutsideFence(reasonText)) {
    return {
      ok: false,
      error: {
        what: 'Reason contains `## ` (level-2 header) outside a code fence',
        why: 'Level-2 headers are reserved for entry headers and would corrupt log structure.',
        next: 'Use ### or deeper for sub-headings, or wrap in ``` fences.',
      },
    };
  }

  if (reasonHasUnbalancedFence(reasonText)) {
    return {
      ok: false,
      error: {
        what: 'Reason contains an unclosed code fence',
        why: 'An unbalanced ``` fence in one entry silently swallows every following `## [datetime]` header into this entry’s body for later readers (yg log read, yg check) — the entry boundary is lost.',
        next: 'Close every ``` fence you open inside --reason (add a matching ``` line), or remove the fence.',
      },
    };
  }

  const datetime = monotonicNow(lastEntryDatetime(existing), nowMs);
  const body = reasonText.endsWith('\n') ? reasonText : reasonText + '\n';
  const entry = `## [${datetime}]\n${body}`;
  const content =
    existing === ''
      ? entry
      : `${existing.endsWith('\n') ? existing : existing + '\n'}${entry}`;
  return { ok: true, content, datetime };
}

/** The datetime of the last entry already in the file, or null when there is none. */
function lastEntryDatetime(content: string): string | null {
  const entries = parseLog(content);
  if (entries.length === 0) return null;
  return entries[entries.length - 1].datetime;
}

/**
 * The clock reading, advanced past the previous entry when it has to be: two
 * entries written inside the same millisecond, or a clock that stepped back,
 * must still produce a strictly later datetime than the entry before.
 */
function monotonicNow(lastEntry: string | null, nowMs: number): string {
  let now = nowMs;
  if (lastEntry !== null) {
    const lastMs = Date.parse(lastEntry);
    if (!Number.isNaN(lastMs) && now <= lastMs) {
      now = lastMs + 1;
    }
  }
  return new Date(now).toISOString();
}

/** True when the body carries its own `## ` header outside a code fence. */
function reasonHasLevel2HeaderOutsideFence(reason: string): boolean {
  const lines = reason.split('\n');
  let fenceOpen = false;
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      if (m && m[2].trim() === '' && m[1].length >= fenceLen) fenceOpen = false;
      continue;
    }
    if (m) {
      fenceOpen = true;
      fenceLen = m[1].length;
      continue;
    }
    if (line.startsWith('## ')) return true;
  }
  return false;
}

/** True when the body opens a code fence it never closes. */
function reasonHasUnbalancedFence(reason: string): boolean {
  const lines = reason.split('\n');
  let fenceOpen = false;
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      if (m && m[2].trim() === '' && m[1].length >= fenceLen) fenceOpen = false;
      continue;
    }
    if (m) {
      fenceOpen = true;
      fenceLen = m[1].length;
    }
  }
  return fenceOpen;
}
