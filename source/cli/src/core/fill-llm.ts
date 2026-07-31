// yg-suppress-disable(deterministic) the fill stage exists to invoke the configured LLM reviewer; non-determinism is inherent to its purpose, and every verdict it records is content-addressed so reproducibility is enforced at the lock layer instead
/**
 * source/cli/src/core/fill-llm.ts — the LLM-pair filler for the fill stage (spec
 * §7 step 6). Loads subject + reference bytes byte-identically to the verifier,
 * assembles the prompt, runs the tier's consensus votes, and on a real verdict
 * produces the content-addressed entry. Every infra disposition (reference
 * unreadable, provider error/unparseable) returns { kind: 'infra' } so the caller
 * writes NOTHING (spec §3.2).
 */

import path from 'node:path';

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { VerdictEntry, Verdict } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { computeLlmInputHash } from './pair-hash.js';
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier, companionHashFor } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { buildPairPrompt, assembledPromptChars, DEFAULT_MAX_PROMPT_CHARS } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput, PromptCompanionInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import type { LlmProvider } from '../llm/types.js';
import { readFileBytes } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import type { IssueMessage } from '../model/validation.js';
import { resolveCompanionsForPair } from './companion-resolve.js';
import { readBytesOrEmpty, type LlmFillOutcome } from './fill-shared.js';
import { resolveSuppressedRangesForPrompt, SuppressMarkerError } from '../structure/index.js';
import type { PromptSuppressedRangesInput } from '../llm/prompt.js';

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
): Promise<LlmFillOutcome> {
  // ── Load subject file bytes (sorted by path is the pair's contract). ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytesOrEmpty(path.resolve(projectRoot, rel));
    subjects.push({ path: rel, bytes });
  }

  // ── Load references as RAW disk bytes — byte-identical to the verifier
  // (verify-lock.ts reads each reference via readFileBytes and folds those raw
  // bytes; the prompt content there is rawBytes.toString('utf8')). Hashing,
  // prompting, and the §4 size gate must all be measured over the SAME bytes, so
  // a reference carrying a UTF-8 BOM or an invalid byte cannot make the producer
  // and verifier disagree (which would pin the verdict to a permanent false-red).
  // A missing reference stays a LOUD infra failure (#6) — never hashed over
  // empty-substituted bytes. ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let bytes = referencesCache.get(absRef);
    if (bytes === undefined) {
      bytes = await readFileBytes(absRef); // raw disk Buffer, no decode, no BOM strip; null on error
      if (bytes === null) {
        debugWrite(`[fill] reference load failed for ${aspect.id} path ${toPosixPath(ref.path)}`);
      }
      referencesCache.set(absRef, bytes);
    }
    if (bytes === null) {
      // Never hash over empty-substituted bytes — fail closed.
      const why = `reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read`;
      return {
        kind: 'infra',
        why,
        messageData: {
          what: `Reference file '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read.`,
          why: 'A declared reference is part of the verifier input; reading empty-substituted bytes would desync the producer and verifier and pin a false verdict, so the fill fails closed and writes NOTHING.',
          next: `Restore the reference file at '${toPosixPath(ref.path)}' or fix its permissions, then re-run: yg check --approve`,
        },
        callsMade: 0,
      };
    }
    referencesForHash.push([ref.path, hashBytes(bytes), ref.description ?? '']);
    referencesForPrompt.push({ path: ref.path, description: ref.description, content: bytes.toString('utf8') });
  }

  // ── Resolve companions BEFORE consensus (spec: a torn observation set must
  // NEVER cost a reviewer call). The plain path (no companion.mjs) skips this
  // entirely so its behavior is byte-identical to the pre-companion contract;
  // companionHash is then undefined and the hash is unchanged. ──
  let companions: PromptCompanionInput[] = [];
  let observations: Array<[string, string]> = [];
  if (aspect.hasCompanion === true) {
    const resolved = await resolveCompanionsForPair(graph, projectRoot, pair, aspect, typeCoverage, reachCache);
    if (resolved.kind === 'infra') {
      // Companion hook/resolution runtime failure — fail closed, NOTHING written,
      // reviewer never called (callsMade: 0). Counted and summarized as
      // aspect-companion-runtime-error, the mirror of aspect-check-runtime-error.
      // Pass the original messageData so its why:/next: (e.g. the relation-source/
      // target guidance from companionOutsideAllowedReads) is preserved in the
      // per-pair message while the token-bearing what: is injected.
      debugWrite(`[fill] companion resolution failed for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${resolved.messageData.what}`);
      return { kind: 'companion-runtime-error', why: resolved.why, messageData: companionRuntimeNotice(aspect.id, pair.unitKey, resolved.why, resolved.messageData), callsMade: 0 };
    }
    companions = resolved.companions.promptCompanions;
    observations = resolved.companions.observations;
  }

  // ── Resolve yg-suppress line ranges for THIS aspect over the subjects and
  // inject them into the prompt, so the LLM honors exactly the same spans the
  // deterministic matcher waives (no model-side scope re-derivation). Routed
  // through the structure adapter — the engine may NOT import ast/* directly
  // (architecture: engine → structure-adapter → ast-adapter is the legal path).
  // A reasonless marker throws SuppressMarkerError → fail-closed infra (callsMade
  // 0, NOTHING written), mirroring the deterministic path's disposition. ──
  let suppressedRanges: PromptSuppressedRangesInput;
  try {
    suppressedRanges = await resolveSuppressedRangesForPrompt(subjects, aspect.id);
  } catch (e) {
    if (e instanceof SuppressMarkerError) {
      const where = `${toPosixPath(e.file)}:${e.line}`;
      debugWrite(`[fill] suppress marker missing reason for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${where}`);
      return {
        kind: 'infra',
        why: `a yg-suppress marker at ${where} is missing its required reason`,
        messageData: {
          what: `A yg-suppress marker at ${where} (subject of aspect '${aspect.id}') is missing its required reason.`,
          why: 'A reasonless suppress marker cannot be resolved into a line range, so the suppressed-line set is undefined and the pair cannot be verified. Fail-closed: NOTHING was written, the pair stays unverified, and the reviewer was NOT called.',
          next: `Add a reason after the marker's closing parenthesis at ${where}, then re-run: yg check --approve`,
        },
        callsMade: 0,
      };
    }
    throw e;
  }

  const promptInput = {
    aspect: { id: aspect.id, description: aspect.description ?? '', content: contentFor(aspect, 'content.md') },
    references: referencesForPrompt,
    nodePath: pair.nodePath,
    nodeDescription: nodeDescriptionFor(graph, pair.nodePath),
    files: subjects.map<PromptFileInput>((s) => ({ path: s.path, content: s.bytes.toString('utf8') })),
    companions,
    suppressedRanges,
    scope: aspect.scope,
  };

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
    const chars = assembledPromptChars(promptInput);
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
  const hash = computeLlmInputHash({
    aspectId: aspect.id,
    aspectDescription: aspect.description ?? '',
    scope: aspect.scope,
    nodePath: pair.nodePath,
    ruleHash: ruleHashFor(aspect, 'content.md'),
    files: subjects.map((s) => [s.path, hashBytes(s.bytes)] as [string, string]),
    references: referencesForHash,
    tier: tierHashViewFromTier(tierName),
    // companionHash folds UNCONDITIONALLY (undefined for a plain aspect → not
    // folded; a []-resolving companion still folds it). touched folds only when
    // non-empty (the hash guards decide). The two guards are independent.
    companionHash: companionHashFor(aspect),
    touched: observations,
    verdict,
  });

  const entry: VerdictEntry = { verdict, hash };
  // Persist touched ONLY when the companion recorded out-of-subject observations —
  // a []-resolving companion writes NO touched but still folded companionHash.
  if (observations.length > 0) entry.touched = observations;
  if (verdict === 'refused') entry.reason = response.reason;
  return { kind: 'verdict', entry, callsMade: consensus, votes };
}

/**
 * Structured diagnostic for a companion hook/resolution runtime failure — the
 * direct mirror of detRuntimeNotice in fill-det.ts. Used for all hook-resolution
 * failures: hook threw / import or syntax error / bad return shape / tainted-twice /
 * resolved path missing / resolved path outside allowed-reads.
 *
 * The token `aspect-companion-runtime-error` appears in `what:` so callers and
 * tests can assert on it exactly as they do for `aspect-check-runtime-error`.
 * It is a message token, NOT a registered CheckCode — never add it to
 * STRUCTURAL_CODES or APPROVE_GATING_CODES.
 *
 * When the resolution failure produced a detailed `messageData` (e.g. the
 * allowed-reads violation with a relation-source/target NEXT), that detail is
 * preserved: `what:` is replaced with the token-bearing form, but `why:` and
 * `next:` from `originalMessageData` are kept so actionable guidance is not lost.
 */
function companionRuntimeNotice(aspectId: string, unitKey: string, reason: string, originalMessageData?: IssueMessage): IssueMessage {
  // why: combines the original what+why so the full diagnostic text (including the
  // specific failure kind — "companion hook threw", "expected an array of", etc.) is
  // always surfaced. The original next: is threaded through so actionable guidance
  // (e.g. "declare a relation from X to Y") is not discarded.
  const combinedWhy = originalMessageData
    ? `${originalMessageData.what} ${originalMessageData.why}`
    : `The companion.mjs crashed, returned an invalid result, or its observations changed mid-run: ${reason}`;
  return {
    what: `Companion resolution for '${aspectId}' failed to run on ${toPosixPath(unitKey)} — left unverified (aspect-companion-runtime-error).`,
    why: combinedWhy,
    next: originalMessageData?.next ?? `Fix the companion.mjs, then re-run: yg check --approve`,
  };
}
