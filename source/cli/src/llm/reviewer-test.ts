import type { ReviewerProvider } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { createLlmProvider, probeProvider } from './provider.js';

export interface ReviewerTestResult {
  ok: boolean;
  error?: string;
}

const CLI_PROVIDERS: ReviewerProvider[] = ['claude-code', 'codex', 'gemini-cli', 'copilot-cli'];

export async function testApiProvider(
  provider: ReviewerProvider,
  apiKey: string,
  model: string,
  endpoint?: string,
): Promise<ReviewerTestResult> {
  try {
    switch (provider) {
      case 'anthropic':
        return await testAnthropic(apiKey, model, endpoint ?? 'https://api.anthropic.com/v1');
      case 'openai':
      case 'openai-compatible':
        return await testOpenAI(apiKey, model, endpoint ?? 'https://api.openai.com/v1');
      case 'google':
        return await testGoogle(apiKey, model);
      case 'ollama':
        return await testOllama(model, endpoint ?? 'http://localhost:11434');
      default:
        return { ok: false, error: `Unsupported API provider: ${provider}` };
    }
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[reviewer-test] testApiProvider(${provider}): ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * CLI providers whose setup check also makes one real review call. Finding the
 * binary proves little for these two: a wrong flag, a missing login or an
 * untrusted working directory only shows once the CLI is asked for a verdict,
 * and until then every judgment-rule pair would end as a provider error on the
 * first `yg check --approve`. The call is one tiny prompt.
 */
const ROUND_TRIP_PROBED: ReviewerProvider[] = ['codex', 'gemini-cli'];

/** The one prompt a round-trip probe sends. */
export const PROBE_PROMPT =
  'This is a setup check from `yg init`, not a review. Reply with exactly this JSON object and nothing else: {"satisfied": true, "reason": "probe"}';

/** How long the round-trip probe may take — a first run of a CLI can be slow. */
const ROUND_TRIP_TIMEOUT_MS = 120_000;

/**
 * Whether a CLI provider can run here, and if not why — asked of the provider
 * itself through the registry, so the answer is the one `yg check --approve`
 * would give: the binary probe's cause plus that CLI's install hint, and for
 * copilot-cli the real CLI found past the VS Code extension's `copilot` stub.
 *
 * With a `model`, codex and gemini-cli are also asked for one verdict through
 * the exact argv a review uses (see ROUND_TRIP_PROBED); a provider error there
 * is reported with the CLI's own words.
 */
export async function testCliProvider(provider: ReviewerProvider, model?: string): Promise<ReviewerTestResult> {
  if (!CLI_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Unsupported CLI provider: ${provider}` };
  }
  // The model is irrelevant to the availability probe; the registry needs one to build the provider.
  let probe;
  try {
    probe = await probeProvider(createLlmProvider({ provider, model: 'auto', temperature: 0, consensus: 1 }), provider);
  } catch (err) {
    debugWrite(`[reviewer-test] testCliProvider(${provider}): ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
  if (!probe.available) {
    debugWrite(`[reviewer-test] testCliProvider(${provider}): ${probe.reason}`);
    return { ok: false, error: probe.reason };
  }
  if (model === undefined || !ROUND_TRIP_PROBED.includes(provider)) return { ok: true };
  const reply = await createLlmProvider({ provider, model, temperature: 0, consensus: 1, timeout: ROUND_TRIP_TIMEOUT_MS }).verifyAspect(PROBE_PROMPT);
  if (reply.errorSource === 'provider') {
    debugWrite(`[reviewer-test] testCliProvider(${provider}) round trip: ${reply.reason}`);
    return { ok: false, error: `a probe review with model '${model}' returned no verdict: ${reply.reason}` };
  }
  return { ok: true };
}

async function testAnthropic(apiKey: string, model: string, endpoint: string): Promise<ReviewerTestResult> {
  const res = await fetch(`${endpoint}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Respond with OK' }],
      max_tokens: 10,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`;
    debugWrite(`[reviewer-test] testAnthropic: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}

async function testOpenAI(apiKey: string, model: string, endpoint: string): Promise<ReviewerTestResult> {
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Respond with OK' }],
      max_tokens: 10,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`;
    debugWrite(`[reviewer-test] testOpenAI: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}

async function testGoogle(apiKey: string, model: string): Promise<ReviewerTestResult> {
  // Key in the `x-goog-api-key` header, NOT a `?key=` query string — a URL key
  // leaks into proxy/CDN/server access logs and any error report echoing the URL.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Respond with OK' }] }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`;
    debugWrite(`[reviewer-test] testGoogle: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}

async function testOllama(model: string, endpoint: string): Promise<ReviewerTestResult> {
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Respond with OK' }],
      stream: false,
      // Mirror the real reviewer (OllamaProvider.verifyAspect): disable the
      // model's reasoning trace so a "thinking" model does not burn the probe
      // on a long chain-of-thought for a trivial prompt.
      think: false,
    }),
    // A large local model is cold-loaded from disk on the first request; 15s was
    // too tight and produced false "connection failed" on working setups. Match
    // the real reviewer's tolerance (apiFetch default).
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`;
    debugWrite(`[reviewer-test] testOllama: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}
