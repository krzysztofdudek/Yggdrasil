/**
 * Agent-facing what/why/next messages for the verdict-lock check codes
 * (spec §6, §10). Kept separate from the legacy drift/aspect-status messages so
 * the live (lock) path has a single cohesive home for its strings.
 *
 * Every message follows the what/why/next contract (AGENTS.md CLI message
 * design principle). The exact text for the cached-refusal three exits,
 * the cached-verdict marker, and the prompt-too-large safety-ordered remedies is
 * load-bearing — these are the agent's GPS out of each state.
 */

import type { IssueMessage } from '../model/validation.js';

/**
 * An expected pair has no valid verdict in the lock (missing entry, edited
 * input, tampered verdict, or a fill that failed). Severity follows the pair's
 * effective status (enforced → error, advisory → warning) at the call site.
 */
export function unverifiedMessage(params: {
  aspectId: string;
  unitKey: string;
}): IssueMessage {
  return {
    what: `No valid verdict for aspect '${params.aspectId}' on ${params.unitKey}.`,
    why: 'The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.',
    next: 'yg check --approve',
  };
}

/**
 * The `unverified` message for a pair whose cause plain check can read off the
 * lock and the config alone (see UnverifiedCause). A cause only a recording run
 * witnesses (the reviewer did not answer, a check.mjs crashed) is written by
 * that run from its own diagnostic instead — see annotateFillCauses.
 *
 * Each says what actually happened and names the command that actually
 * clears it.
 */
export function unverifiedCauseMessage(params: {
  aspectId: string;
  unitKey: string;
  cause: 'stale' | 'never-reviewed' | 'deterministic-not-run' | 'reviewer-missing';
}): IssueMessage {
  switch (params.cause) {
    case 'stale':
      return {
        what: `The verdict for aspect '${params.aspectId}' on ${params.unitKey} is stale.`,
        why: 'A verdict was recorded, but its inputs changed since (a source edit, an aspect edit, or a changed reference), so it no longer counts. It is re-judged over the code as it stands now.',
        next: 'yg check --approve',
      };
    case 'deterministic-not-run':
      return {
        what: `No local result for script rule '${params.aspectId}' on ${params.unitKey}.`,
        why: 'Script-rule results live in the gitignored local cache (.yggdrasil/.yg-lock.deterministic.json), so a fresh clone, a new rule or a cleared cache holds none until the check runs on this checkout. Running it is free: no reviewer call, and the committed lock is not touched.',
        next: 'yg check --approve --only-deterministic',
      };
    case 'reviewer-missing':
      return {
        what: `Reviewer rule '${params.aspectId}' on ${params.unitKey} has no reviewer to judge it.`,
        why: 'yg-config.yaml has no reviewer: section, so nothing can read this content.md rule. Re-running --approve cannot change that; it stays unverified until a reviewer is configured or the rule is set to status: draft.',
        next: `yg init --provider <name> [--model <m>] — the user's decision, since it sends code to that provider — or set the reviewer rule to status: draft`,
      };
    case 'never-reviewed':
      return {
        what: `No verdict yet for aspect '${params.aspectId}' on ${params.unitKey}.`,
        why: 'The lock holds no entry for this pair: it is new (a new rule, component or mapped file), or the fill that would have judged it did not complete.',
        next: 'yg check --approve',
      };
  }
}

/**
 * Cached LLM refusal: the lock holds a valid `refused` entry. The reviewer is
 * NOT re-run — the stored reason is rendered as-is. The three exits are the only
 * ways out (there is no command that re-rolls a cached refusal).
 */
export function llmRefusedMessage(params: {
  aspectId: string;
  unitKey: string;
  reason: string;
  /** Name of the judge, when the verdict was recorded outside the configured reviewer. */
  judge?: string;
  /** What the rule is for, in a sentence — the first sentence of its description. */
  intent?: string;
}): IssueMessage {
  // A verdict recorded by someone other than the configured reviewer names them
  // in the same breath as the refusal. A reader deciding what to do about a
  // refusal needs to know whose judgement it is; a hash re-proves that the
  // judgement still applies, never who made it.
  //
  // On its OWN line, deliberately: the grouped view collapses line 0 into the
  // shared block header and renders every later line per member, so a name
  // folded into line 0 would be visible only in the ungrouped view. With no
  // judge the message is byte-identical to what it always was.
  const by = params.judge === undefined ? '' : `Judged by '${params.judge}' (external).\n`;
  return {
    what: `Aspect '${params.aspectId}' is refused on ${params.unitKey}. cached verdict — the reviewer did NOT re-run; inputs are identical to the refused review.\n${by}Reviewer reason: ${params.reason}`,
    why: params.intent ?? 'A refused verdict for unchanged inputs is final and cached; re-running the reviewer would only re-roll the same inputs.',
    next:
      `Four exits — the verdict is recorded for this exact code, so re-running the reviewer changes nothing:\n` +
      `  1. Fix the code so it satisfies aspect '${params.aspectId}', then: yg check --approve\n` +
      `  2. Sharpen the aspect's content.md if the rule is wrong or unclear — this re-reviews EVERY node using the aspect; check \`yg impact --aspect ${params.aspectId}\` first.\n` +
      `  3. Propose a \`yg-suppress\` to the user for a deliberate exception — ask the user to approve the reason.\n` +
      `  4. Not sure yet which it is: propose \`status: advisory\` on the aspect to the user — the refusal stays recorded but stops blocking while you decide.`,
  };
}

/**
 * Cached deterministic refusal: the lock holds a valid `refused` entry with the
 * recorded Violation[] as its reason. Rendered as-is; the fix is the code, not a
 * reviewer re-roll.
 */
export function detRefusedMessage(params: {
  aspectId: string;
  unitKey: string;
  reason: string;
  /** What the rule is for, in a sentence — the first sentence of its description. */
  intent?: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' is refused on ${params.unitKey} by a script rule.\nViolations:\n${params.reason}`,
    why: params.intent ?? 'A script rule recorded these violations; the same code reproduces the same verdict.',
    next: 'Change the code at these lines, then run yg check --approve --only-deterministic (free) to record the new verdict.',
  };
}

/**
 * The assembled prompt for an LLM pair exceeds the resolved tier's
 * max_prompt_chars (§4). Blocking error. Remedies are listed in SAFETY ORDER:
 * narrow scope first (no judgment change), then per-file (only if file-local),
 * then split, then raise the limit or move tiers. Remedy 4 says plainly what
 * each half costs: `max_prompt_chars` is not a verdict input, so raising it
 * re-verifies nothing; the tier NAME is, so moving the aspect re-reviews every
 * pair of that aspect. (It once said "tier edits cascade re-verification
 * across every aspect resolving to that tier", which read as if raising the
 * cap re-billed the whole tier, and pushed adopters to split nodes instead.)
 */
export function raiseCapRemedy(tierName: string, limit: number): string {
  return (
    `  4. Raise max_prompt_chars on the '${tierName}' tier (now ${limit}) — it is a gate, not a verdict input, so raising it re-verifies nothing and costs only this pair's review; keep it inside the model's context window. ` +
    `Or move the aspect to a tier with a higher limit — that re-reviews every pair of the aspect, because the tier name is part of each pair's hash.`
  );
}

/**
 * The prompt-too-large blocking message (see raiseCapRemedy for remedy 4).
 */
export function promptTooLargeMessage(params: {
  aspectId: string;
  unitKey: string;
  tierName: string;
  chars: number;
  limit: number;
}): IssueMessage {
  return {
    what: `Assembled reviewer prompt for aspect '${params.aspectId}' on ${params.unitKey} is ${params.chars} chars, over the '${params.tierName}' tier limit of ${params.limit}.`,
    why: 'An over-limit prompt risks context-window truncation and a false verdict. The gate blocks the pair and skips it during fill until the prompt fits.',
    next:
      `Remedies, in safety order:\n` +
      `  1. Narrow scope.files so non-target payload (README, fixtures) leaves the prompt.\n` +
      `  2. Switch the aspect to per: file — only if the rule is file-local; see \`yg knowledge read writing-llm-aspects\`.\n` +
      `  3. Split the node so its mapped files divide across smaller nodes.\n` +
      raiseCapRemedy(params.tierName, params.limit),
  };
}

