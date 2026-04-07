import type { LlmProvider } from '../llm/types.js';
import type { AspectVerificationResult } from '../model/types.js';

export interface VerifyAspectsParams {
  provider: LlmProvider;
  aspects: Array<{ id: string; contentFile: string }>;
  sourceFiles: Array<{ path: string; content: string }>;
  consensus?: number;
  maxTokens?: number;
}

/**
 * Verify source files against aspect requirements.
 * One LLM call per aspect — provider receives full content.md and source code.
 */
export async function verifyAspects(
  params: VerifyAspectsParams,
): Promise<Record<string, AspectVerificationResult>> {
  const { provider, aspects, sourceFiles, consensus = 1, maxTokens } = params;

  const sourceCode = formatSourceFiles(sourceFiles, maxTokens);
  const results: Record<string, AspectVerificationResult> = {};

  for (const aspect of aspects) {
    results[aspect.id] = await verifyWithConsensus(
      provider, aspect.contentFile, sourceCode, sourceFiles.map(f => f.path), consensus,
    );
  }

  return results;
}

async function verifyWithConsensus(
  provider: LlmProvider,
  aspectContent: string,
  sourceCode: string,
  sourceFiles: string[],
  consensus: number,
): Promise<AspectVerificationResult> {
  if (consensus <= 1) {
    return provider.verifyAspect({ aspectContent, sourceCode, sourceFiles });
  }

  const votes: AspectVerificationResult[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyAspect({ aspectContent, sourceCode, sourceFiles }));
  }

  const satisfied = votes.filter(v => v.satisfied).length;
  const notSatisfied = votes.filter(v => !v.satisfied).length;

  if (satisfied > notSatisfied) {
    return { satisfied: true, reason: votes.find(v => v.satisfied)!.reason };
  }
  return { satisfied: false, reason: votes.find(v => !v.satisfied)!.reason };
}

function formatSourceFiles(
  files: Array<{ path: string; content: string }>,
  maxTokens?: number,
): string {
  const parts = files.map(f => `--- ${f.path} ---\n${f.content}`);
  let combined = parts.join('\n\n');

  if (maxTokens) {
    const charBudget = maxTokens * 4 * 0.6;
    if (combined.length > charBudget) {
      combined = combined.slice(0, charBudget) + '\n\n[... truncated for token budget]';
    }
  }

  return combined;
}
