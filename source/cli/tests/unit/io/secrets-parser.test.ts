import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, mergeLlmConfig } from '../../../src/io/secrets-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('secrets-parser', () => {
  it('loads api_key from secrets and merges with config', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-api-key');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    const secretsPath = path.join(yggDir, 'yg-secrets.yaml');
    await writeFile(
      secretsPath,
      `
llm:
  api_key: sk-test-123
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir);
    expect(secrets?.api_key).toBe('sk-test-123');

    const baseConfig = {
      provider: 'ollama' as const,
      model: 'llama3.1:8b',
      temperature: 0,
      consensus: 1,
      max_tokens: 'auto' as const,
    };
    const merged = mergeLlmConfig(baseConfig, secrets!);
    expect(merged.api_key).toBe('sk-test-123');
    expect(merged.provider).toBe('ollama'); // from base, not overridden

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no secrets file exists', async () => {
    const nonexistentPath = '/nonexistent/path/that/does/not/exist';
    const secrets = await loadSecrets(nonexistentPath);
    expect(secrets).toBeUndefined();
  });

  it('secrets override base config fields', async () => {
    const baseConfig = {
      provider: 'ollama' as const,
      model: 'llama3.1:8b',
      temperature: 0,
      consensus: 1,
      max_tokens: 'auto' as const,
    };
    const secretsOverrides = {
      provider: 'openai' as const,
      api_key: 'sk-123',
    };
    const merged = mergeLlmConfig(baseConfig, secretsOverrides);
    expect(merged.provider).toBe('openai');
    expect(merged.model).toBe('llama3.1:8b'); // not overridden
    expect(merged.api_key).toBe('sk-123');
  });

  it('returns undefined when secrets file has no llm section', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-no-llm');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    const secretsPath = path.join(yggDir, 'yg-secrets.yaml');
    await writeFile(
      secretsPath,
      `
other_config: value
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir);
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when secrets llm section is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-empty-llm');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    const secretsPath = path.join(yggDir, 'yg-secrets.yaml');
    await writeFile(
      secretsPath,
      `
llm: {}
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir);
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads provider and model from secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    const secretsPath = path.join(yggDir, 'yg-secrets.yaml');
    await writeFile(
      secretsPath,
      `
llm:
  provider: anthropic
  model: claude-3
  consensus: 3
  max_tokens: 4096
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir);
    expect(secrets?.provider).toBe('anthropic');
    expect(secrets?.model).toBe('claude-3');
    expect(secrets?.consensus).toBe(3);
    expect(secrets?.max_tokens).toBe(4096);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads multiple fields from secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-multiple');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    const secretsPath = path.join(yggDir, 'yg-secrets.yaml');
    await writeFile(
      secretsPath,
      `
llm:
  api_key: sk-test-456
  endpoint: https://api.openai.com
  temperature: 0.5
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir);
    expect(secrets?.api_key).toBe('sk-test-456');
    expect(secrets?.endpoint).toBe('https://api.openai.com');
    expect(secrets?.temperature).toBe(0.5);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
