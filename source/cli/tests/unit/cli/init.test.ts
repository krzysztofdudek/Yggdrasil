import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerInitCommand, freshInitNonInteractive } from '../../../src/cli/init.js';
import { resolveReviewerConfigFromFlags } from '../../../src/cli/init-reviewer-setup.js';

describe('init command', () => {
  it('registers init command', () => {
    const program = new Command();
    registerInitCommand(program);
    expect(program.commands.map(c => c.name())).toContain('init');
  });

  it('init command exposes --upgrade option', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--upgrade');
  });

  it('init command exposes the non-interactive fresh-init options', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toEqual(expect.arrayContaining(['--provider', '--model', '--endpoint']));
  });
});

describe('freshInitNonInteractive', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function freshDir(label: string): Promise<{ root: string; ygg: string }> {
    const root = await mkdtemp(path.join(tmpdir(), `yg-noninteractive-${label}-`));
    dirs.push(root);
    return { root, ygg: path.join(root, '.yggdrasil') };
  }

  it('writes a require-nothing coverage baseline and the named reviewer tier (claude-code needs no key)', async () => {
    const { root, ygg } = await freshDir('happy');
    await freshInitNonInteractive(root, ygg, { platform: 'claude-code', provider: 'claude-code', model: 'haiku' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    // The fresh config opts into require-nothing coverage (green from the first check).
    expect(cfg).toContain('coverage:');
    expect(cfg).toMatch(/required:\s*\[\]/);
    // The named CLI-agent reviewer tier is recorded with the model given verbatim.
    expect(cfg).toContain('provider: claude-code');
    expect(cfg).toContain('model: haiku');
  });

  it('defaults the Ollama endpoint when --endpoint is omitted', async () => {
    const { root, ygg } = await freshDir('ollama');
    await freshInitNonInteractive(root, ygg, { platform: 'generic', provider: 'ollama', model: 'qwen3' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('endpoint: http://localhost:11434');
  });

  it('claude-code without --model defaults to sonnet and writes the tier', async () => {
    const { root, ygg } = await freshDir('default-model');
    await freshInitNonInteractive(root, ygg, { platform: 'claude-code', provider: 'claude-code' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('model: sonnet');
  });

  it('codex without --model exits 1 with a model-required message', async () => {
    const { root, ygg } = await freshDir('nomodel-codex');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(freshInitNonInteractive(root, ygg, { platform: 'claude-code', provider: 'codex' })).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--model is required');
  });

  it('exits 1 when an OpenAI-compatible provider is given no --endpoint', async () => {
    const { root, ygg } = await freshDir('noendpoint');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      freshInitNonInteractive(root, ygg, { platform: 'generic', provider: 'openai-compatible', model: 'gpt-x' }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--endpoint is required');
  });
});

describe('resolveReviewerConfigFromFlags', () => {
  it('defaults the model to sonnet for claude-code when --model is omitted', () => {
    const r = resolveReviewerConfigFromFlags({ provider: 'claude-code' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.model).toBe('sonnet');
  });

  it('requires --model for codex and gemini-cli', () => {
    for (const provider of ['codex', 'gemini-cli'] as const) {
      const r = resolveReviewerConfigFromFlags({ provider });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue.what).toContain('--model is required');
    }
  });

  it('defaults the ollama endpoint and requires an endpoint for openai-compatible', () => {
    const ok = resolveReviewerConfigFromFlags({ provider: 'ollama', model: 'llama3' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.endpoint).toBe('http://localhost:11434');
    const bad = resolveReviewerConfigFromFlags({ provider: 'openai-compatible', model: 'gpt-4o' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issue.what).toContain('--endpoint is required');
      // The suggested retry command must be immediately runnable — it must include
      // --platform, not just --endpoint, or the user hits the separate
      // "no --platform" guard on the very next retry.
      expect(bad.issue.next).toContain('--platform <name>');
    }
  });

  it('surfaces a keyWarning (not an error) when an API provider has no env key', () => {
    const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = resolveReviewerConfigFromFlags({ provider: 'anthropic', model: 'claude-sonnet-5' });
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.config.apiKey).toBeUndefined(); expect(r.keyWarning?.what).toContain('No API key'); }
    } finally {
      if (hadKey) process.env.ANTHROPIC_API_KEY = savedKey; else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
