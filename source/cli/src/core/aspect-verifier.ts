import type { LlmProvider, AspectVerifyParams } from '../llm/types.js';
import type { AspectVerificationResult } from '../model/drift.js';

export interface VerifyAspectsParams {
  provider: LlmProvider;
  aspects: Array<{ id: string; contentFile: string; contentPath: string }>;
  sourceFiles: Array<{ path: string; content: string }>;
  nodePath: string;
  nodeType?: string;
  projectRoot: string;
  consensus?: number;
  maxTokens?: number;
  /** Pre-computed yg context --node output */
  nodeContext?: string;
}

/**
 * Verify source files against aspect requirements.
 * One LLM call per aspect — provider receives full context.
 */
export async function verifyAspects(
  params: VerifyAspectsParams,
): Promise<Record<string, AspectVerificationResult>> {
  const { provider, aspects, sourceFiles, nodePath, nodeType, projectRoot, consensus = 1, maxTokens, nodeContext } = params;

  const sourceFilePaths = sourceFiles.map(f => f.path);
  const sourceCode = provider.needsChunking ? formatSourceFiles(sourceFiles, maxTokens) : '';
  const results: Record<string, AspectVerificationResult> = {};

  for (const aspect of aspects) {
    results[aspect.id] = await verifyWithConsensus(
      provider,
      {
        aspectContent: aspect.contentFile,
        aspectId: aspect.id,
        aspectContentPath: aspect.contentPath,
        sourceCode,
        sourceFiles: sourceFilePaths,
        nodePath,
        nodeType,
        projectRoot,
        nodeContext,
      },
      consensus,
    );
  }

  return results;
}

async function verifyWithConsensus(
  provider: LlmProvider,
  params: AspectVerifyParams,
  consensus: number,
): Promise<AspectVerificationResult> {
  if (consensus <= 1) {
    return provider.verifyAspect(params);
  }

  const votes: AspectVerificationResult[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyAspect(params));
  }

  const satisfied = votes.filter(v => v.satisfied).length;
  const notSatisfied = votes.filter(v => !v.satisfied).length;

  if (satisfied > notSatisfied) {
    return { satisfied: true, reason: votes.find(v => v.satisfied)!.reason };
  }
  return { satisfied: false, reason: votes.find(v => !v.satisfied)!.reason };
}

export function formatSourceFiles(
  files: Array<{ path: string; content: string }>,
  maxTokens?: number,
): string {
  const parts = files.map(f => `<file path="${f.path}">\n${f.content}\n</file>`);
  let combined = parts.join('\n\n');

  if (maxTokens) {
    const charBudget = maxTokens * 4 * 0.6;
    if (combined.length > charBudget) {
      combined = combined.slice(0, charBudget) + '\n\n[... truncated for token budget]';
    }
  }

  return combined;
}
