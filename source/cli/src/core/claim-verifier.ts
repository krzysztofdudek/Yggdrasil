import type { LlmProvider, ClaimResponse } from '../llm/types.js';
import type { AspectVerificationResult } from '../model/types.js';

export interface VerifyClaimsParams {
  provider: LlmProvider;
  aspects: Array<{
    id: string;
    claims: Array<{ id: string; claim: string }>;
    contentFile: string;
  }>;
  sourceFiles: Array<{ path: string; content: string }>;
  consensus: number;
  maxTokens: number;
}

export async function verifyClaims(
  params: VerifyClaimsParams,
): Promise<Record<string, Record<string, ClaimVerificationResult>>> {
  const results: Record<string, Record<string, ClaimVerificationResult>> = {};
  const chunks = chunkSourceFiles(params.sourceFiles, params.maxTokens);

  for (const aspect of params.aspects) {
    results[aspect.id] = {};
    for (const claim of aspect.claims) {
      // Skip TODO claims
      if (claim.claim.startsWith('TODO')) {
        results[aspect.id][claim.id] = {
          satisfied: false,
          reason: `Claim is a TODO placeholder. Write a real claim to enable verification.`,
        };
        continue;
      }

      // Verify against each chunk — all must satisfy
      let allSatisfied = true;
      let lastReason = '';

      for (const chunk of chunks) {
        const result = await verifyWithConsensus(
          params.provider, aspect.contentFile, claim.claim, chunk, params.consensus,
        );
        if (!result.satisfied) {
          allSatisfied = false;
          lastReason = result.reason;
          break; // Fail fast
        }
        lastReason = result.reason;
      }

      results[aspect.id][claim.id] = { satisfied: allSatisfied, reason: lastReason };
    }
  }

  return results;
}

async function verifyWithConsensus(
  provider: LlmProvider,
  aspectContent: string,
  claim: string,
  chunk: { code: string; files: string[] },
  consensus: number,
): Promise<ClaimResponse> {
  if (consensus === 1) {
    return provider.verifyClaim({
      aspectContent, claim, sourceCode: chunk.code, sourceFiles: chunk.files,
    });
  }

  // Majority vote
  const votes: ClaimResponse[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyClaim({
      aspectContent, claim, sourceCode: chunk.code, sourceFiles: chunk.files,
    }));
  }
  const satisfiedCount = votes.filter(v => v.satisfied).length;
  const majority = satisfiedCount > consensus / 2;
  /* v8 ignore next -- defensive fallback: mathematically always finds a matching vote */
  const majorityVote = votes.find(v => v.satisfied === majority) ?? votes[0];
  return majorityVote;
}

function chunkSourceFiles(
  files: Array<{ path: string; content: string }>,
  maxTokens: number,
): Array<{ code: string; files: string[] }> {
  // Estimate: ~4 chars per token
  const maxChars = maxTokens * 4;
  // Reserve ~30% for prompt overhead (aspect content, system prompt, claim)
  const availableChars = Math.floor(maxChars * 0.7);

  const chunks: Array<{ code: string; files: string[] }> = [];
  let currentCode = '';
  let currentFiles: string[] = [];

  for (const file of files) {
    const fileBlock = `--- ${file.path} ---\n${file.content}\n`;
    if (currentCode.length + fileBlock.length > availableChars && currentCode.length > 0) {
      chunks.push({ code: currentCode, files: currentFiles });
      currentCode = '';
      currentFiles = [];
    }
    currentCode += fileBlock;
    currentFiles.push(file.path);
  }

  if (currentCode.length > 0) {
    chunks.push({ code: currentCode, files: currentFiles });
  }

  return chunks.length > 0 ? chunks : [{ code: '', files: [] }];
}
