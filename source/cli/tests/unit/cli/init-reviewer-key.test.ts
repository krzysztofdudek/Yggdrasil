import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The interactive reviewer flow, driven through a scripted @clack/prompts. The
// point under test is how the API key is asked for: never echoed, the
// provider's environment variable honoured, and an environment key never
// copied into yg-secrets.yaml.
const answers = vi.hoisted(() => ({ select: [] as unknown[], text: [] as unknown[], password: [] as unknown[] }));
const calls = vi.hoisted(() => ({ text: [] as Array<{ message: string }>, password: [] as Array<{ message: string; validate?: (v: string | undefined) => unknown }> }));
const fetched = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock('@clack/prompts', () => ({
  select: vi.fn(async () => answers.select.shift()),
  text: vi.fn(async (o: { message: string }) => {
    calls.text.push(o);
    return answers.text.shift();
  }),
  password: vi.fn(async (o: { message: string; validate?: (v: string | undefined) => unknown }) => {
    calls.password.push(o);
    return answers.password.shift();
  }),
  isCancel: () => false,
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/llm/model-fetcher.js', () => ({
  fetchAnthropicModels: vi.fn(async (key: string) => {
    fetched.keys.push(key);
    return { ok: true, models: ['claude-x'] };
  }),
  fetchOpenAIModels: vi.fn(),
  fetchGoogleModels: vi.fn(),
  fetchOllamaModels: vi.fn(),
}));
vi.mock('../../../src/llm/reviewer-test.js', () => ({
  testApiProvider: vi.fn(async () => ({ ok: true })),
  testCliProvider: vi.fn(async () => ({ ok: true })),
}));

import { runReviewerConfigFlow } from '../../../src/cli/init-reviewer-setup.js';

describe('interactive init: API key entry', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    answers.select = [];
    answers.text = [];
    answers.password = [];
    calls.text = [];
    calls.password = [];
    fetched.keys = [];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('asks for the key in a masked prompt, never an echoed one, and stores what was typed', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    answers.select = ['anthropic', 'claude-x'];
    answers.password = ['sk-typed'];
    const choice = await runReviewerConfigFlow();
    expect(calls.password).toHaveLength(1);
    expect(calls.text.filter((c) => /API key/.test(c.message))).toHaveLength(0);
    // With no environment variable, an empty answer is refused.
    expect(calls.password[0].validate?.('')).toBeTruthy();
    expect(choice?.apiKey).toBe('sk-typed');
    expect(fetched.keys).toEqual(['sk-typed']);
  });

  it('uses an exported environment key on an empty answer and does not copy it to disk', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';
    answers.select = ['anthropic', 'claude-x'];
    answers.password = [''];
    const choice = await runReviewerConfigFlow();
    expect(calls.password).toHaveLength(1);
    expect(calls.password[0].message).toContain('$ANTHROPIC_API_KEY');
    expect(calls.password[0].validate?.('')).toBeUndefined();
    expect(fetched.keys).toEqual(['sk-from-env']);
    // The returned apiKey is what init writes to yg-secrets.yaml.
    expect(choice?.apiKey).toBeUndefined();
  });
});
