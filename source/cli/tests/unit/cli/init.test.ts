import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  registerInitCommand,
  freshInitNonInteractive,
  freshInitKeyless,
  existingInitNonInteractive,
} from '../../../src/cli/init.js';
import { resolveReviewerConfigFromFlags, probeReviewerFromFlags } from '../../../src/cli/init-reviewer-setup.js';

// The init flag path runs the wizard's CLI installation check. Here it is
// scripted, so these tests pin init's handling of the answer and never depend on
// which agent CLIs this machine has; the check itself is tested with the
// reviewer probe.
const cliProbe = vi.hoisted(() => ({ result: { ok: true } as { ok: boolean; error?: string } }));
vi.mock('../../../src/llm/reviewer-test.js', () => ({
  testCliProvider: async () => cliProbe.result,
  testApiProvider: async () => ({ ok: true }),
}));

// Shared temp-dir helper for every describe block below that exercises a
// non-interactive bootstrap path against a real on-disk fixture project.
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

  it('init command still exposes --platform (deprecated) plus --provider/--model/--endpoint', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const longs = cmd.options.map(o => o.long);
    for (const f of ['--platform', '--provider', '--model', '--endpoint', '--upgrade']) expect(longs).toContain(f);
  });

  it('--platform option description marks it deprecated and lists the retired platform names', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const opt = cmd.options.find(o => o.long === '--platform')!;
    expect(opt.description).toContain('Deprecated');
    expect(opt.description).toContain('claude-code');
  });
});

describe('freshInitKeyless', () => {
  it('scaffolds a keyless graph with NO reviewer section', async () => {
    const { root, ygg } = await freshDir('keyless');
    await freshInitKeyless(root, ygg);
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('coverage:');
    expect(cfg).not.toContain('reviewer:');
  });

  it('installs the universal agent rules artifacts', async () => {
    const { root, ygg } = await freshDir('keyless-rules');
    await freshInitKeyless(root, ygg);
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- yggdrasil:start -->');
    const claude = await readFile(path.join(root, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('@AGENTS.md');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(root, '.clinerules', 'yggdrasil.md'))).toBe(true);
  });
});

describe('fresh init keeps its own plumbing out of coverage', () => {
  // The files yg init writes at the repository root are repository plumbing,
  // not project source. A fresh project's first yg check must not list them as
  // uncovered to-dos, so the scaffold writes exactly the ones it installed into
  // coverage.excluded.
  async function excludedOf(ygg: string): Promise<unknown> {
    const { parse } = await import('yaml');
    const cfg = parse(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')) as { coverage?: { excluded?: unknown; required?: unknown } };
    expect(cfg.coverage?.required).toEqual([]);
    return cfg.coverage?.excluded;
  }

  it('keyless: excludes the three agent-rules files and .gitattributes', async () => {
    const { root, ygg } = await freshDir('plumbing-keyless');
    await freshInitKeyless(root, ygg);
    expect(await excludedOf(ygg)).toEqual(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md', '.gitattributes']);
  });

  it('with a reviewer: the same exclusion', async () => {
    const { root, ygg } = await freshDir('plumbing-provider');
    await freshInitNonInteractive(root, ygg, { provider: 'claude-code' });
    expect(await excludedOf(ygg)).toEqual(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md', '.gitattributes']);
  });

  it('an artifact switched off is not excluded, because it was never written', async () => {
    const { root, ygg } = await freshDir('plumbing-optout');
    await freshInitKeyless(root, ygg, { agentsMd: true, claudeMd: true, clinerules: false });
    expect(await excludedOf(ygg)).toEqual(['AGENTS.md', 'CLAUDE.md', '.gitattributes']);
  });

  it('keeps the explanatory comments of the scaffolded config', async () => {
    const { root, ygg } = await freshDir('plumbing-comments');
    await freshInitKeyless(root, ygg);
    const raw = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(raw).toContain('# Coverage — which files must belong to a node.');
  });
});

describe('freshInitNonInteractive', () => {
  it('writes a require-nothing coverage baseline and the named reviewer tier (claude-code needs no key)', async () => {
    const { root, ygg } = await freshDir('happy');
    await freshInitNonInteractive(root, ygg, { provider: 'claude-code', model: 'haiku' });
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
    await freshInitNonInteractive(root, ygg, { provider: 'ollama', model: 'qwen3' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('endpoint: http://localhost:11434');
  });

  it('claude-code without --model defaults to sonnet and writes the tier', async () => {
    const { root, ygg } = await freshDir('default-model');
    await freshInitNonInteractive(root, ygg, { provider: 'claude-code' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('model: sonnet');
  });

  it('codex without --model exits 1 with a model-required message', async () => {
    const { root, ygg } = await freshDir('nomodel-codex');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(freshInitNonInteractive(root, ygg, { provider: 'codex' })).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--model is required');
  });

  it('exits 1 when an OpenAI-compatible provider is given no --endpoint', async () => {
    const { root, ygg } = await freshDir('noendpoint');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      freshInitNonInteractive(root, ygg, { provider: 'openai-compatible', model: 'gpt-x' }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--endpoint is required');
  });
});

describe('existingInitNonInteractive', () => {
  it('adds a reviewer to a keyless repo via flags', async () => {
    const { root, ygg } = await freshDir('add-reviewer');
    await freshInitKeyless(root, ygg);
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code' }); // model defaults sonnet
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('provider: claude-code');
    expect(cfg).toContain('model: sonnet');
  });

  it('refreshes the universal agent rules via a deprecated --platform, printing a deprecation notice', async () => {
    const { root, ygg } = await freshDir('deprecated-platform');
    await freshInitKeyless(root, ygg);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await existingInitNonInteractive(root, ygg, { platform: 'cursor' });
    const written = out.mock.calls.map(c => String(c[0])).join('');
    out.mockRestore();
    // The universal artifacts (not a per-platform file) are what actually get refreshed.
    const claude = await readFile(path.join(root, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('@AGENTS.md');
    expect(written).toContain('is deprecated and was ignored');
  });
});

describe('resolveReviewerConfigFromFlags', () => {
  it('defaults the model to sonnet for claude-code when --model is omitted', () => {
    const r = resolveReviewerConfigFromFlags({ provider: 'claude-code' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.model).toBe('sonnet');
  });

  it('requires --model for codex, gemini-cli and copilot-cli', () => {
    for (const provider of ['codex', 'gemini-cli', 'copilot-cli'] as const) {
      const r = resolveReviewerConfigFromFlags({ provider });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.issue.what).toContain('--model is required');
        // Finding 1 regression guard: the suggested retry command must be
        // immediately runnable as-is and must NOT mention --platform — the
        // flag is deprecated and no caller forwards a value into this
        // resolver, so suggesting it would point the user at a flag that
        // only prints a deprecation notice.
        expect(r.issue.next).not.toContain('--platform');
      }
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
      // The suggested retry command must be immediately runnable as-is and must
      // NOT mention --platform: the flag is deprecated and no caller forwards a
      // value into this resolver, so suggesting it would point the user at a
      // flag that only prints a deprecation notice.
      expect(bad.issue.next).toContain('--endpoint <url>');
      expect(bad.issue.next).not.toContain('--platform');
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

describe('init --provider keeps yg-config.yaml readable', () => {
  it('adding a reviewer to an existing repo keeps every comment and the quoted version', async () => {
    const { root, ygg } = await freshDir('keep-comments');
    await freshInitKeyless(root, ygg);
    const before = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await existingInitNonInteractive(root, ygg, { provider: 'copilot-cli', model: 'auto' });
    const after = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    const comments = (t: string) => t.split('\n').filter((l) => l.trim().startsWith('#'));
    expect(comments(after)).toEqual(comments(before));
    expect(after).toContain('NOTE: an ABSENT');
    expect(after).toMatch(/^version: "/m);
    // Only lines were added: every line of the old file is still there, in order.
    const added = after.split('\n').filter((l) => !before.split('\n').includes(l));
    expect(added.join('\n')).toContain('provider: copilot-cli');
    expect(after.split('\n').filter((l) => before.split('\n').includes(l))).toEqual(before.split('\n'));
  });

  it('replacing an existing reviewer keeps the comments too', async () => {
    const { root, ygg } = await freshDir('replace-reviewer');
    await freshInitKeyless(root, ygg);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code', model: 'sonnet' });
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code', model: 'haiku' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('model: haiku');
    expect(cfg).not.toContain('model: sonnet');
    expect(cfg).toContain('NOTE: an ABSENT');
  });
});

describe('init --provider checks the CLI it configures', () => {
  afterEach(() => { cliProbe.result = { ok: true }; });
  const notFound = "'codex' was not found on PATH — install the Codex CLI (npm i -g @openai/codex) and sign in with `codex login`";

  it('turns a failed CLI check into a warning naming the cause', async () => {
    cliProbe.result = { ok: false, error: notFound };
    const warning = await probeReviewerFromFlags({ provider: 'codex', model: 'o4-mini' });
    expect(warning?.what).toBe(`The codex reviewer cannot run on this machine: ${notFound}.`);
    expect(warning?.why).toContain('The configuration was written anyway');
  });

  it('says nothing when the CLI runs, and does not contact an API provider', async () => {
    expect(await probeReviewerFromFlags({ provider: 'codex', model: 'o4-mini' })).toBeUndefined();
    cliProbe.result = { ok: false, error: 'should not be asked' };
    expect(await probeReviewerFromFlags({ provider: 'anthropic', model: 'claude-sonnet-5' })).toBeUndefined();
  });

  it('the flag path prints the warning, still writes the tier and does not exit', async () => {
    const { root, ygg } = await freshDir('probe-warning');
    await freshInitKeyless(root, ygg);
    cliProbe.result = { ok: false, error: "'claude' was not found on PATH — install Claude Code" };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code' });
    expect(exit).not.toHaveBeenCalled();
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain("The claude-code reviewer cannot run on this machine: 'claude' was not found on PATH — install Claude Code.");
    expect(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')).toContain('provider: claude-code');
  });
});

describe('resolveReviewerConfigFromFlags — model and key messages', () => {
  it('copilot-cli without --model points at --model auto', () => {
    const r = resolveReviewerConfigFromFlags({ provider: 'copilot-cli' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.why).toContain("Copilot policy decides which models a seat may use");
      expect(r.issue.next).toContain('--model auto');
    }
  });

  it('codex without --model does not claim codex has no default anywhere', () => {
    const r = resolveReviewerConfigFromFlags({ provider: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.why).not.toContain('Only claude-code has a built-in default model');
      expect(r.issue.why).toContain('falls back to a built-in model at run time');
    }
  });

  it('refuses a copilot-cli model name the reviewer would refuse at run time', () => {
    const r = resolveReviewerConfigFromFlags({ provider: 'copilot-cli', model: 'bad!model' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.what).toContain("is not a model name copilot-cli can pass on");
  });

  it('openai-compatible without a key is told the key is optional, not that it is required', () => {
    const saved = process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    try {
      const r = resolveReviewerConfigFromFlags({ provider: 'openai-compatible', model: 'local', endpoint: 'http://127.0.0.1:8000/v1' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.keyWarning?.what).toBe('No API key found in $OPENAI_COMPATIBLE_API_KEY; the reviewer will call http://127.0.0.1:8000/v1 without one.');
        expect(r.keyWarning?.why).toContain('the key is optional for this provider');
        expect(r.keyWarning?.why).not.toContain('needs a key');
      }
    } finally {
      if (saved !== undefined) process.env.OPENAI_COMPATIBLE_API_KEY = saved;
    }
  });
});
