import type { LlmProvider, AspectResponse } from './types.js';
import type { LlmConfig } from '../model/graph.js';
import { resolveApiKey, apiFetch, describeHttpFailure, describeFetchFailure, missingKeyReason, DEFAULT_API_TIMEOUT_MS } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import { registerProvider } from './provider.js';
import { debugWrite } from '../utils/debug-log.js';

type GoogleReply = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

export class GoogleProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private apiKey: string;
  private timeout: number;
  private providerName: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.model = config.model;
    this.temperature = config.temperature;
    this.apiKey = resolveApiKey(config) ?? '';
    this.timeout = config.timeout ?? DEFAULT_API_TIMEOUT_MS;
    this.providerName = config.provider;
  }

  private buildUrl(): string {
    return `${this.endpoint}/models/${this.model}:generateContent`;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fail = (why: string): AspectResponse => ({ satisfied: false, reason: `Google request failed: ${why}`, errorSource: 'provider' });
    const url = this.buildUrl();
    try {
      // Send the API key in the `x-goog-api-key` header, NOT the URL query string.
      // A `?key=` URL leaks the secret into proxy/CDN/server access logs and any
      // error report that echoes the request URL; the header form is Google's
      // supported alternative and keeps the credential out of the URL.
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: this.temperature,
            responseMimeType: 'application/json',
          },
        }),
      }, 'google', this.timeout);
      if (!res.ok) {
        // Surface the HTTP status (never the body — that could carry response
        // content). Without this a 4xx/5xx is parsed as if it were a verdict,
        // losing the one diagnostic that explains the failure. Fail closed.
        debugWrite(`[google] verifyAspect HTTP ${res.status} ${res.statusText}`);
        return fail(describeHttpFailure(this.providerName, res.status, res.statusText, this.model));
      }
      let data: GoogleReply;
      try {
        data = await res.json() as GoogleReply;
      } catch (err) {
        debugWrite(`[google] verifyAspect: reply is not JSON: ${(err as Error).message}`);
        return fail(`HTTP ${res.status} but the reply was not JSON — config.endpoint may not be this provider's API`);
      }
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return parseAspectResponse(content) ?? fail('the reply held no verdict text');
    } catch (err) {
      debugWrite(`[google] verifyAspect: ${(err as Error).message}`);
      return fail(describeFetchFailure(err, url, this.timeout));
    }
  }

  async isAvailable(): Promise<boolean> { return !!this.apiKey; }

  async unavailableReason(): Promise<string> { return missingKeyReason(this.providerName); }
}

registerProvider('google', (c) => new GoogleProvider(c));
