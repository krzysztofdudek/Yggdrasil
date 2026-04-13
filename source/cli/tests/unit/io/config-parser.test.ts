import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../../src/io/config-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');

describe('config-parser', () => {
  it('parses valid yg-config.yaml correctly', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));

    expect(config.quality?.max_direct_relations).toBeDefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-empty');
    await mkdir(tmpDir, { recursive: true });
    const badConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(badConfigPath, '', 'utf-8');

    await expect(parseConfig(badConfigPath)).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses minimal config', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-minimal');
    await mkdir(tmpDir, { recursive: true });
    const minimalConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      minimalConfigPath,
      `
version: "4.0.0"
`,
      'utf-8',
    );

    const config = await parseConfig(minimalConfigPath);
    expect(config.version).toBe('4.0.0');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality.max_direct_relations when present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBeDefined();
  });


  it('parses version field when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-version');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `version: "2.0.0"
`,
      'utf-8',
    );
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.version).toBe('2.0.0');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults version to undefined when not present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.version).toBeUndefined();
  });

  it('ignores unknown config sections', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-ignores-artifacts');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
custom_section:
  key: value
  nested:
    deep: true
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.version).toBe('4.0.0');
    // unknown fields should not exist on returned config
    expect((config as Record<string, unknown>).custom_section).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality defaults when quality is not provided', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-no-quality');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBe(10);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses partial quality configuration with defaults', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-partial-quality');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
quality:
  max_direct_relations: 15
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBe(15);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses parallel: 5', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: 5\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.parallel).toBe(5);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parallel field absent → config.parallel is undefined', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-noparallel');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.parallel).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when parallel is 0', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel-zero');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: 0\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'parallel must be a positive integer',
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses debug: true', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-debug-true');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\ndebug: true\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.debug).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('debug absent → config.debug is undefined', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-no-debug');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.debug).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts config without reviewer section', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-no-llm-config');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(
        configPath,
        `
version: "4.0.0"
`,
        'utf-8',
      );

      const config = await parseConfig(configPath);
      expect(config.llm).toBeUndefined();

      await rm(tmpDir, { recursive: true, force: true });
    });

  describe('config-parser reviewer section', () => {
    it('parses reviewer: with single ollama provider (implicit active)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-ollama');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  consensus: 3
  ollama:
    model: qwen3
    temperature: 0.1
    endpoint: http://localhost:11434
    max_tokens: auto
    context_length_field: qwen35.context_length
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm).toEqual({
        provider: 'ollama',
        model: 'qwen3',
        endpoint: 'http://localhost:11434',
        temperature: 0.1,
        consensus: 3,
        max_tokens: 'auto',
        context_length_field: 'qwen35.context_length',
      });

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses reviewer: with single claude-code provider (implicit active)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-claude');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  claude-code:
    model: haiku
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm).toEqual({
        provider: 'claude-code',
        model: 'haiku',
        endpoint: undefined,
        temperature: 0,
        consensus: 1,
        max_tokens: 'auto',
      });

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses reviewer: with explicit active selector', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-active');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  active: claude-code
  consensus: 1
  ollama:
    model: qwen3
    temperature: 0.0
  claude-code:
    model: haiku
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm!.provider).toBe('claude-code');
      expect(config.llm!.model).toBe('haiku');

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns undefined llm when reviewer: has no providers', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-empty');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  consensus: 1
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm).toBeUndefined();

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when two providers and no active selector', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-two-no-active');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  ollama:
    model: qwen3
  claude-code:
    model: haiku
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /reviewer\.active/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when active points to unconfigured provider', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-bad-active');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  active: claude-code
  ollama:
    model: qwen3
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /claude-code.*not configured/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws on unknown key under reviewer:', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-unknown-key');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  foo:
    model: bar
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /unknown key 'foo' under reviewer/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when reviewer.consensus is an even number', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-bad-consensus');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  consensus: 2
  ollama:
    model: qwen3
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /consensus must be a positive odd integer/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when reviewer.ollama.model is empty', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-no-model');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  ollama:
    model: ""
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /reviewer.ollama.model must be a non-empty string/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('throws when reviewer.ollama.max_tokens is invalid (zero)', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-bad-max-tokens');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  ollama:
    model: qwen3
    max_tokens: 0
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /reviewer.ollama.max_tokens must be 'auto' or positive number/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses openai provider config', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-openai');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  openai:
    model: gpt-4.1-mini
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm?.provider).toBe('openai');

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses CLI provider with timeout', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-codex-timeout');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  codex:
    model: o4-mini
    timeout: 180000
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm?.timeout).toBe(180000);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('ignores timeout for API providers', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-openai-timeout');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  openai:
    model: gpt-4.1-mini
    timeout: 60000
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm?.timeout).toBeUndefined();

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('uses default model for claude-code when not specified', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-claude-default-model');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  claude-code: {}
`,
        'utf-8',
      );

      const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
      expect(config.llm?.model).toBe('haiku');

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects unknown provider key', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-reviewer-unknown-provider');
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        path.join(tmpDir, 'yg-config.yaml'),
        `
version: "4.0.0"
reviewer:
  unknown-provider:
    model: test
`,
        'utf-8',
      );

      await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
        /unknown key 'unknown-provider' under reviewer/,
      );

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

});
