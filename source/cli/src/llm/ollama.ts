import type { LlmProvider, AspectResponse, ArtifactResponse, AspectVerifyParams, ArtifactReviewParams } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import type { LlmConfig } from '../model/graph.js';
import { ARTIFACT_GUIDANCE } from './artifact-guidance.js';

const ASPECT_SYSTEM_PROMPT = `<role>
You verify whether source code satisfies an architectural aspect.
Respond with EXACTLY this JSON format, nothing else:
{"satisfied": true|false, "reason": "explanation with specific file references"}
</role>`;

const ARTIFACT_SYSTEM_PROMPT = `<role>
You review whether a graph artifact is current and follows quality guidelines.
</role>

<rules>
  <general-rules>
${ARTIFACT_GUIDANCE}
  </general-rules>
</rules>

<task>
CURRENT = artifact captures knowledge source code cannot express, follows all rules.
STALE = artifact contradicts source, violates rules, or is missing knowledge it should capture.

Respond with EXACTLY this JSON, nothing else:
{"current": true|false, "reason": "explanation"}
</task>`;

export class OllamaProvider implements LlmProvider {
  readonly needsChunking = true;
  private endpoint: string;
  private model: string;
  private temperature: number;
  private contextLengthField?: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'http://localhost:11434';
    this.model = config.model;
    this.temperature = config.temperature;
    this.contextLengthField = config.context_length_field;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getContextWindowSize(): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.endpoint}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return undefined;
      const data = await res.json() as Record<string, unknown>;
      const params = data.model_info as Record<string, unknown> | undefined;
      if (!params) return undefined;
      const key = this.contextLengthField
        ?? Object.keys(params).find(k => k === 'context_length' || k.endsWith('.context_length'));
      const ctxLength = key ? params[key] as number | undefined : undefined;
      return ctxLength ?? undefined;
    } catch {
      return undefined;
    }
  }

  static async resolveMaxTokens(config: LlmConfig, provider: LlmProvider): Promise<number> {
    if (typeof config.max_tokens === 'number') return config.max_tokens;
    const detected = await provider.getContextWindowSize();
    return detected ?? 4096;
  }

  async verifyAspect(params: AspectVerifyParams): Promise<AspectResponse> {
    const contextSection = params.nodeContext
      ? `  <context>\n${params.nodeContext}\n  </context>`
      : '';

    const userPrompt = `<aspect id="${params.aspectId}">
  <content>
${params.aspectContent}
  </content>
</aspect>

<node path="${params.nodePath}" type="${params.nodeType ?? 'unknown'}">
${contextSection}
</node>

<source-files>
${params.sourceCode}
</source-files>

Does this code satisfy the aspect requirements?`;

    return this.chat<AspectResponse>(ASPECT_SYSTEM_PROMPT, userPrompt, { satisfied: false, reason: 'LLM response could not be parsed' });
  }

  async reviewArtifact(params: ArtifactReviewParams): Promise<ArtifactResponse> {
    const typeRulesSection = params.qualityProfile
      ? `\n<type-rules type="${params.nodeType}">\n${params.qualityProfile}\n</type-rules>\n`
      : '';
    const ruleInteraction = params.qualityProfile
      ? `\n<rule-interaction>\nType-specific rules REFINE general rules — they do not override them.\nWhen a type rule says "output format IS the contract", it means the general\nrule "don't restate observable behavior" does NOT apply to output format\nfor this node type.\n</rule-interaction>\n`
      : '';
    const contextSection = params.nodeContext
      ? `  <context>\n${params.nodeContext}\n  </context>`
      : '';
    const nodeSection = params.nodePath
      ? `\n<node path="${params.nodePath}" type="${params.nodeType ?? 'unknown'}">\n${contextSection}\n</node>\n`
      : '';

    const userPrompt = `${typeRulesSection}${ruleInteraction}${nodeSection}
<review-target>
  <artifact name="${params.artifactName}">
${params.artifactContent}
  </artifact>
</review-target>

<source-files>
${params.sourceCode}
</source-files>

Does this artifact follow the quality guidelines?`;

    return this.chat<ArtifactResponse>(ARTIFACT_SYSTEM_PROMPT, userPrompt, { current: false, reason: 'LLM response could not be parsed' });
  }

  private async chat<T>(system: string, user: string, fallback: T): Promise<T> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      think: false,
      options: { temperature: this.temperature, num_predict: 500 },
      format: 'json',
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          debugWrite(`[ollama] http_error attempt=${attempt}: ${res.status} ${res.statusText}`);
          continue;
        }
        const data = await res.json() as { message?: { content?: string } };
        const content = data.message?.content ?? '';
        const cleaned = content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
        return JSON.parse(cleaned) as T;
      } catch (err) {
        debugWrite(`[ollama] error attempt=${attempt}: ${(err as Error).message}`);
        if (attempt === 1) return fallback;
      }
    }
    return fallback;
  }
}
