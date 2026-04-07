import type { LlmProvider, ClaimResponse, ArtifactResponse } from './types.js';
import type { LlmConfig } from '../model/types.js';

const CLAIM_SYSTEM_PROMPT = `You are a code reviewer verifying architectural claims about source code.
You will receive: an aspect description, a specific claim, and source code files.
Respond with EXACTLY this JSON format, nothing else:
{"satisfied": true|false, "reason": "one sentence explanation"}`;

const ARTIFACT_SYSTEM_PROMPT = `You review whether documentation matches source code behavior.

Report STALE only when:
- Documentation describes behavior the code does NOT have
- Documentation omits a PUBLIC export, parameter, or return type that consumers need
- Documentation contradicts the code (says X but code does Y)

Report CURRENT when:
- Documentation is a correct high-level summary even if it omits private/internal details
- Wording differs but meaning is the same
- Documentation uses simpler terms for implementation details

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

  async verifyClaim(params: {
    aspectContent: string;
    claim: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ClaimResponse> {
    const userPrompt =
      `ASPECT:\n${params.aspectContent}\n\n` +
      `CLAIM: ${params.claim}\n\n` +
      `SOURCE FILES:\n${params.sourceCode}\n\n` +
      `Does this code satisfy the claim?`;

    return this.chat<ClaimResponse>(CLAIM_SYSTEM_PROMPT, userPrompt, { satisfied: false, reason: 'LLM response could not be parsed' });
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
      `Does this documentation contradict the code or omit any public interface?`;

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
