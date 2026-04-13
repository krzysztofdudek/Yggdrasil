import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewerProvider } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';

const execFileAsync = promisify(execFile);

export interface ReviewerTestResult {
  ok: boolean;
  error?: string;
}

const CLI_BINARIES: Partial<Record<ReviewerProvider, string>> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'gemini-cli': 'gemini',
};

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

export async function testCliProvider(provider: ReviewerProvider): Promise<ReviewerTestResult> {
  const binary = CLI_BINARIES[provider];
  if (!binary) {
    return { ok: false, error: `Unsupported CLI provider: ${provider}` };
  }
  try {
    await execFileAsync('which', [binary], { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    const msg = `'${binary}' not found on PATH`;
    debugWrite(`[reviewer-test] testCliProvider(${provider}): ${(err as Error).message}`);
    return { ok: false, error: msg };
  }
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
      'Authorization': `Bearer ${apiKey}`,
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`;
    debugWrite(`[reviewer-test] testOllama: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}
