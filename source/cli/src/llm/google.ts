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
    return `${this.endpoint}/models/${this.model}:generateContent`;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'Google request failed', errorSource: 'provider' };
    try {
      // Send the API key in the `x-goog-api-key` header, NOT the URL query string.
      // A `?key=` URL leaks the secret into proxy/CDN/server access logs and any
      // error report that echoes the request URL; the header form is Google's
      // supported alternative and keeps the credential out of the URL.
      const res = await apiFetch(this.buildUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: this.temperature,
            responseMimeType: 'application/json',
          },
        }),
      }, 'google');
      if (!res.ok) {
        // Surface the HTTP status (never the body — that could carry response
        // content). Without this a 4xx/5xx is parsed as if it were a verdict,
        // losing the one diagnostic that explains the failure. Fail closed.
        debugWrite(`[google] verifyAspect HTTP ${res.status} ${res.statusText}`);
        return fallback;
      }
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
}

registerProvider('google', (c) => new GoogleProvider(c));
