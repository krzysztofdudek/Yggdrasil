import type { LlmProvider, AspectResponse } from './types.js';
import type { LlmConfig } from '../model/graph.js';
import { resolveApiKey, apiFetch, describeHttpFailure, describeFetchFailure, missingKeyReason, DEFAULT_API_TIMEOUT_MS } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import { registerProvider } from './provider.js';
import { debugWrite } from '../utils/debug-log.js';

export class OpenAIProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private apiKey: string;
  private timeout: number;
  private providerName: string;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'https://api.openai.com/v1';
    this.model = config.model;
    this.temperature = config.temperature;
    this.apiKey = resolveApiKey(config) ?? '';
    this.timeout = config.timeout ?? DEFAULT_API_TIMEOUT_MS;
    this.providerName = config.provider;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fail = (why: string): AspectResponse => ({ satisfied: false, reason: `OpenAI request failed: ${why}`, errorSource: 'provider' });
    const url = `${this.endpoint}/chat/completions`;
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        // A keyless OpenAI-compatible server (a local vLLM, LM Studio or llama.cpp)
        // gets no Authorization header at all rather than an empty bearer token.
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: this.temperature,
          response_format: { type: 'json_object' },
        }),
      }, 'openai', this.timeout);
      if (!res.ok) {
        // Surface the HTTP status (never the body — that could carry response
        // content). Without this a 4xx/5xx is parsed as if it were a verdict,
        // losing the one diagnostic that explains the failure. Fail closed.
        debugWrite(`[openai] verifyAspect HTTP ${res.status} ${res.statusText}`);
        return fail(describeHttpFailure(this.providerName, res.status, res.statusText, this.model));
      }
      let data: { choices?: Array<{ message?: { content?: string } }> };
      try {
        data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      } catch (err) {
        debugWrite(`[openai] verifyAspect: reply is not JSON: ${(err as Error).message}`);
        return fail(`HTTP ${res.status} but the reply was not JSON — config.endpoint may not be this provider's API`);
      }
      const content = data.choices?.[0]?.message?.content ?? '';
      return parseAspectResponse(content) ?? fail('the reply held no verdict text');
    } catch (err) {
      debugWrite(`[openai] verifyAspect: ${(err as Error).message}`);
      return fail(describeFetchFailure(err, url, this.timeout));
    }
  }

  // The hosted OpenAI API needs a key; an OpenAI-compatible server may need none
  // (a local vLLM, LM Studio or llama.cpp), so its key is optional and a server
  // that does want one answers 401, which the reason then names.
  async isAvailable(): Promise<boolean> { return this.providerName === 'openai-compatible' || !!this.apiKey; }

  async unavailableReason(): Promise<string> { return missingKeyReason(this.providerName); }
}

registerProvider('openai', (c) => new OpenAIProvider(c));
registerProvider('openai-compatible', (c) => new OpenAIProvider(c));
