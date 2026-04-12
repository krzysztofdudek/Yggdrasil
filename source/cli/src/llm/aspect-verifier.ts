import type { LlmProvider, AspectResponse } from './types.js';
import type { AspectVerificationResult } from '../model/drift.js';

export interface VerifyAspectsParams {
  provider: LlmProvider;
  aspects: Array<{ id: string; description: string; content: string }>;
  sourceFiles: Array<{ path: string; content: string }>;
  nodeDescription: string;
  nodePath: string;
  consensus?: number;
  maxTokens?: number;
}

export function buildPrompt(
  aspect: { id: string; description: string; content: string },
  nodeDescription: string,
  nodePath: string,
  sourceFiles: Array<{ path: string; content: string }>,
): string {
  const files = sourceFiles.map(f =>
    `<file path="${f.path}">\n${f.content}\n</file>`
  ).join('\n\n');

  return `<task>
You verify whether source code satisfies a requirement.

Below is a node (component) with its source files and one aspect (rule set).
Check every rule in the aspect against the source code.

Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation with file:line references"}
</task>

<node path="${nodePath}" description="${nodeDescription}" />

<aspect id="${aspect.id}" description="${aspect.description}">
${aspect.content}
</aspect>

<source-files>
${files}
</source-files>`;
}

export function chunkSourceFiles(
  files: Array<{ path: string; content: string }>,
  maxTokens: number,
): Array<Array<{ path: string; content: string }>> {
  const overhead = 500;
  const effectiveMax = Math.max(maxTokens, 1000);
  const available = (effectiveMax - overhead) * 4;
  const chunks: Array<Array<{ path: string; content: string }>> = [];
  let current: Array<{ path: string; content: string }> = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.path.length + file.content.length + 30;
    if (fileSize > available) {
      const truncated = file.content.slice(0, available);
      chunks.push([{ path: file.path, content: truncated + '\n[... truncated]' }]);
      continue;
    }
    if (currentSize + fileSize > available && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(file);
    currentSize += fileSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
}

async function verifyWithConsensus(
  provider: LlmProvider,
  prompt: string,
  consensus: number,
): Promise<AspectResponse> {
  if (consensus <= 1) {
    return provider.verifyAspect(prompt);
  }

  const votes: AspectResponse[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyAspect(prompt));
  }

  const satisfied = votes.filter(v => v.satisfied).length;
  const notSatisfied = votes.filter(v => !v.satisfied).length;

  if (satisfied > notSatisfied) {
    return { satisfied: true, reason: votes.find(v => v.satisfied)!.reason };
  }
  return { satisfied: false, reason: votes.find(v => !v.satisfied)!.reason };
}

export async function verifyAspects(
  params: VerifyAspectsParams,
): Promise<Record<string, AspectVerificationResult>> {
  const { provider, aspects, sourceFiles, nodePath, nodeDescription, consensus = 1, maxTokens } = params;

  if (sourceFiles.length === 0) {
    return Object.fromEntries(aspects.map(a => [a.id, { satisfied: true, reason: 'No source files' }]));
  }

  const tokenBudget = maxTokens ?? 8192;
  const chunks = chunkSourceFiles(sourceFiles, tokenBudget);
  const results: Record<string, AspectVerificationResult> = {};

  for (const aspect of aspects) {
    let failed = false;
    let failReason = '';

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const prompt = buildPrompt(aspect, nodeDescription, nodePath, chunk);
      const result = await verifyWithConsensus(provider, prompt, consensus);
      if (!result.satisfied) {
        failed = true;
        failReason = result.reason;
        break;
      }
    }

    results[aspect.id] = failed
      ? { satisfied: false, reason: failReason }
      : { satisfied: true, reason: `All rules satisfied across ${chunks.length} file group(s)` };
  }

  return results;
}
