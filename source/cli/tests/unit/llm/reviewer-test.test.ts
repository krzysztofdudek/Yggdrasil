import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testApiProvider, testCliProvider } from '../../../src/llm/reviewer-test.js';
// The CLI probe asks the provider registry, which the shipped CLI fills through its command tree.
import '../../../src/llm/index.js';

describe('testApiProvider', () => {
  it('returns error for unreachable Anthropic endpoint', async () => {
    const result = await testApiProvider('anthropic', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable OpenAI endpoint', async () => {
    const result = await testApiProvider('openai', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable openai-compatible endpoint', async () => {
    const result = await testApiProvider('openai-compatible', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable Ollama endpoint', async () => {
    const result = await testApiProvider('ollama', '', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for invalid Google API key', async () => {
    const result = await testApiProvider('google', 'invalid-key', 'gemini-pro');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('testCliProvider', () => {
  it('returns error for unsupported API provider used as CLI', async () => {
    // 'ollama' is an API provider, not a CLI provider — should fail
    const result = await testCliProvider('ollama');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported');
  });

  it('returns error for unsupported CLI provider', async () => {
    const result = await testCliProvider('anthropic');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported');
  });
});

describe('testCliProvider — names the cause and the install', () => {
  it('a CLI provider whose binary is not on PATH gets that provider install hint', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(await testCliProvider('codex')).toEqual({
        ok: false,
        error: "'codex' was not found on PATH — install the Codex CLI (npm i -g @openai/codex) and sign in with `codex login`",
      });
      const copilot = await testCliProvider('copilot-cli');
      expect(copilot.ok).toBe(false);
      expect(copilot.error).toContain('YG_COPILOT_BIN');
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe.skipIf(process.platform === 'win32')('testCliProvider — a round-trip probe for codex and gemini-cli', () => {
  // A binary that answers --version but cannot review (here: no login) used to
  // pass setup, and every judgment-rule pair then failed on the first
  // `yg check --approve`. With the model named, setup asks for one verdict.
  it('codex that runs but returns no verdict is reported, with the CLI\'s own words', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-fake-codex-'));
    writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.156.1"; exit 0; fi\necho "Not logged in. Run codex login." >&2\nexit 1\n');
    chmodSync(path.join(dir, 'codex'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved ?? ''}`;
    try {
      const result = await testCliProvider('codex', 'gpt-5');
      expect(result.ok).toBe(false);
      expect(result.error).toContain("a probe review with model 'gpt-5' returned no verdict");
      expect(result.error).toContain('Not logged in');
      // Without a model it stays the binary check it always was.
      expect(await testCliProvider('codex')).toEqual({ ok: true });
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codex that answers the probe with a verdict passes setup', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-fake-codex-'));
    writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ncat >/dev/null\necho \'{"satisfied": true, "reason": "probe"}\'\n');
    chmodSync(path.join(dir, 'codex'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved ?? ''}`;
    try {
      expect(await testCliProvider('codex', 'gpt-5')).toEqual({ ok: true });
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
