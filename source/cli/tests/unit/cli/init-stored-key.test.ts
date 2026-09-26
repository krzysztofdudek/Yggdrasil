import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { freshInitKeyless, freshInitNonInteractive, existingInitNonInteractive } from '../../../src/cli/init.js';
import { readReviewerTarget, settleStoredKey } from '../../../src/cli/init-reviewer-setup.js';
import { parseConfig } from '../../../src/io/config-parser.js';
import { resolveApiKey } from '../../../src/llm/api-utils.js';

// The key yg-secrets.yaml holds for the bootstrap tier outranks the provider's
// environment variable at run time. These tests pin the two promises init makes
// about that key:
//   - a key taken from the environment is never written to disk (it would then
//     outrank the variable and go stale the day the variable is rotated);
//   - a key stored for one reviewer never follows the tier to another provider
//     or endpoint, and what init prints about the key is what the reviewer sends.
// The last word is always the resolved configuration the reviewer is built from.

vi.mock('../../../src/llm/reviewer-test.js', () => ({
  testCliProvider: async () => ({ ok: true }),
  testApiProvider: async () => ({ ok: true }),
}));

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'];
const STALE = 'sk-ant-STALE-FROM-PREVIOUS-PROVIDER';

const dirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};
let out = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(label: string): Promise<{ root: string; ygg: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `yg-stored-key-${label}-`));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await freshInitKeyless(root, ygg);
  return { root, ygg };
}

const secretsPath = (ygg: string) => path.join(ygg, 'yg-secrets.yaml');

async function writeSecrets(ygg: string, doc: Record<string, unknown>): Promise<void> {
  await writeFile(secretsPath(ygg), stringifyYaml(doc), 'utf-8');
}

async function readSecrets(ygg: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(secretsPath(ygg))) return undefined;
  return parseYaml(await readFile(secretsPath(ygg), 'utf-8')) as Record<string, unknown>;
}

/** The key the reviewer built from this configuration would send. */
async function keyTheReviewerSends(ygg: string): Promise<string | undefined> {
  const config = await parseConfig(path.join(ygg, 'yg-config.yaml'));
  const tier = config.reviewer?.tiers.standard;
  expect(tier).toBeDefined();
  return resolveApiKey(tier!);
}

/** An anthropic reviewer configured by an earlier init, its key stored in the overlay. */
async function anthropicWithStoredKey(label: string, extra: Record<string, unknown> = {}): Promise<{ root: string; ygg: string }> {
  const p = await project(label);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
  await existingInitNonInteractive(p.root, p.ygg, { provider: 'anthropic', model: 'claude-x' });
  delete process.env.ANTHROPIC_API_KEY;
  await writeSecrets(p.ygg, { ...extra, reviewer: { tiers: { standard: { config: { api_key: STALE } } } } });
  out = '';
  return p;
}

describe('init never copies an environment key to disk (flag path)', () => {
  it('fresh init with the key exported writes no yg-secrets.yaml, and the reviewer still reads the variable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-stored-key-fresh-'));
    dirs.push(root);
    const ygg = path.join(root, '.yggdrasil');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-FAKE123';
    await freshInitNonInteractive(root, ygg, { provider: 'anthropic', model: 'claude-x' });
    expect(existsSync(secretsPath(ygg))).toBe(false);
    expect(out).not.toContain('sk-ant-test-FAKE123');
    expect(await keyTheReviewerSends(ygg)).toBe('sk-ant-test-FAKE123');
  });

  it('reconfiguring an existing repo with the key exported writes no yg-secrets.yaml either', async () => {
    const { root, ygg } = await project('existing-env');
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    await existingInitNonInteractive(root, ygg, { provider: 'openai', model: 'gpt-x' });
    expect(existsSync(secretsPath(ygg))).toBe(false);
  });

  it('a rotated environment key is the one sent: a stored key for the same tier is removed, not left to outrank it', async () => {
    const { root, ygg } = await anthropicWithStoredKey('rotated');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-rotated';
    await existingInitNonInteractive(root, ygg, { provider: 'anthropic', model: 'claude-x' });
    expect(await keyTheReviewerSends(ygg)).toBe('sk-ant-rotated');
    expect(out).toContain('Removed the api_key .yggdrasil/yg-secrets.yaml held for this tier');
    expect(out).toContain('outranks $ANTHROPIC_API_KEY');
  });
});

describe('a provider switch never carries the stored key to the new reviewer', () => {
  it('--provider openai-compatible after anthropic: the old key is gone and the "no key" line is true', async () => {
    const { root, ygg } = await anthropicWithStoredKey('switch-compatible');
    await existingInitNonInteractive(root, ygg, {
      provider: 'openai-compatible', model: 'local', endpoint: 'http://127.0.0.1:9999/v1',
    });
    expect(await keyTheReviewerSends(ygg)).toBeUndefined();
    // The key alone was in the overlay, so the file is gone with it.
    expect(existsSync(secretsPath(ygg))).toBe(false);
    expect(out).toContain('Removed the api_key .yggdrasil/yg-secrets.yaml held for this tier (stored while the tier used anthropic)');
    expect(out).toContain('No API key found in $OPENAI_COMPATIBLE_API_KEY; the reviewer will call http://127.0.0.1:9999/v1 without one.');
    expect(out).not.toContain(STALE);
  });

  it('--provider openai with its own variable exported: the reviewer sends the new variable, not the stored key', async () => {
    const { root, ygg } = await anthropicWithStoredKey('switch-openai');
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    await existingInitNonInteractive(root, ygg, { provider: 'openai', model: 'gpt-x' });
    expect(await keyTheReviewerSends(ygg)).toBe('sk-openai-env');
  });

  it('a switch to a CLI reviewer removes the key too', async () => {
    const { root, ygg } = await anthropicWithStoredKey('switch-cli');
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code' });
    expect(existsSync(secretsPath(ygg))).toBe(false);
  });

  it('a new endpoint for the same openai-compatible provider is a switch as well', async () => {
    const { root, ygg } = await project('switch-endpoint');
    await existingInitNonInteractive(root, ygg, { provider: 'openai-compatible', model: 'm', endpoint: 'http://a.example/v1' });
    await writeSecrets(ygg, { reviewer: { tiers: { standard: { config: { api_key: 'sk-for-a' } } } } });
    await existingInitNonInteractive(root, ygg, { provider: 'openai-compatible', model: 'm', endpoint: 'http://b.example/v1' });
    expect(await keyTheReviewerSends(ygg)).toBeUndefined();
  });

  it('only the key is removed: every other local override in yg-secrets.yaml stays', async () => {
    const { root, ygg } = await anthropicWithStoredKey('keep-others', { parallel: 2 });
    await writeSecrets(ygg, {
      parallel: 2,
      reviewer: { tiers: { standard: { config: { api_key: STALE, timeout: 30 } } } },
    });
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code' });
    expect(await readSecrets(ygg)).toEqual({ parallel: 2, reviewer: { tiers: { standard: { config: { timeout: 30 } } } } });
  });
});

describe('re-running init for the same reviewer keeps the stored key, and says so', () => {
  it('same provider, nothing exported: the key stays and init does not claim there is none', async () => {
    const { root, ygg } = await anthropicWithStoredKey('same');
    await existingInitNonInteractive(root, ygg, { provider: 'anthropic', model: 'claude-y' });
    expect(await keyTheReviewerSends(ygg)).toBe(STALE);
    expect(out).toContain('Kept the api_key .yggdrasil/yg-secrets.yaml already holds for this tier; the reviewer will send it.');
    expect(out).not.toContain('No API key found');
  });

  it('an overlay that pins the provider itself keeps its key: the tier still sends where it did', async () => {
    const { root, ygg } = await project('overlay-provider');
    await existingInitNonInteractive(root, ygg, { provider: 'claude-code' });
    await writeSecrets(ygg, { reviewer: { tiers: { standard: { provider: 'anthropic', config: { api_key: STALE } } } } });
    expect(await readReviewerTarget(ygg)).toEqual({ provider: 'anthropic' });
    await existingInitNonInteractive(root, ygg, { provider: 'codex', model: 'gpt-5' });
    // yg-secrets.yaml still overrides the provider, so the key goes where it always did.
    expect(await readReviewerTarget(ygg)).toEqual({ provider: 'anthropic' });
    expect(await keyTheReviewerSends(ygg)).toBe(STALE);
  });
});

describe('the wizard settles the stored key the same way', () => {
  it('an answered key (typed, environment, or none) is never outranked by an older stored one', async () => {
    const { ygg } = await anthropicWithStoredKey('wizard-answered');
    const prev = await readReviewerTarget(ygg);
    expect(await settleStoredKey(ygg, prev, { provider: 'anthropic', keyAnswered: true })).toBe('removed');
    expect(existsSync(secretsPath(ygg))).toBe(false);
  });

  it('a typed key replaces the stored one', async () => {
    const { ygg } = await anthropicWithStoredKey('wizard-typed');
    const prev = await readReviewerTarget(ygg);
    expect(await settleStoredKey(ygg, prev, { provider: 'anthropic', apiKey: 'sk-typed', keyAnswered: true })).toBe('stored');
    expect(await keyTheReviewerSends(ygg)).toBe('sk-typed');
  });
});
