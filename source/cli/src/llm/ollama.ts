import type { LlmProvider, AspectResponse, ArtifactResponse } from './types.js';
import type { LlmConfig } from '../model/types.js';
import { ARTIFACT_GUIDANCE } from './artifact-guidance.js';

const ASPECT_SYSTEM_PROMPT = `You are a code reviewer verifying whether source code satisfies architectural requirements.
You will receive: aspect requirements (from a content.md file) and source code files.
Respond with EXACTLY this JSON format, nothing else:
{"satisfied": true|false, "reason": "one sentence explanation"}`;

const ARTIFACT_SYSTEM_PROMPT = `You review whether a graph artifact follows the quality guidelines.

${ARTIFACT_GUIDANCE}

Report STALE when:
- Artifact contradicts the source code (describes behavior the code does NOT have)
- Artifact violates the quality test (contains file inventories, pseudocode, config paraphrases, sibling listings, or internal helper signatures)
- Artifact is missing knowledge it should capture (identity, boundaries, decisions, contracts)

Report CURRENT when:
- Artifact captures knowledge the code cannot express and follows the quality test
- Artifact is a correct high-level summary — omitting implementation details is correct behavior

Respond with EXACTLY this JSON, nothing else:
{"current": true|false, "reason": "one sentence"}`;

export class OllamaProvider implements LlmProvider {
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
      // Use configured field, or find any key ending with .context_length
      const key = this.contextLengthField
        ?? Object.keys(params).find(k => k === 'context_length' || k.endsWith('.context_length'));
      const ctxLength = key ? params[key] as number | undefined : undefined;
      return ctxLength ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve max tokens: config value, auto-detect, or fallback to 4096 */
  static async resolveMaxTokens(config: LlmConfig, provider: LlmProvider): Promise<number> {
    if (typeof config.max_tokens === 'number') return config.max_tokens;
    // auto: query provider
    const detected = await provider.getContextWindowSize();
    return detected ?? 4096; // Safe default fallback
  }

  async verifyAspect(params: {
    aspectContent: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<AspectResponse> {
    const userPrompt =
      `ASPECT REQUIREMENTS:\n${params.aspectContent}\n\n` +
      `SOURCE FILES:\n${params.sourceCode}\n\n` +
      `Does this code satisfy these requirements?`;

    return this.chat<AspectResponse>(ASPECT_SYSTEM_PROMPT, userPrompt, { satisfied: false, reason: 'LLM response could not be parsed' });
  }

  async reviewArtifact(params: {
    artifactContent: string;
    artifactName: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ArtifactResponse> {
    const userPrompt =
      `ARTIFACT (${params.artifactName}):\n${params.artifactContent}\n\n` +
      `SOURCE CODE:\n${params.sourceCode}\n\n` +
      `Does this artifact follow the quality guidelines?`;

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
        if (!res.ok) continue;
        const data = await res.json() as { message?: { content?: string } };
        const content = data.message?.content ?? '';
        // Strip markdown code fences if present
        const cleaned = content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
        return JSON.parse(cleaned) as T;
      } catch {
        if (attempt === 1) return fallback;
      }
    }
    return fallback;
  }
}
