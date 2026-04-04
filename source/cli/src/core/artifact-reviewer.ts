import type { LlmProvider } from '../llm/types.js';
import type { ArtifactReviewResult } from '../model/types.js';

export interface ReviewArtifactsParams {
  provider: LlmProvider;
  artifacts: Array<{ name: string; content: string }>;
  sourceFiles: Array<{ path: string; content: string }>;
  maxTokens: number;
}

export async function reviewArtifacts(
  params: ReviewArtifactsParams,
): Promise<Record<string, ArtifactReviewResult>> {
  const results: Record<string, ArtifactReviewResult> = {};
  const chunks = chunkSourceForReview(params.sourceFiles, params.maxTokens);

  for (const artifact of params.artifacts) {
    try {
      // Review each chunk independently — any chunk reporting stale = stale
      let isStale = false;
      let staleReason = '';

      for (const chunk of chunks) {
        const chunkResult = await params.provider.reviewArtifact({
          artifactContent: artifact.content,
          artifactName: artifact.name,
          sourceCode: chunk.code,
          sourceFiles: chunk.files,
        });
        if (!chunkResult.current) {
          isStale = true;
          staleReason = chunkResult.reason;
          break; // Fail fast
        }
      }

      results[artifact.name] = isStale
        ? { current: false, reason: staleReason }
        : { current: true, reason: 'up to date' };
    } catch {
      results[artifact.name] = { current: false, reason: 'LLM review failed' };
    }
  }

  return results;
}

function chunkSourceForReview(
  files: Array<{ path: string; content: string }>,
  maxTokens: number,
): Array<{ code: string; files: string[] }> {
  // Reserve ~30% for prompt overhead
  const availableChars = Math.floor(maxTokens * 0.7);

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
