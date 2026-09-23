import type { LlmProvider, AspectResponse } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import { apiFetch, describeHttpFailure, describeFetchFailure } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import type { LlmConfig } from '../model/graph.js';
import { registerProvider } from './provider.js';

/** The availability probe asks only for the model list, so it gets a short timeout of its own. */
const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

export class OllamaProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;
  private timeout: number;
  /** Why the last isAvailable() said no — reported by unavailableReason(). */
  private lastProbeFailure = '';

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'http://localhost:11434';
    this.model = config.model;
    this.temperature = config.temperature;
    // Thinking models emit their full reasoning before the verdict, so a single
    // review can take minutes — far past apiFetch's 60s default. Use a generous
    // ceiling (matching the CLI-provider default), overridable via config.timeout.
    this.timeout = config.timeout ?? 300_000;
  }

  async isAvailable(): Promise<boolean> {
    const url = `${this.endpoint}/api/tags`;
    try {
      const res = await apiFetch(url, {}, 'ollama', OLLAMA_PROBE_TIMEOUT_MS);
      if (!res.ok) this.lastProbeFailure = describeHttpFailure('ollama', res.status, res.statusText, this.model);
      return res.ok;
    } catch (err) {
      debugWrite(`[ollama] isAvailable: ${(err as Error).message}`);
      this.lastProbeFailure = describeFetchFailure(err, url, OLLAMA_PROBE_TIMEOUT_MS);
      return false;
    }
  }

  async unavailableReason(): Promise<string> {
    return `no Ollama server answered at ${this.endpoint} (${this.lastProbeFailure || 'no answer'}) — start it with \`ollama serve\`, or point config.endpoint at the running one`;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fail = (why: string): AspectResponse => ({ satisfied: false, reason: `Ollama request failed: ${why}`, errorSource: 'provider' });

    const body = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      // Native thinking ON: the model reasons in its own `thinking` channel and
      // emits only the final JSON verdict in `content`. The verdict therefore
      // follows the reasoning (no snap-judgment before the rules are weighed) and
      // chain-of-thought never leaks into the parsed `reason`.
      think: true,
      // num_predict: -1 → generate until the model stops; no cap, so the verdict
      // is never truncated (a cut-off JSON would otherwise fail to parse and waste
      // a re-verification).
      options: { temperature: this.temperature, num_predict: -1 },
      format: 'json',
    };

    const url = `${this.endpoint}/api/chat`;
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 'ollama', this.timeout);
      if (!res.ok) {
        debugWrite(`[ollama] http_error: ${res.status} ${res.statusText}`);
        return fail(describeHttpFailure('ollama', res.status, res.statusText, this.model));
      }
      let data: { message?: { content?: string } };
      try {
        data = await res.json() as { message?: { content?: string } };
      } catch (err) {
        debugWrite(`[ollama] reply is not JSON: ${(err as Error).message}`);
        return fail(`HTTP ${res.status} but the reply was not JSON — config.endpoint may not be an Ollama server`);
      }
      const content = data.message?.content ?? '';
      // An empty reply is the usual thinking-model failure: the whole budget went
      // to the reasoning channel and no verdict reached `content`.
      return parseAspectResponse(content) ?? fail(`model '${this.model}' returned an empty reply (no verdict)`);
    } catch (err) {
      debugWrite(`[ollama] error: ${(err as Error).message}`);
      return fail(describeFetchFailure(err, url, this.timeout));
    }
  }
}

registerProvider('ollama', (config) => new OllamaProvider(config));
