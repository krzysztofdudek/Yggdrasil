/**
 * source/cli/src/core/fill-prompt-size-backfill.ts — record the assembled
 * prompt's size onto verdicts that predate the field.
 *
 * `VerdictEntry.promptChars` is what lets a check answer the §4 prompt-size
 * question without resolving companions and reassembling the prompt, which is
 * the dominant cost of checking a repository where nothing has changed. A
 * verdict written by a CLI from before that field existed has no size recorded,
 * so every check falls back to assembling it live.
 *
 * On its own that fallback would be permanent, not transitional. Nothing rewrites
 * a verdict that is still valid: `--approve` fills only UNVERIFIED pairs, so a
 * repository whose verdicts all hold — exactly the repository the fast path is
 * for — would never record a single size and would keep paying the old cost
 * forever. This step closes that: the first `--approve` after the upgrade writes
 * the sizes verification already computed on its way through.
 *
 * It is free and safe:
 *   - no reviewer is called and no verdict is re-decided — the number was
 *     computed by the read-only verification that just ran;
 *   - `promptChars` is NOT a hash ingredient, so adding it to an entry leaves
 *     that entry's `hash` and `verdict` untouched and still valid;
 *   - only pairs whose stored verdict is VALID are touched. An unverified pair
 *     is about to be filled and will write its own size.
 *
 * The write joins the same serialized lock chain every other fill write uses, so
 * an interrupted run keeps whatever it had already recorded.
 */

import type { LockFile } from '../model/lock.js';
import type { VerifiedPair } from './verify-lock.js';
import { toPosixPath } from '../utils/posix.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Write the live-computed prompt size onto every still-valid LLM entry that has
 * none. Returns how many entries were updated (0 on a lock that already carries
 * them all — the steady state after the first run).
 *
 * `persistLock` is the caller's serialized writer; it is invoked ONCE, after all
 * updates are applied, and only when there was something to write.
 */
export async function backfillPromptSizes(
  lock: LockFile,
  pairs: VerifiedPair[],
  persistLock: () => Promise<void>,
): Promise<number> {
  let updated = 0;
  for (const vp of pairs) {
    const chars = vp.backfillPromptChars;
    if (chars === undefined) continue;
    const entry = lock.verdicts[vp.pair.aspectId]?.[toPosixPath(vp.pair.unitKey)];
    // Defensive: verification only sets the field for a pair whose stored entry
    // it just validated, so the entry is present and lacks the size. A missing
    // one would mean the lock changed under us — skip rather than fabricate.
    /* v8 ignore next */
    if (entry === undefined || entry.promptChars !== undefined) continue;
    entry.promptChars = chars;
    updated += 1;
  }
  if (updated > 0) {
    debugWrite(`[fill] recorded prompt size on ${updated} pre-existing verdict(s)`);
    await persistLock();
  }
  return updated;
}
