import type { LlmProvider, AspectResponse } from './types.js';
import type { LlmConfig } from '../model/graph.js';
import { resolveApiKey, apiFetch } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import { registerProvider } from './provider.js';
import { debugWrite } from '../utils/debug-log.js';

export class GoogleProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private apiKey: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.model = config.model;
    this.temperature = config.temperature;
    this.apiKey = resolveApiKey(config) ?? '';
  }

  private buildUrl(): string {
    return `${this.endpoint}/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'Google request failed', providerError: true };
    try {
      const res = await apiFetch(this.buildUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: this.temperature,
            responseMimeType: 'application/json',
          },
        }),
      }, 'google');
      const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      };
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return parseAspectResponse(content) ?? fallback;
    } catch (err) {
      debugWrite(`[google] verifyAspect: ${(err as Error).message}`);
      return fallback;
    }
  }

  async isAvailable(): Promise<boolean> { return !!this.apiKey; }
  async getContextWindowSize(): Promise<number | undefined> { return undefined; }
}

registerProvider('google', (c) => new GoogleProvider(c));
