import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../../src/io/config-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');

describe('config-parser', () => {
  it('parses valid yg-config.yaml correctly (v2.2)', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));

    expect(config.name).toBe('Sample E-Commerce System');
    expect(config.quality?.context_budget.warning).toBe(8000);
    expect(config.node_types['service']).toBeDefined();
    expect(config.artifacts['responsibility.md']).toBeDefined();
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
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: always
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(badConfigPath)).rejects.toThrow(
      "yg-config.yaml: missing or invalid 'name' field",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses minimal config without tags field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-minimal');
    await mkdir(tmpDir, { recursive: true });
    const minimalConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      minimalConfigPath,
      `
name: "Minimal Config"
node_types:
  module:
    description: x
artifacts:
  responsibility:
    required: always
    description: "x"
`,
      'utf-8',
    );

    const config = await parseConfig(minimalConfigPath);
    expect(config.name).toBe('Minimal Config');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses included_in_relations when present in artifact', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-structural');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Structural"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: always
    description: "x"
  interface:
    required: never
    description: "API"
    included_in_relations: true
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.artifacts.interface.included_in_relations).toBe(true);
    expect(config.artifacts.responsibility.included_in_relations).toBe(false);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality.context_budget when present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.quality?.context_budget.warning).toBe(8000);
    expect(config.quality?.context_budget.error).toBe(16000);
  });

  it('throws when artifact name is yg-node.yaml (reserved)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-node');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Reserved"
node_types:
  service:
    description: x
artifacts:
  yg-node.yaml:
    required: always
    description: "x"
  responsibility:
    required: always
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "artifact name 'yg-node.yaml' is reserved",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when artifact required is invalid', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-invalid-required');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Invalid"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: invalid_value
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "invalid 'required' field",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when required.when is invalid', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-invalid-when');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "InvalidWhen"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required:
      when: has_foo
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "invalid 'required.when'",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when quality.context_budget.error < warning', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-budget');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Budget"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: always
    description: "x"
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

  it('throws when node_types is not an object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-types-not-object');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Bad"
node_types: "not-object"
artifacts:
  responsibility:
    required: always
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "'node_types' must be a non-empty object",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when node_types is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-empty-types');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Bad"
node_types: {}
artifacts:
  responsibility:
    required: always
    description: "x"
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "'node_types' must be a non-empty object",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses node_types with description and required_aspects', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-node-types');
    await mkdir(tmpDir, { recursive: true });
    const configPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      configPath,
      `
name: T
node_types:
  module:
    description: business logic unit
  service:
    description: component providing functionality
    required_aspects: [requires-audit]
artifacts:
  responsibility.md:
    required: always
    description: x
`,
      'utf-8',
    );
    const cfg = await parseConfig(configPath);
    expect(cfg.node_types['module']).toEqual({ description: 'business logic unit' });
    expect(cfg.node_types['service']).toEqual({ description: 'component providing functionality', required_aspects: ['requires-audit'] });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when artifacts is array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-artifacts-array');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "Bad"
node_types:
  service:
    description: x
artifacts: []
`,
      'utf-8',
    );

    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      "'artifacts' must be a non-empty object",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults artifact description to empty string when missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-artifact-no-desc');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "NoDesc"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: always
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.artifacts.responsibility.description).toBe('');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts has_aspect: as valid when condition', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-has-aspect');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
name: "HasAspect"
node_types:
  service:
    description: x
artifacts:
  responsibility:
    required: always
    description: "x"
  compliance:
    required:
      when: has_aspect:regulated
    description: "y"
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.artifacts.compliance.required).toEqual({ when: 'has_aspect:regulated' });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when node_types entry has missing description', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-bad-type-entry');
    await mkdir(tmpDir, { recursive: true });
    const configPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      configPath,
      `
name: "BadEntry"
node_types:
  service: {}
artifacts:
  responsibility.md:
    required: always
    description: x
`,
      'utf-8',
    );

    await expect(parseConfig(configPath)).rejects.toThrow(
      "node_types.service must have a non-empty 'description' string",
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
node_types:
  module:
    description: x
artifacts:
  responsibility.md:
    required: always
    description: "x"
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

});
