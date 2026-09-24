import type { LlmProvider, AspectResponse } from './types.js';
import { buildPairPrompt } from './prompt.js';

export type { PromptAspectInput, PromptReferenceInput, PromptFileInput, PairPromptInput } from './prompt.js';
export { buildPairPrompt, assembledPromptChars } from './prompt.js';

/**
 * `nodeDescription` is accepted and IGNORED. The prompt no longer carries a
 * component's description (see `llm/prompt.ts`'s `nodeElement` for why: it is
 * not folded into the verdict hash, so it could sway a judgment it could never
 * invalidate). The parameter is kept in the signature so this legacy
 * positional helper's remaining callers need no edit; drop it when they go.
 */
export function buildPrompt(
  aspect: { id: string; description: string; content: string },
  nodeDescription: string,
  nodePath: string,
  sourceFiles: Array<{ path: string; content: string }>,
  references: Array<{ path: string; description?: string; content: string }> = [],
): string {
  void nodeDescription;
  return buildPairPrompt({
    aspect,
    nodePath,
    files: sourceFiles,
    references,
    scope: undefined,
  });
}


/** Result of a (possibly multi-vote) consensus verification: the aggregate
 *  verdict plus every individual vote that produced it, so a caller can
 *  surface the split (diagnostics, telemetry) without re-deriving it. */
export interface ConsensusResult {
  /** The aggregate — byte-equivalent semantics to the single-response contract. */
  response: AspectResponse;
  /** Every vote cast. Length 1 on the consensus<=1 path. */
  votes: AspectResponse[];
}

/**
 * Run the tier's `consensus` review passes over one prompt and aggregate them.
 *
 * The passes run CONCURRENTLY: they are independent calls over identical
 * input, so running them one after another only multiplied a pair's wall time
 * by the vote count. The caller's pool bounds pairs, so the most reviewer
 * calls in flight at once is `parallel x consensus` — the figure to size a
 * tier's `parallel` against a provider's rate limit. A pass that THROWS still
 * fails the whole pair (after every pass has settled, so none is left running
 * unobserved), exactly as the sequential loop did.
 *
 * Only votes that are verdicts count. A provider-error vote (a timeout, an
 * unparseable reply, an HTTP failure) is infrastructure, not a refusal, so it
 * is left out of the majority instead of being counted against the code. The
 * remaining verdicts must still be a strict majority of the passes the tier
 * asked for; with fewer, the pair is not judged at all and the aggregate is a
 * provider error (infra — nothing is written, the pair stays unverified).
 * Among the verdicts, approval needs more satisfied than refused votes; a tie
 * refuses, as it always has.
 */
export async function verifyWithConsensus(
  provider: LlmProvider,
  prompt: string,
  consensus: number,
): Promise<ConsensusResult> {
  if (consensus <= 1) {
    const response = await provider.verifyAspect(prompt); // a throw propagates — fail-closed unchanged
    return { response, votes: [response] };
  }

  const settled = await Promise.allSettled(
    Array.from({ length: consensus }, () => provider.verifyAspect(prompt)),
  );
  const thrown = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (thrown !== undefined) throw thrown.reason;
  const votes = settled.map((r) => (r as PromiseFulfilledResult<AspectResponse>).value);

  const verdictVotes = votes.filter((v) => v.errorSource !== 'provider');
  if (verdictVotes.length * 2 <= consensus) {
    const firstError = votes.find((v) => v.errorSource === 'provider');
    return {
      response: {
        satisfied: false,
        reason: `only ${verdictVotes.length} of ${consensus} consensus votes returned a verdict, too few for a majority; the others failed: ${firstError?.reason ?? 'provider error'}`,
        errorSource: 'provider',
      },
      votes,
    };
  }

  const satisfied = verdictVotes.filter((v) => v.satisfied);
  const refused = verdictVotes.filter((v) => !v.satisfied);
  if (satisfied.length > refused.length) {
    return { response: { satisfied: true, reason: satisfied[0]!.reason, errorSource: 'codeViolation' }, votes };
  }
  return {
    response: { satisfied: false, reason: refused[0]!.reason, errorSource: 'codeViolation' },
    votes,
  };
}

/** The split a consensus review recorded: satisfied verdicts out of verdict
 *  votes. Provider-error votes are not verdicts and count in neither figure. */
export function consensusTally(votes: AspectResponse[]): { satisfied: number; total: number } {
  const verdicts = votes.filter((v) => v.errorSource !== 'provider');
  return { satisfied: verdicts.filter((v) => v.satisfied).length, total: verdicts.length };
}
