import type { LlmProvider, AspectResponse, AspectVerificationResult } from './types.js';
import { buildPairPrompt } from './prompt.js';

export type { PromptAspectInput, PromptReferenceInput, PromptFileInput, PairPromptInput } from './prompt.js';
export { buildPairPrompt, assembledPromptChars } from './prompt.js';

export interface VerifyAspectsParams {
  provider: LlmProvider;
  aspects: Array<{
    id: string;
    description: string;
    content: string;
    references?: Array<{ path: string; description?: string; content: string }>;
  }>;
  sourceFiles: Array<{ path: string; content: string }>;
  nodeDescription: string;
  nodePath: string;
  consensus?: number;
}

export function buildPrompt(
  aspect: { id: string; description: string; content: string },
  nodeDescription: string,
  nodePath: string,
  sourceFiles: Array<{ path: string; content: string }>,
  references: Array<{ path: string; description?: string; content: string }> = [],
): string {
  return buildPairPrompt({
    aspect,
    nodeDescription,
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

export async function verifyWithConsensus(
  provider: LlmProvider,
  prompt: string,
  consensus: number,
): Promise<ConsensusResult> {
  if (consensus <= 1) {
    const response = await provider.verifyAspect(prompt); // a throw propagates — fail-closed unchanged
    return { response, votes: [response] };
  }

  const votes: AspectResponse[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyAspect(prompt));
  }

  const satisfied = votes.filter(v => v.satisfied).length;
  const notSatisfied = votes.filter(v => !v.satisfied).length;

  if (satisfied > notSatisfied) {
    return { response: { satisfied: true, reason: votes.find(v => v.satisfied)!.reason, errorSource: 'codeViolation' }, votes };
  }
  const losingVotes = votes.filter(v => !v.satisfied);
  const allProvider = losingVotes.every(v => v.errorSource === 'provider');
  // When the aggregate is a real code refusal (not allProvider), source the
  // reason from a losing vote that actually refused the code — otherwise a
  // leading provider-error vote's text would masquerade as the violation.
  const reasonSource = allProvider ? losingVotes[0]! : losingVotes.find(v => v.errorSource !== 'provider')!;
  return {
    response: {
      satisfied: false,
      reason: reasonSource.reason,
      errorSource: allProvider ? 'provider' : 'codeViolation',
    },
    votes,
  };
}

export async function verifyAspects(
  params: VerifyAspectsParams,
): Promise<Record<string, AspectVerificationResult>> {
  const { provider, aspects, sourceFiles, nodePath, nodeDescription, consensus = 1 } = params;
  const results: Record<string, AspectVerificationResult> = {};
  for (const aspect of aspects) {
    const prompt = buildPrompt(aspect, nodeDescription, nodePath, sourceFiles, aspect.references ?? []);
    const r = (await verifyWithConsensus(provider, prompt, consensus)).response;
    results[aspect.id] = { satisfied: r.satisfied, reason: r.reason, errorSource: r.errorSource };
  }
  return results;
}
