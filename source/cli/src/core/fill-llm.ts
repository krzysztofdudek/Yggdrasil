/**
 * source/cli/src/core/fill-llm.ts — the LLM-pair filler for the fill stage (spec
 * §7 step 6). Loads subject + reference bytes byte-identically to the verifier,
 * assembles the prompt, runs the tier's consensus votes, and on a real verdict
 * produces the content-addressed entry. Every infra disposition (reference
 * unreadable, provider error/unparseable) returns { kind: 'infra' } so the caller
 * writes NOTHING (spec §3.2).
 */

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { VerdictEntry, Verdict } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { buildPairPrompt, DEFAULT_MAX_PROMPT_CHARS } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import type { LlmProvider } from '../llm/types.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { assembleReviewPackage } from './review-package.js';
import type { LlmFillOutcome } from './fill-shared.js';
import type { ParseCache } from '../structure/index.js';

/**
 * Fill one LLM pair: load references (a MISSING reference is a LOUD infra
 * failure — contract #6, never empty-bytes hashing), assemble the prompt, run
 * the tier's consensus votes, and on a real verdict compute the hash + entry.
 * Every infra disposition (reference unreadable, provider error/unparseable)
 * returns { kind: 'infra' } so the caller writes NOTHING.
 */
export async function fillLlmPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  tier: LlmConfig,
  tierName: string,
  mergedTier: LlmConfig,
  provider: LlmProvider,
  referencesCache: Map<string, Buffer | null>,
  // Type-level coverage facts for this run (absent ⇒ no nodeless pairs exist —
  // the feature-off contract every other type-coverage consumer follows).
  // Only consulted when this pair's aspect has a companion AND the pair is
  // nodeless (resolveCompanionsForPair ignores both for a component pair).
  typeCoverage?: TypeCoverageInput,
  // Shared across every fillLlmPair AND fillDetPair call this run (the caller
  // constructs one Map and passes it to both) so the architecture-reach for a
  // nodeless pair's matched type is computed once per type, not once per pair.
  reachCache?: Map<string, Set<string>>,
  // Shared AST parse cache for the (aspectId, node) bucket this pair belongs to
  // (fill.ts groups pairs this way before dispatch) — a `per: file` rule with N
  // subjects on one node shares ONE cache instead of building and discarding N,
  // so a relation target's mapped files are parsed once per bucket rather than
  // once per subject. Absent → resolveCompanionsForPair's own default (a fresh,
  // call-scoped cache) — today's byte-identical behavior. Never destroyed here;
  // the bucket's owner (fill.ts) destroys it once every pair sharing it settles.
  parseCache?: ParseCache,
): Promise<LlmFillOutcome> {
  // ── Assemble the review package: subjects, references, companions,
  // suppressed ranges, the prompt and its binding hash. The SAME assembly the
  // external-judge channel prints, so a verdict recorded there and a verdict
  // filled here are stored under the same hash by construction rather than by
  // two implementations agreeing. Its two fail-closed dispositions arrive here
  // unchanged: an unreadable declared reference is infra, a companion that
  // cannot resolve is its own runtime error — neither costs a reviewer call. ──
  const assembled = await assembleReviewPackage({
    graph, projectRoot, pair, aspect, tierName, referencesCache, typeCoverage, reachCache, parseCache,
  });
  if (assembled.kind === 'infra') {
    return { kind: 'infra', why: assembled.why, messageData: assembled.messageData, callsMade: 0 };
  }
  if (assembled.kind === 'companion-runtime-error') {
    return { kind: 'companion-runtime-error', why: assembled.why, messageData: assembled.messageData, callsMade: 0 };
  }
  const { companions, observations, promptInput, promptChars, hashFor } = assembled.pkg;

  // ── Fill-time size gate for companion pairs (§4, first-fill). ──
  // verify-lock gates a STORED entry against max_prompt_chars, but on a pair's
  // FIRST fill there is no stored entry — verify-lock classifies the pair as
  // `unverified` (not `prompt-too-large`) and fill proceeds, billing the reviewer
  // for a prompt that may then be refused by the gate on the NEXT `yg check`.
  // For plain LLM pairs this cannot happen (verify-lock knows subjects+references
  // on first fill), but companion pairs carry extra bytes verify-lock cannot see
  // without a stored entry. The guard below closes that window: when companions
  // were resolved and injected AND the tier sets a limit, measure BEFORE calling
  // the reviewer. Uses assembledPromptChars (label-free) — the same measurement
  // verify-lock uses — so fill and verify are consistent.
  if (aspect.hasCompanion === true && companions.length > 0) {
    // A tier that OMITS max_prompt_chars is gated at DEFAULT_MAX_PROMPT_CHARS
    // (the §4 gate is always active — there is no "unlimited" tier). The guard
    // is therefore always-true; it is unwrapped, the body kept.
    const limit = mergedTier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS;
    const chars = promptChars;
    if (chars > limit) {
      const unitKeyPosix = toPosixPath(pair.unitKey);
      return {
        kind: 'infra',
        why: `assembled prompt for aspect '${aspect.id}' on ${unitKeyPosix} is ${chars} chars, over the '${tierName}' tier limit of ${limit}`,
        messageData: {
          what: `Assembled reviewer prompt for aspect '${aspect.id}' on ${unitKeyPosix} is ${chars} chars, over the '${tierName}' tier limit of ${limit}.`,
          why: 'An over-limit prompt risks context-window truncation and a false verdict. The gate blocks the pair and writes NOTHING — no reviewer call is made.',
          next:
            `Remedies, in safety order:\n` +
            `  1. Narrow scope.files so non-target payload (README, fixtures) leaves the prompt.\n` +
            `  2. Switch the aspect to per: file — only if the rule is file-local; see \`yg knowledge read writing-llm-aspects\`.\n` +
            `  3. Split the node so its mapped files divide across smaller nodes.\n` +
            `  4. Raise max_prompt_chars or move the aspect to a higher-limit tier — note: tier edits cascade re-verification across every aspect resolving to that tier.\n` +
            `Then re-run: yg check --approve`,
        },
        callsMade: 0,
      };
    }
  }

  const prompt = buildPairPrompt(promptInput);

  const consensus = mergedTier.consensus;
  let response;
  let votes;
  try {
    ({ response, votes } = await verifyWithConsensus(provider, prompt, consensus));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    debugWrite(`[fill] reviewer threw for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${detail}`);
    return {
      kind: 'infra',
      why: `the reviewer threw or returned an unparseable response: ${detail}`,
      messageData: {
        what: `Reviewer for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} threw or returned an unparseable response: ${detail}`,
        why: 'The reviewer could not produce a verdict — an infrastructure problem, not a code violation. Fail-closed: NOTHING was written, the pair stays unverified.',
        next: 'Check the provider endpoint, network, and credentials, then re-run: yg check --approve',
      },
      callsMade: consensus,
    };
  }

  // A provider-sourced failure is infra (no write). Only a codeViolation maps to
  // a real verdict token.
  if (!response.satisfied && response.errorSource === 'provider') {
    debugWrite(`[fill] provider error for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${response.reason}`);
    return {
      kind: 'infra',
      why: `the reviewer returned a provider error: ${response.reason}`,
      messageData: {
        what: `Reviewer for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} returned a provider error: ${response.reason}`,
        why: 'A provider-sourced failure is infrastructure, not a code violation — only a codeViolation maps to a real verdict. Fail-closed: NOTHING was written, the pair stays unverified.',
        next: 'Check the provider endpoint, network, and credentials, then re-run: yg check --approve',
      },
      callsMade: consensus,
    };
  }

  const verdict: Verdict = response.satisfied ? 'approved' : 'refused';
  const hash = hashFor(verdict);

  const entry: VerdictEntry = { verdict, hash, promptChars };
  // Persist touched ONLY when the companion recorded out-of-subject observations —
  // a []-resolving companion writes NO touched but still folded companionHash.
  if (observations.length > 0) entry.touched = observations;
  if (verdict === 'refused') entry.reason = response.reason;
  return { kind: 'verdict', entry, callsMade: consensus, votes };
}
