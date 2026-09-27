import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { debugWrite } from '../utils/debug-log.js';
import { mergeLogTexts } from '../core/log/log-merge-driver.js';
import { mergeLockTexts } from '../io/lock-store.js';
import { fail } from './output.js';
import { abortOnUnexpectedError } from './preamble.js';

/**
 * `yg merge-driver <log|lock> <base> <ours> <theirs> [path]` — the git merge
 * drivers for the files Yggdrasil owns. Git runs it (`merge.yg-log.driver`,
 * `merge.yg-lock.driver`, with `%O %A %B %P`) for every path the committed
 * `.gitattributes` gives `merge=yg-log` or `merge=yg-lock`; nobody types it.
 *
 *  - `log`: an append-only log.md, merged as text — see mergeLogTexts.
 *  - `lock`: a committed yg-lock.*.json, merged per key and independent of the
 *    merge's direction — see mergeLockTexts.
 *
 * The contract git holds a driver to, and the three ways a driver loses work
 * silently, each closed here:
 *  - the result is ALWAYS written over <ours> before exiting 0 — a driver that
 *    exits 0 without writing makes a clean merge of the wrong content;
 *  - a refusal writes conflict markers over <ours> and exits 1, so git stops on
 *    the file as it would with no driver;
 *  - anything unexpected (an unreadable side, a bug) falls back to git's own
 *    three-way text merge with markers (`git merge-file`) and exits 1, never
 *    leaving <ours> alone as if it were the answer.
 * (The fourth way — a driver configured whose program is gone — is closed where
 * the driver is configured: `yg init` writes a command that falls back to
 * `git merge-file` when this CLI is missing.)
 */
export function registerMergeDriverCommand(program: Command): void {
  program
    .command('merge-driver')
    .description(
      "The git merge driver for Yggdrasil's own files, run by git, not by hand: log merges an append-only log.md (union of both sides in date order; markers and exit 1 when history was rewritten or both sides superseded the same entry), lock merges a committed yg-lock.*.json (union of keys, a key both sides changed differently drops out). Writes the result over <ours>",
    )
    .argument('<kind>', 'log | lock')
    .argument('<base>', 'the merge base version (%O)')
    .argument('<ours>', 'our version, overwritten with the result (%A)')
    .argument('<theirs>', 'their version (%B)')
    .argument('[path]', 'the path being merged (%P), for messages')
    .action((kind: string, base: string, ours: string, theirs: string, path: string | undefined) => {
      process.exitCode = runMergeDriver(kind, base, ours, theirs, path ?? ours);
    });
}

/**
 * The driver itself: 0 when <ours> now holds a clean merge, 1 when it holds conflict markers.
 * An unexpected error first writes git's own markers over <ours>, then aborts with exit 1
 * and the error on stderr, so git stops on the file and the person merging sees why.
 */
function runMergeDriver(kind: string, basePath: string, oursPath: string, theirsPath: string, shownPath: string): number {
  try {
    if (kind !== 'log' && kind !== 'lock') {
      fail({
        what: `yg merge-driver does not know the kind '${kind}'`,
        why: 'The drivers are log (an append-only log.md) and lock (a committed yg-lock.*.json); git was configured with another. The file got git\'s own text merge, with markers.',
        next: 'yg init --upgrade  (rewrites the merge driver configuration)',
      }, 'usage');
      return fallBack(basePath, oursPath, theirsPath);
    }
    const [base, ours, theirs] = [basePath, oursPath, theirsPath].map(readSide);
    if (kind === 'log') {
      const merged = mergeLogTexts(base, ours, theirs);
      writeFileSync(oursPath, merged.text, 'utf-8');
      if (merged.ok) return 0;
      fail({
        code: 'merge-driver-refused',
        what: `${shownPath}: the log driver left conflict markers — ${merged.detail}`,
        why: 'A union of the two sides would drop, rewrite or contradict an entry, so the merge stops on the file instead of guessing.',
        next: merged.reason === 'supersedes-conflict'
          ? `yg log merge-resolve --node <path> (or --type <type>) writes the union and names the entry that settles it`
          : `Restore the rewritten entries on the side that changed them, or resolve by hand, then run yg log merge-resolve --node <path> (or --type <type>)`,
      });
      return 1;
    }
    const merged = mergeLockTexts(base, ours, theirs);
    if (merged.ok) {
      writeFileSync(oursPath, merged.text, 'utf-8');
      return 0;
    }
    fail({
      code: 'merge-driver-refused',
      what: `${shownPath}: the lock driver could not read a side (${merged.why}); git's text merge with markers was written instead`,
      why: 'Keys can only be merged from lock files that parse; a lock is never stitched line by line.',
      next: `git checkout --ours -- ${shownPath}, then yg log merge-resolve and yg check --approve`,
    });
    return fallBack(basePath, oursPath, theirsPath);
  } catch (err) {
    debugWrite(`[merge-driver] ${kind} failed on ${shownPath}, falling back to git merge-file: ${err instanceof Error ? err.message : String(err)}`);
    fallBack(basePath, oursPath, theirsPath);
    abortOnUnexpectedError(err, `yg merge-driver ${kind} on ${shownPath}`);
  }
}

/** A side as text; a side git hands as an empty file (the path absent on that side) is empty text. */
function readSide(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

/**
 * Git's own three-way text merge, markers and all, written over <ours> — what
 * git does when no driver is configured. Exit 1 whatever it found: the driver
 * failed, so the file is not a merge anybody checked, and git must stop on it.
 */
function fallBack(basePath: string, oursPath: string, theirsPath: string): number {
  try {
    execFileSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath], { stdio: 'ignore' });
  } catch (err) {
    // merge-file exits with the number of conflicts: a non-zero exit is its normal answer.
    debugWrite(`[merge-driver] git merge-file exited ${(err as { status?: number }).status ?? '?'}`);
  }
  return 1;
}
