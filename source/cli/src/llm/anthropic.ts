import type { LlmProvider, AspectResponse } from './types.js';
import type { LlmConfig } from '../model/graph.js';
import { resolveApiKey, apiFetch } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import { registerProvider } from './provider.js';
import { debugWrite } from '../utils/debug-log.js';

export class AnthropicProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private apiKey: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'https://api.anthropic.com/v1';
    this.model = config.model;
    this.temperature = config.temperature;
    this.apiKey = resolveApiKey(config) ?? '';
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'Anthropic request failed', errorSource: 'provider' };
    try {
      const res = await apiFetch(`${this.endpoint}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          // Never cap the verdict. The Anthropic API requires a max_tokens ceiling
          // (there is no "unlimited"), so set it far above any reviewer reply — a
          // verdict is hundreds of tokens; this is many times that — so it is never
          // truncated. A truncated reply still fails closed when parsed.
          max_tokens: 8192,
          temperature: this.temperature,
        }),
      }, 'anthropic');
      if (!res.ok) {
        // Surface the HTTP status (never the body — that could carry response
        // content). Without this a 4xx/5xx is parsed as if it were a verdict,
        // losing the one diagnostic that explains the failure. Fail closed.
        debugWrite(`[anthropic] verifyAspect HTTP ${res.status} ${res.statusText}`);
        return fallback;
      }
      const data = await res.json() as { content?: Array<{ text?: string }> };
      const content = data.content?.[0]?.text ?? '';
      return parseAspectResponse(content) ?? fallback;
    } catch (err) {
      debugWrite(`[anthropic] verifyAspect: ${(err as Error).message}`);
      return fallback;
    }
  }

  async isAvailable(): Promise<boolean> { return !!this.apiKey; }
}

registerProvider('anthropic', (c) => new AnthropicProvider(c));
