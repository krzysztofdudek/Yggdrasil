/**
 * source/cli/src/core/review-package.ts — the review package for one LLM pair:
 * everything a judge is given, and the hash the judgement will be stored under.
 *
 * There is exactly ONE assembly. The fill stage sends this package to a
 * configured provider; the external-judge channel prints the same package and
 * later records a verdict against the same hash. If the two assembled it
 * separately they would drift, and a verdict recorded against a package nobody
 * else can reproduce is not bound to anything — so both go through here.
 *
 * Assembly only: it reads files, resolves companions and suppressed ranges,
 * builds the prompt and can compute the pair's inputHash for a given verdict
 * token. It calls no reviewer, gates no size, and writes nothing. The two
 * failure dispositions it can return are the fail-closed ones the fill stage
 * already had — an unreadable declared reference, and a companion or suppress
 * marker that cannot be resolved — because in each case there is no package at
 * all, and hashing over substituted bytes would pin a verdict to inputs nobody
 * ever saw.
 */

import path from 'node:path';

import type { Graph, AspectDef } from '../model/graph.js';
import type { Verdict } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { computeLlmInputHash } from './pair-hash.js';
import { ruleHashFor, contentFor, tierHashViewFromTier, companionHashFor } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { assembledPromptChars } from '../llm/prompt.js';
import type {
  PairPromptInput,
  PromptReferenceInput,
  PromptFileInput,
  PromptCompanionInput,
  PromptSuppressedRangesInput,
} from '../llm/prompt.js';
import { readFileBytes } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import type { IssueMessage } from '../model/validation.js';
import { resolveCompanionsForPair } from './companion-resolve.js';
import { readBytesOrEmpty } from './fill-shared.js';
import { resolveSuppressedRangesForPrompt, SuppressMarkerError } from '../structure/index.js';
import type { ParseCache } from '../structure/index.js';

/** Everything a judge — provider or person — is given for one pair, plus its binding. */
export interface AssembledReviewPackage {
  /** Subject files, in the pair's own order, as raw bytes. */
  subjects: Array<{ path: string; bytes: Buffer }>;
  /** Declared references as the hash folds them: [path, sha256, description]. */
  referencesForHash: Array<[string, string, string]>;
  /** The same references as the prompt carries them. */
  referencesForPrompt: PromptReferenceInput[];
  /** Companion files a `companion.mjs` hook resolved for this pair (empty for a plain aspect). */
  companions: PromptCompanionInput[];
  /** The hook's out-of-subject observations, folded into the hash when non-empty. */
  observations: Array<[string, string]>;
  /** The assembled prompt's inputs — what `buildPairPrompt` renders. */
  promptInput: PairPromptInput;
  /** The gate-canonical (label-free) prompt size, measured once. */
  promptChars: number;
  /**
   * The inputHash this pair's verdict is stored under, for a given verdict
   * token. Two tokens, two hashes — which is why a judge is handed both and
   * hands back the one it decided on.
   */
  hashFor: (verdict: Verdict) => string;
}

export type ReviewPackageOutcome =
  | { kind: 'ok'; pkg: AssembledReviewPackage }
  | { kind: 'infra'; why: string; messageData: IssueMessage }
  | { kind: 'companion-runtime-error'; why: string; messageData: IssueMessage };

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
export function companionRuntimeNotice(
  aspectId: string,
  unitKey: string,
  reason: string,
  originalMessageData?: IssueMessage,
): IssueMessage {
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

/**
 * Assemble the review package for one LLM pair.
 *
 * References are loaded as RAW disk bytes — byte-identical to the verifier
 * (verify-lock.ts reads each reference via readFileBytes and folds those raw
 * bytes; the prompt content there is rawBytes.toString('utf8')). Hashing,
 * prompting, and the §4 size gate must all be measured over the SAME bytes, so
 * a reference carrying a UTF-8 BOM or an invalid byte cannot make the producer
 * and verifier disagree (which would pin the verdict to a permanent false-red).
 * A missing reference is a LOUD infra failure — never hashed over empty-
 * substituted bytes.
 */
export async function assembleReviewPackage(args: {
  graph: Graph;
  projectRoot: string;
  pair: ExpectedPair;
  aspect: AspectDef;
  /** The tier NAME — the only part of a tier the hash folds. */
  tierName: string;
  /** Shared across a whole run so one reference file is read once, not once per pair. */
  referencesCache?: Map<string, Buffer | null>;
  /** Type-level coverage facts for this run (absent ⇒ no nodeless pairs exist). */
  typeCoverage?: TypeCoverageInput;
  /** Shared architecture-reach memo, so a nodeless pair's matched type resolves once per type. */
  reachCache?: Map<string, Set<string>>;
  /** Shared AST parse cache for the (aspect, component) bucket this pair belongs to. */
  parseCache?: ParseCache;
}): Promise<ReviewPackageOutcome> {
  const { graph, projectRoot, pair, aspect, tierName, typeCoverage, reachCache, parseCache } = args;
  const referencesCache = args.referencesCache ?? new Map<string, Buffer | null>();

  // ── Load subject file bytes (sorted by path is the pair's contract). ──
  // Every path that leaves here reaches the verdict's own identity and the
  // judge's prompt, so each is normalized to POSIX at the point it enters —
  // never carried through raw and normalized only where it happens to be
  // printed.
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytesOrEmpty(path.resolve(projectRoot, rel));
    subjects.push({ path: toPosixPath(rel), bytes });
  }

  // ── Load references (see this function's own note on raw bytes). ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let bytes = referencesCache.get(absRef);
    if (bytes === undefined) {
      bytes = await readFileBytes(absRef); // raw disk Buffer, no decode, no BOM strip; null on error
      if (bytes === null) {
        debugWrite(`[review-package] reference load failed for ${aspect.id} path ${toPosixPath(ref.path)}`);
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
      };
    }
    const refPath = toPosixPath(ref.path);
    referencesForHash.push([refPath, hashBytes(bytes), ref.description ?? '']);
    referencesForPrompt.push({ path: refPath, description: ref.description, content: bytes.toString('utf8') });
  }

  // ── Resolve companions BEFORE anything can cost a reviewer call (spec: a torn
  // observation set must NEVER cost one). The plain path (no companion.mjs)
  // skips this entirely so its behavior is byte-identical to the pre-companion
  // contract; companionHash is then undefined and the hash is unchanged. ──
  let companions: PromptCompanionInput[] = [];
  let observations: Array<[string, string]> = [];
  if (aspect.hasCompanion === true) {
    const resolved = await resolveCompanionsForPair(graph, projectRoot, pair, aspect, typeCoverage, reachCache, parseCache);
    if (resolved.kind === 'infra') {
      // Companion hook/resolution runtime failure — fail closed, NOTHING written,
      // reviewer never called. Counted and summarized as
      // aspect-companion-runtime-error, the mirror of aspect-check-runtime-error.
      debugWrite(`[review-package] companion resolution failed for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${resolved.messageData.what}`);
      return {
        kind: 'companion-runtime-error',
        why: resolved.why,
        messageData: companionRuntimeNotice(aspect.id, pair.unitKey, resolved.why, resolved.messageData),
      };
    }
    companions = resolved.companions.promptCompanions;
    observations = resolved.companions.observations;
  }

  // ── Resolve yg-suppress line ranges for THIS aspect over the subjects and
  // inject them into the prompt, so the judge honors exactly the same spans the
  // deterministic matcher waives (no judge-side scope re-derivation). Routed
  // through the structure adapter — the engine may NOT import ast/* directly
  // (architecture: engine → structure-adapter → ast-adapter is the legal path).
  // A reasonless marker throws SuppressMarkerError → fail-closed infra. ──
  let suppressedRanges: PromptSuppressedRangesInput;
  try {
    suppressedRanges = await resolveSuppressedRangesForPrompt(subjects, aspect.id);
  } catch (e) {
    if (e instanceof SuppressMarkerError) {
      const where = `${toPosixPath(e.file)}:${e.line}`;
      debugWrite(`[review-package] suppress marker missing reason for ${aspect.id} on ${toPosixPath(pair.unitKey)}: ${where}`);
      return {
        kind: 'infra',
        why: `a yg-suppress marker at ${where} is missing its required reason`,
        messageData: {
          what: `A yg-suppress marker at ${where} (subject of aspect '${aspect.id}') is missing its required reason.`,
          why: 'A reasonless suppress marker cannot be resolved into a line range, so the suppressed-line set is undefined and the pair cannot be verified. Fail-closed: NOTHING was written, the pair stays unverified, and the reviewer was NOT called.',
          next: `Add a reason after the marker's closing parenthesis at ${where}, then re-run: yg check --approve`,
        },
      };
    }
    throw e;
  }

  const promptInput: PairPromptInput = {
    aspect: { id: aspect.id, description: aspect.description ?? '', content: contentFor(aspect, 'content.md') },
    references: referencesForPrompt,
    nodePath: pair.nodePath,
    files: subjects.map<PromptFileInput>((s) => ({ path: s.path, content: s.bytes.toString('utf8') })),
    companions,
    suppressedRanges,
    scope: aspect.scope,
  };

  // The gate-canonical (label-free) size of this prompt. Measured ONCE and
  // reused: by the fill stage's first-fill companion gate, recorded on the
  // entry, and read back by every later `yg check`. Deliberately NOT
  // `prompt.length`: `buildPairPrompt` renders companion labels and the gate's
  // measurement does not, so the two strings differ by design and only this one
  // is comparable with what verify-lock computes.
  const promptChars = assembledPromptChars(promptInput);

  const hashFor = (verdict: Verdict): string =>
    computeLlmInputHash({
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

  return {
    kind: 'ok',
    pkg: {
      subjects,
      referencesForHash,
      referencesForPrompt,
      companions,
      observations,
      promptInput,
      promptChars,
      hashFor,
    },
  };
}
