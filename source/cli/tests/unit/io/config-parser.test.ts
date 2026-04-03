import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../../src/io/config-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');

describe('config-parser', () => {
  it('parses valid yg-config.yaml correctly', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));

    expect(config.name).toBe('Sample E-Commerce System');
    expect(config.quality?.context_budget.warning).toBe(8000);
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

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config');
    await mkdir(tmpDir, { recursive: true });
    const badConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      badConfigPath,
      `
version: "1.0.0"
`,
      'utf-8',
    );

    await expect(parseConfig(badConfigPath)).rejects.toThrow(
      "yg-config.yaml: missing or invalid 'name' field",
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
name: "Minimal Config"
`,
      'utf-8',
    );

    const config = await parseConfig(minimalConfigPath);
    expect(config.name).toBe('Minimal Config');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality.context_budget when present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.quality?.context_budget.warning).toBe(8000);
    expect(config.quality?.context_budget.error).toBe(16000);
  });

  it('throws when quality.context_budget.error < warning', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-budget');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Budget"
quality:
  context_budget:
    warning: 10000
    error: 5000
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'must be >= warning',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });


  it('parses version field when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-version');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `version: "2.0.0"
name: "Versioned"
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

  it('ignores artifacts section in config (no longer parsed)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-ignores-artifacts');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "WithArtifacts"
artifacts:
  responsibility.md:
    required: always
    description: "x"
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.name).toBe('WithArtifacts');
    // artifacts field should not exist on returned config
    expect((config as Record<string, unknown>).artifacts).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });
});
