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

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-test-123
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
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
      provider: 'claude-code' as const,
      api_key: 'sk-123',
    };
    const merged = mergeLlmConfig(baseConfig, secretsOverrides);
    expect(merged.provider).toBe('claude-code');
    expect(merged.model).toBe('llama3.1:8b'); // not overridden
    expect(merged.api_key).toBe('sk-123');
  });

  it('returns undefined when secrets file has no reviewer section', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-no-reviewer');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
other_config: value
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when reviewer section is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-empty-reviewer');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer: {}
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads provider fields from reviewer secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    model: qwen3
    consensus: 3
    max_tokens: 4096
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.model).toBe('qwen3');
    expect(secrets?.consensus).toBe(3);
    expect(secrets?.max_tokens).toBe(4096);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads multiple fields from reviewer secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-multiple');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-test-456
    endpoint: https://api.example.com
    temperature: 0.5
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.api_key).toBe('sk-test-456');
    expect(secrets?.endpoint).toBe('https://api.example.com');
    expect(secrets?.temperature).toBe(0.5);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when provider key not in secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-wrong-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-123
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'claude-code');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when secrets YAML is empty (null parse result)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-empty-file');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), '', 'utf-8');

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when providerName is omitted', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-default-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-default-test
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir); // no providerName — returns undefined
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when provider section has no recognized fields', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-no-known-fields');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    unknown_field: some_value
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts provider field from secrets when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider-field');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    provider: claude-code
    model: haiku
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.provider).toBe('claude-code');
    expect(secrets?.model).toBe('haiku');

    await rm(tmpDir, { recursive: true, force: true });
  });
});
