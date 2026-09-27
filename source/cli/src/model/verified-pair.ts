/**
 * One expected pair as lock verification classified it: the pair, its state
 * (verified, refused, unverified, over the prompt limit, or a companion that
 * could not resolve), and the facts read off its stored entry. Pure types, in
 * the model layer so the renderers and the check result name a classified pair
 * without depending on the verifier; core/verify-lock.ts re-exports them.
 */
import type { ExpectedPair } from './expected-pair.js';
import type { IssueMessage } from './validation.js';

/** Per-pair classification produced by lock verification. */
export type PairState =
  | { kind: 'verified' }
  | { kind: 'refused'; reason?: string } // valid entry, verdict refused
  | { kind: 'unverified' } // missing entry or hash mismatch
  | { kind: 'prompt-too-large'; chars: number; limit: number; tierName: string }
  | { kind: 'companion-error'; messageData: IssueMessage }; // companion.mjs could not resolve during the §4 gate

/**
 * A verified pair: the expected pair plus its computed state.
 *
 * `oversized` is set ONLY for the valid-verdict-but-now-oversized case: the
 * stored verdict is still valid (state is verified/refused), but the pair's
 * assembled prompt exceeds the resolved tier's max_prompt_chars. The renderer
 * emits a prompt-too-large error for the pair AND renders the preserved verdict.
 * When the pair is itself unverified-and-oversized, the state is
 * { kind: 'prompt-too-large' } and `oversized` is left undefined (the gate state
 * already carries chars/limit/tierName).
 */
export interface VerifiedPair {
  pair: ExpectedPair;
  state: PairState;
  /** Valid-verdict-but-oversized: gate error data to surface alongside the verdict. */
  oversized?: { chars: number; limit: number; tierName: string };
  /**
   * Set ONLY when the verifying call (`verifyLock`, core/verify-lock.ts) assembled the prompt live for a pair whose stored
   * verdict is still VALID but carries no recorded `promptChars` — i.e. an entry
   * written by a CLI from before that field existed.
   *
   * It exists so `--approve` can record the number without re-reviewing
   * anything (core/fill-prompt-size-backfill.ts). Without that, a repository
   * whose verdicts are all still valid would never record a single size — there
   * is nothing to re-fill, so nothing would ever write one — and every check
   * would keep paying the full assembly cost the field exists to remove.
   *
   * Left undefined whenever the number came from the lock (nothing to write) or
   * the pair is not valid (a re-fill will write its own).
   */
  backfillPromptChars?: number;
  /**
   * Set on an unverified companion pair when the verifying call did not run its
   * companion.mjs because the caller runs no repository code (see
   * `VerifyOptions.runCompanionHooks`). The pair is unverified either way — its
   * hash no longer matches — and the size gate measured it WITHOUT the files the
   * hook would inject: a lower bound, so an over-limit result is still certain,
   * but an under-limit one is settled only by the `--approve` run that resolves
   * the companions for real. The report says so, so nobody reads the missing
   * size check as a pass.
   */
  companionNotRun?: true;
  /**
   * Who judged this pair, when the judge was not a configured provider — read
   * straight off the stored entry, whatever the pair's state. Present on a
   * verified pair too (which reports no issue at all), because "who decided
   * this" is exactly the fact a green run must still be able to show.
   */
  judge?: { name: string; provider: 'external' };
  /**
   * The hash recorded for this pair in the lock, whatever its state — present
   * whenever an entry exists at all, absent when the lock has never seen the
   * pair. It is what a verdict is BOUND to, so a machine consumer can carry the
   * binding without reading the lock a second way.
   */
  recordedHash?: string;
  /**
   * WHEN `--approve` wrote this pair's stored verdict, and at which commit —
   * independent of whether that verdict is still in force. Unlike `judge`
   * above, a stale or refused pair still reports it: "who filled this and
   * when" does not depend on the verdict currently holding.
   *
   * Absent when the lock has never filled this pair, or filled it with a CLI
   * from before this field existed. `sha` inside is independently absent when
   * no commit was resolvable at fill time (no repository, no commit yet, git
   * missing from PATH) — never fabricated.
   */
  filled?: { ts: string; sha?: string };
  /**
   * True for the half of `unverified` that is not "never seen": an entry EXISTS
   * for this pair but its hash no longer matches the current inputs.
   *
   * The two are one state as far as the gate is concerned — both block, both are
   * cleared the same way — but they are different facts about the repository. A
   * never-seen pair was never judged; a stale one was judged and the code moved
   * since. The text report deliberately says one word for both; a machine
   * consumer deciding what to schedule wants the distinction.
   */
  stale?: boolean;
  /**
   * Set on a stale script verdict whose inputs did NOT move: it only no longer
   * matches because an earlier Yggdrasil release keyed it (before the
   * deterministic contract marker, or under the grammar and runtime that parsed
   * the code then). Re-running the script checks re-records it, free.
   */
  keyedByEarlierRelease?: true;
  /**
   * The reviewer tier this LLM pair resolves to — the ONLY part of a tier a
   * verdict's identity folds in, and the resolution the verifier already made to
   * recompute the hash. Carried rather than re-resolved by a consumer, so
   * "which reviewer answers for this pair" is decided in exactly one place.
   * Absent on a deterministic pair and on an LLM pair whose tier cannot be
   * resolved at all.
   */
  tierName?: string;
}
