import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';
import type { YggConfig, LlmConfig } from '../../../src/model/graph.js';

/** Bridge: extract the first (and typically only) tier from the new ReviewerConfig structure */
function getLlm(config: YggConfig): LlmConfig | undefined {
  if (!config.reviewer) return undefined;
  const tiers = Object.values(config.reviewer.tiers);
  return tiers.length > 0 ? tiers[0] : undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-config') || e.startsWith('tmp-no-llm') || e.startsWith('tmp-reviewer') || e.startsWith('tmp-v5'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

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

  it('throws on a top-level YAML sequence (array) config', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-array');
    await mkdir(tmpDir, { recursive: true });
    const badConfigPath = path.join(tmpDir, 'yg-config.yaml');
    // A paste/indent accident that makes the top level a YAML sequence rather
    // than a mapping. This must be rejected, not silently coerced to defaults.
    await writeFile(badConfigPath, '- reviewer:\n    tiers: {}\n- quality:\n    max_direct_relations: 5\n', 'utf-8');

    await expect(parseConfig(badConfigPath)).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );
    await expect(parseConfig(badConfigPath)).rejects.toBeInstanceOf(ConfigParseError);

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

  it('throws when parallel is a string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel-string');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: "4"\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'parallel must be a number',
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when quality is not a mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-quality-string');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nquality: "high"\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'quality must be a mapping',
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
      expect(getLlm(config)).toBeUndefined();

      await rm(tmpDir, { recursive: true, force: true });
    });

  describe('parseConfig v5 happy paths', () => {
    it('minimal v5 config with one tier', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-minimal');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config:
        model: sonnet
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.standard).toBeDefined();
      expect(cfg.reviewer?.tiers.standard.provider).toBe('claude-code');
      expect(cfg.reviewer?.tiers.standard.model).toBe('sonnet');
    });

    it('v5 with default and multiple tiers', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-multi-tiers');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  default: deep
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config: { model: sonnet }
    deep:
      provider: claude-code
      consensus: 3
      config: { model: opus }
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.default).toBe('deep');
      expect(cfg.reviewer?.tiers.standard).toBeDefined();
      expect(cfg.reviewer?.tiers.deep).toBeDefined();
      expect(cfg.reviewer?.tiers.standard.consensus).toBe(1);
      expect(cfg.reviewer?.tiers.deep.consensus).toBe(3);
    });

    it('v5 single tier with temperature (max_tokens no longer a recognized field — silently ignored)', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-ollama-tier');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    main:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        temperature: 0.2
        max_tokens: 4096
`, 'utf-8');

      // max_tokens is now a removed field — silently ignored; temperature still parses
      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.main.temperature).toBe(0.2);
      expect((cfg.reviewer?.tiers.main as unknown as Record<string, unknown>)['max_tokens']).toBeUndefined();
    });

    it('v5 model defaults — claude-code without explicit model in config', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-provider-defaults');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    cheap:
      provider: claude-code
      consensus: 1
      config: {}
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.cheap.model).toBe('haiku');
    });

    it('v5 tier config carries api_key and endpoint through to the resolved tier', async () => {
      // api_key in a tier's config: block is the documented landing site for the
      // gitignored yg-secrets.yaml overlay; an explicit endpoint is what an
      // openai-compatible tier requires (no safe default host). Both must survive
      // the parse onto the resolved tier. (Previously exercised only incidentally
      // by an e2e suite that imported parseConfig in-process; pinned here as a
      // first-class unit assertion so the branches stay covered without coupling
      // the e2e suite to an internal module.)
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-key-endpoint');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    standard:
      provider: openai-compatible
      consensus: 1
      config:
        model: test-model
        endpoint: "https://example.test/v1"
        temperature: 0
        api_key: "sk-secret-xyz"
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      const tier = cfg.reviewer?.tiers.standard;
      expect(tier?.provider).toBe('openai-compatible');
      expect(tier?.endpoint).toBe('https://example.test/v1');
      expect(tier?.temperature).toBe(0);
      expect((tier as unknown as Record<string, unknown>).api_key).toBe('sk-secret-xyz');
    });
  });

  describe('parseConfig v5 error codes', () => {
    async function parseWithYaml(yaml: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-v5err-'));
      await writeFile(path.join(dir, 'yg-config.yaml'), yaml, 'utf-8');
      try {
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('config-tiers-missing when reviewer has no tiers key', async () => {
      await expect(parseWithYaml('reviewer:\n  default: foo\n'))
        .rejects.toMatchObject({ code: 'config-tiers-missing' });
    });

    it('config-tiers-empty when tiers is empty mapping', async () => {
      await expect(parseWithYaml('reviewer:\n  tiers: {}\n'))
        .rejects.toMatchObject({ code: 'config-tiers-empty' });
    });

    it('config-default-tier-missing on more than one tier without default', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    a:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
    b:
      provider: claude-code
      consensus: 1
      config: { model: opus }
`)).rejects.toMatchObject({ code: 'config-default-tier-missing' });
    });

    it('config-default-tier-unknown when default refs missing tier', async () => {
      await expect(parseWithYaml(`reviewer:
  default: missing
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-default-tier-unknown' });
    });

    it('config-tier-provider-missing when tier has no provider', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-provider-missing' });
    });

    it('config-tier-provider-unknown for unrecognized provider', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: gpt-5-turbo
      consensus: 1
      config: { model: latest }
`)).rejects.toMatchObject({ code: 'config-tier-provider-unknown' });
    });

    it('config-tier-config-missing when tier has no config block', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
`)).rejects.toMatchObject({ code: 'config-tier-config-missing' });
    });

    it('config-tier-config-not-mapping when config is not a mapping', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: "scalar"
`)).rejects.toMatchObject({ code: 'config-tier-config-not-mapping' });
    });

    it('config-tier-consensus-invalid on missing consensus', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-consensus-invalid' });
    });

    it('config-tier-consensus-invalid on even consensus', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 2
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-consensus-invalid' });
    });

    it('config-tier-name-invalid on bad tier name', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    123foo:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-name-invalid' });
    });

    it('config-tier-name-reserved on tier name "default"', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    default:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-name-reserved' });
    });

    it('config-reviewer-unknown-key for extra reviewer-level key', async () => {
      await expect(parseWithYaml(`reviewer:
  foo: bar
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-reviewer-unknown-key' });
    });

    it('config-tier-unknown-key for extra tier key', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
      extra: oops
`)).rejects.toMatchObject({ code: 'config-tier-unknown-key' });
    });

    it('max_tokens in config is silently ignored (no longer a recognized field)', async () => {
      // max_tokens was removed; it is now an unrecognized key in config: and must
      // not cause a parse error regardless of its value.
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        max_tokens: 0
`);
      expect(cfg.reviewer?.tiers.main).toBeDefined();
      expect((cfg.reviewer?.tiers.main as unknown as Record<string, unknown>)['max_tokens']).toBeUndefined();
    });

    // --- Retired-field silent-ignore boundary (docs no longer promise an error) ---
    // The parser reads only the keys it recognizes; retired `quality.*` fields and
    // unknown `config.*` keys under a tier are SILENTLY IGNORED (no error, no
    // warning). This is distinct from the unknown-KEY guard, which still rejects a
    // typo'd top-level key under `reviewer:` or a tier (see the two guard tests
    // below). The docs previously claimed a clear unknown-key error for retired
    // fields — these tests pin the true behavior.

    it('retired quality.max_node_chars is silently ignored (parses cleanly)', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
quality:
  max_node_chars: 12000
`);
      // Resolves without error; the retired field is dropped, the recognized
      // quality field still defaults.
      expect(cfg.reviewer?.tiers.main).toBeDefined();
      expect(cfg.quality?.max_direct_relations).toBe(10);
      expect((cfg.quality as unknown as Record<string, unknown>)['max_node_chars']).toBeUndefined();
    });

    it('retired per-tier references: cap block under config is silently ignored', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        references:
          max_bytes: 4096
`);
      expect(cfg.reviewer?.tiers.main).toBeDefined();
      expect(cfg.reviewer?.tiers.main.model).toBe('haiku');
    });

    it('config.context_length_field is silently ignored (mirrors max_tokens)', async () => {
      // context_length_field was never read by the parser; like max_tokens it is an
      // unrecognized config: key and must not cause a parse error.
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        context_length_field: num_ctx
`);
      expect(cfg.reviewer?.tiers.main).toBeDefined();
      expect((cfg.reviewer?.tiers.main as unknown as Record<string, unknown>)['context_length_field']).toBeUndefined();
    });

    it('a typo under reviewer: STILL rejects config-reviewer-unknown-key (distinct from silent-ignore)', async () => {
      await expect(parseWithYaml(`reviewer:
  defualt: main
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-reviewer-unknown-key' });
    });

    it('a typo at the tier top level STILL rejects config-tier-unknown-key (distinct from silent-ignore)', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consesnsus: 1
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-unknown-key' });
    });
  });

  it('defaults coverage to whole-repo required when absent', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-default');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\n', 'utf-8');
    const config = await parseConfig(p);
    expect(config.coverage).toEqual({ required: ['/'], excluded: [] });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses coverage.required and coverage.excluded', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-lists');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required:\n    - services/\n  excluded:\n    - vendor/\n', 'utf-8');
    const config = await parseConfig(p);
    expect(config.coverage).toEqual({ required: ['services/'], excluded: ['vendor/'] });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when coverage.required is not an array of strings', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-bad');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required: services\n', 'utf-8');
    await expect(parseConfig(p)).rejects.toThrow(ConfigParseError);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts an explicit empty coverage.required as "require nothing" (pure-advisory)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-cov-empty-req-'));
    try {
      const p = path.join(dir, 'yg-config.yaml');
      await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required: []\n', 'utf-8');
      const config = await parseConfig(p);
      // Explicit [] is permitted (not an error) and means require nothing — the
      // absent-block default of ['/'] only applies when coverage.required is omitted.
      expect(config.coverage).toEqual({ required: [], excluded: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Fix 4: throws config-invalid when a coverage.required root contains ".." segment', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-cov-dotdot-'));
    try {
      const p = path.join(dir, 'yg-config.yaml');
      await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required:\n    - services/../other/\n', 'utf-8');
      await expect(parseConfig(p)).rejects.toMatchObject({ code: 'config-invalid' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Fix 8b: throws when coverage.required is a number (not an array)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-cov-num-'));
    try {
      const p = path.join(dir, 'yg-config.yaml');
      await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required: 42\n', 'utf-8');
      await expect(parseConfig(p)).rejects.toThrow(ConfigParseError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Fix 8b: throws when coverage.required contains a non-string element', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-cov-nonstr-'));
    try {
      const p = path.join(dir, 'yg-config.yaml');
      await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required:\n    - services/\n    - 42\n', 'utf-8');
      await expect(parseConfig(p)).rejects.toThrow(ConfigParseError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Fix 8b: throws when coverage itself is a string (not a mapping)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-cov-str-'));
    try {
      const p = path.join(dir, 'yg-config.yaml');
      await writeFile(p, 'version: "5.0.0"\ncoverage: "all"\n', 'utf-8');
      await expect(parseConfig(p)).rejects.toThrow(ConfigParseError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('auto_approve field', () => {
    async function parseTmpConfig(yaml: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-auto-approve-'));
      await writeFile(path.join(dir, 'yg-config.yaml'), yaml, 'utf-8');
      try {
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('parses auto_approve: deterministic', async () => {
      const cfg = await parseTmpConfig(`version: "5.1.0"\nauto_approve: deterministic\n`);
      expect(cfg.auto_approve).toBe('deterministic');
    });

    it('defaults auto_approve to undefined when absent', async () => {
      const cfg = await parseTmpConfig(`version: "5.1.0"\n`);
      expect(cfg.auto_approve).toBeUndefined();
    });

    it('rejects invalid auto_approve value', async () => {
      await expect(parseTmpConfig(`version: "5.1.0"\nauto_approve: yes\n`))
        .rejects.toMatchObject({ code: 'config-invalid' });
    });
  });

  describe('timeout seconds→ms conversion', () => {
    async function parseWithYaml(yaml: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-timeout-'));
      await writeFile(path.join(dir, 'yg-config.yaml'), yaml, 'utf-8');
      try {
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('timeout: 5 in config yields 5000 ms internally', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        timeout: 5
`);
      expect(cfg.reviewer?.tiers.main.timeout).toBe(5000);
    });

    it('timeout absent yields undefined (cli-base applies 120000 ms default)', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
`);
      expect(cfg.reviewer?.tiers.main.timeout).toBeUndefined();
    });
  });

  describe('skipSecretsOverlay — committed-only config read', () => {
    // A fixture dir with BOTH yg-config.yaml (committed) and yg-secrets.yaml
    // (gitignored overlay) that injects a tier api_key. The default read merges
    // the overlay (behavior unchanged); skipSecretsOverlay:true reads committed
    // config ONLY, so the injected api_key never appears.
    async function makeConfigWithSecrets(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-skip-secrets-'));
      await writeFile(
        path.join(dir, 'yg-config.yaml'),
        `reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
`,
        'utf-8',
      );
      await writeFile(
        path.join(dir, 'yg-secrets.yaml'),
        `reviewer:
  tiers:
    standard:
      config:
        api_key: SECRET-FROM-OVERLAY
`,
        'utf-8',
      );
      return path.join(dir, 'yg-config.yaml');
    }

    it('default read merges the yg-secrets.yaml overlay (behavior unchanged)', async () => {
      const filePath = await makeConfigWithSecrets();
      try {
        const cfg = await parseConfig(filePath);
        expect(cfg.reviewer?.tiers.standard.api_key).toBe('SECRET-FROM-OVERLAY');
      } finally {
        await rm(path.dirname(filePath), { recursive: true, force: true });
      }
    });

    it('skipSecretsOverlay:true reads committed config only — no overlay api_key', async () => {
      const filePath = await makeConfigWithSecrets();
      try {
        const cfg = await parseConfig(filePath, { skipSecretsOverlay: true });
        expect(cfg.reviewer?.tiers.standard.api_key).toBeUndefined();
      } finally {
        await rm(path.dirname(filePath), { recursive: true, force: true });
      }
    });
  });

  // signals — the attention-layer switch block (RZ-21). Tolerated when absent,
  // strict-validated when present. Pins the parser contract the advisory
  // "structurally unusual" note in yg context --file gates on.
  describe('signals config key', () => {
    /** Write a config body (already including a version) to a fresh tmp dir and parse it. */
    async function parseWith(body: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(FIXTURES_DIR, 'tmp-config-signals-'));
      const filePath = path.join(dir, 'yg-config.yaml');
      await writeFile(filePath, `version: "5.1.0"\n${body}`, 'utf-8');
      try {
        return await parseConfig(filePath, { skipSecretsOverlay: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('(a) a config with NO signals key parses unchanged — signals is undefined (attention defaults ON)', async () => {
      const cfg = await parseWith('');
      expect(cfg.signals).toBeUndefined();
      // Default-ON contract: absent signals ⇒ attention !== false is true.
      expect(cfg.signals?.attention !== false).toBe(true);
    });

    it('(b) signals: { attention: false } parses to attention === false (the off-switch)', async () => {
      const cfg = await parseWith('signals:\n  attention: false\n');
      expect(cfg.signals).toEqual({ attention: false });
      expect(cfg.signals?.attention !== false).toBe(false);
    });

    it('signals: { attention: true } parses to attention === true (explicit ON)', async () => {
      const cfg = await parseWith('signals:\n  attention: true\n');
      expect(cfg.signals).toEqual({ attention: true });
    });

    it('an empty signals: {} mapping parses — attention undefined (still ON by default)', async () => {
      const cfg = await parseWith('signals: {}\n');
      expect(cfg.signals).toEqual({ attention: undefined });
      expect(cfg.signals?.attention !== false).toBe(true);
    });

    it('(c) an UNKNOWN sibling under signals is REJECTED (strict — a typo must not silently leave the note on)', async () => {
      await expect(parseWith('signals:\n  attetnion: false\n')).rejects.toThrow(ConfigParseError);
      await expect(parseWith('signals:\n  verbose: true\n')).rejects.toThrow(
        /unknown key 'verbose' under signals/,
      );
    });

    it('signals.attention must be boolean — a non-boolean is rejected with the guided next step', async () => {
      await expect(parseWith('signals:\n  attention: "yes"\n')).rejects.toThrow(
        /signals\.attention must be a boolean/,
      );
      // The NEXT guidance is verbatim contract.
      let captured: ConfigParseError | undefined;
      try {
        await parseWith('signals:\n  attention: 1\n');
      } catch (e) {
        captured = e as ConfigParseError;
      }
      expect(captured).toBeInstanceOf(ConfigParseError);
      expect(captured?.messageData.next).toBe(
        'Set signals.attention to true or false, or remove the signals key.',
      );
    });

    it('signals must be a mapping — a scalar value is rejected', async () => {
      await expect(parseWith('signals: on\n')).rejects.toThrow(/signals must be a mapping/);
    });
  });

  // events — the committed-events opt-in block (RZ-14). Tolerated when absent,
  // strict-validated when present. Pins the parser contract the committed
  // LLM-fill event stream gates on. Absent ⇒ LLM-fill events stay LOCAL +
  // gitignored (today's behavior); an absent key must NEVER change how any
  // existing config parses, and the key never folds into any verdict hash (G3).
  describe('events config key', () => {
    /** Write a config body (already including a version) to a fresh tmp dir and parse it. */
    async function parseWith(body: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(FIXTURES_DIR, 'tmp-config-events-'));
      const filePath = path.join(dir, 'yg-config.yaml');
      await writeFile(filePath, `version: "5.1.0"\n${body}`, 'utf-8');
      try {
        return await parseConfig(filePath, { skipSecretsOverlay: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('(a) a config with NO events key parses unchanged — events is undefined (committed stream OFF)', async () => {
      const cfg = await parseWith('');
      expect(cfg.events).toBeUndefined();
      // Default-OFF contract: absent events ⇒ committed_llm !== true.
      expect(cfg.events?.committed_llm === true).toBe(false);
    });

    it('(b) events: { committed_llm: true } parses to committed_llm === true (the opt-in)', async () => {
      const cfg = await parseWith('events:\n  committed_llm: true\n');
      expect(cfg.events).toEqual({ committed_llm: true });
      expect(cfg.events?.committed_llm === true).toBe(true);
    });

    it('events: { committed_llm: false } parses to committed_llm === false (explicit OFF)', async () => {
      const cfg = await parseWith('events:\n  committed_llm: false\n');
      expect(cfg.events).toEqual({ committed_llm: false });
      expect(cfg.events?.committed_llm === true).toBe(false);
    });

    it('an empty events: {} mapping parses — committed_llm undefined (still OFF by default)', async () => {
      const cfg = await parseWith('events: {}\n');
      expect(cfg.events).toEqual({ committed_llm: undefined });
      expect(cfg.events?.committed_llm === true).toBe(false);
    });

    it('(c) an UNKNOWN sibling under events is REJECTED (strict — a typo must not silently leave the stream off)', async () => {
      await expect(parseWith('events:\n  commited_llm: true\n')).rejects.toThrow(ConfigParseError);
      await expect(parseWith('events:\n  verbose: true\n')).rejects.toThrow(
        /unknown key 'verbose' under events/,
      );
    });

    it('events.committed_llm must be boolean — a non-boolean is rejected with the guided next step', async () => {
      await expect(parseWith('events:\n  committed_llm: "yes"\n')).rejects.toThrow(
        /events\.committed_llm must be a boolean/,
      );
      // The NEXT guidance is verbatim contract.
      let captured: ConfigParseError | undefined;
      try {
        await parseWith('events:\n  committed_llm: 1\n');
      } catch (e) {
        captured = e as ConfigParseError;
      }
      expect(captured).toBeInstanceOf(ConfigParseError);
      expect(captured?.messageData.next).toBe(
        'Set events.committed_llm to true or false, or remove the events key.',
      );
    });

    it('events must be a mapping — a scalar value is rejected', async () => {
      await expect(parseWith('events: on\n')).rejects.toThrow(/events must be a mapping/);
    });
  });

});
