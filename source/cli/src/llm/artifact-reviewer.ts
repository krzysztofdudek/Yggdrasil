import type { LlmProvider } from './types.js';
import type { ArtifactReviewResult } from '../model/drift.js';
import { debugWrite } from '../utils/debug-log.js';

export interface ReviewArtifactsParams {
  provider: LlmProvider;
  artifacts: Array<{ name: string; content: string }>;
  sourceFiles: Array<{ path: string; content: string }>;
  maxTokens: number;
  /** Node graph path */
  nodePath?: string;
  /** Node type name from architecture */
  nodeType?: string;
  /** Quality profile from architecture — type-specific evaluation criteria */
  qualityProfile?: string;
  /** Pre-computed yg context --node output */
  nodeContext?: string;
  /** Absolute path to project root */
  projectRoot?: string;
}

export async function reviewArtifacts(
  params: ReviewArtifactsParams,
): Promise<Record<string, ArtifactReviewResult>> {
  const results: Record<string, ArtifactReviewResult> = {};

  if (params.provider.needsChunking) {
    // API providers: chunk source content into prompt
    const chunks = chunkSourceForReview(params.sourceFiles, params.maxTokens);
    for (const artifact of params.artifacts) {
      try {
        let isStale = false;
        let staleReason = '';
        for (const chunk of chunks) {
          const chunkResult = await params.provider.reviewArtifact({
            artifactContent: artifact.content,
            artifactName: artifact.name,
            sourceCode: chunk.code,
            sourceFiles: chunk.files,
            nodePath: params.nodePath,
            nodeType: params.nodeType,
            qualityProfile: params.qualityProfile,
            nodeContext: params.nodeContext,
            projectRoot: params.projectRoot,
          });
          if (!chunkResult.current) {
            isStale = true;
            staleReason = chunkResult.reason;
            break;
          }
        }
        results[artifact.name] = isStale
          ? { current: false, reason: staleReason }
          : { current: true, reason: 'up to date' };
      } catch (err) {
        debugWrite(`[artifact-reviewer] failed reviewing ${artifact.name}: ${(err as Error).message}`);
        results[artifact.name] = { current: false, reason: 'Reviewer failed' };
      }
    }
  } else {
    // CLI providers: send all file paths in one call — provider reads files itself
    const allFiles = params.sourceFiles.map(f => f.path);
    for (const artifact of params.artifacts) {
      try {
        const result = await params.provider.reviewArtifact({
          artifactContent: artifact.content,
          artifactName: artifact.name,
          sourceCode: '',
          sourceFiles: allFiles,
          nodePath: params.nodePath,
          nodeType: params.nodeType,
          qualityProfile: params.qualityProfile,
          nodeContext: params.nodeContext,
        });
        results[artifact.name] = result.current
          ? { current: true, reason: 'up to date' }
          : { current: false, reason: result.reason };
      } catch (err) {
        debugWrite(`[artifact-reviewer] failed reviewing ${artifact.name}: ${(err as Error).message}`);
        results[artifact.name] = { current: false, reason: 'Reviewer failed' };
      }
    }
  }

  return results;
}

function chunkSourceForReview(
  files: Array<{ path: string; content: string }>,
  maxTokens: number,
): Array<{ code: string; files: string[] }> {
  // Estimate: ~4 chars per token
  const maxChars = maxTokens * 4;
  // Reserve ~30% for prompt overhead
  const availableChars = Math.floor(maxChars * 0.7);

  const chunks: Array<{ code: string; files: string[] }> = [];
  let currentCode = '';
  let currentFiles: string[] = [];

  for (const file of files) {
    const fileBlock = `<file path="${file.path}">\n${file.content}\n</file>\n`;
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
