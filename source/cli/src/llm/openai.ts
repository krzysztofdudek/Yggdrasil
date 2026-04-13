import type { LlmProvider, AspectResponse } from './types.js';
import type { LlmConfig } from '../model/graph.js';
import { resolveApiKey, apiFetch } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import { registerProvider } from './provider.js';
import { debugWrite } from '../utils/debug-log.js';

export class OpenAIProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private apiKey: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'https://api.openai.com/v1';
    this.model = config.model;
    this.temperature = config.temperature;
    this.apiKey = resolveApiKey(config) ?? '';
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'OpenAI request failed', providerError: true };
    try {
      const res = await apiFetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: this.temperature,
          response_format: { type: 'json_object' },
        }),
      }, 'openai');
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      return parseAspectResponse(content) ?? fallback;
    } catch (err) {
      debugWrite(`[openai] verifyAspect: ${(err as Error).message}`);
      return fallback;
    }
  }

  async isAvailable(): Promise<boolean> { return !!this.apiKey; }
  async getContextWindowSize(): Promise<number | undefined> { return undefined; }
}

registerProvider('openai', (c) => new OpenAIProvider(c));
registerProvider('openai-compatible', (c) => new OpenAIProvider(c));
