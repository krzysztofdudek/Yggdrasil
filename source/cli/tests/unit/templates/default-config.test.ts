import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../../../src/templates/default-config.js';

describe('DEFAULT_CONFIG', () => {
  it('DEFAULT_CONFIG is valid YAML', () => {
    const parsed = parseYaml(DEFAULT_CONFIG);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('version is 5.2.0', () => {
    expect(DEFAULT_CONFIG).toMatch(/version: "5\.2\.0"/);
  });

  it('DEFAULT_CONFIG contains required keys', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.node_types).toBeUndefined();
    expect(parsed.artifacts).toBeUndefined();
    expect(parsed.quality).toBeDefined();
  });

  it('DEFAULT_CONFIG quality.max_direct_relations is 10', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      quality: { max_direct_relations: number };
    };
    expect(parsed.quality.max_direct_relations).toBe(10);
  });

  it('DEFAULT_CONFIG contains auto_approve: false', () => {
    expect(DEFAULT_CONFIG).toMatch(/auto_approve: false/);
  });

  it('DEFAULT_CONFIG auto_approve parses to false', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.auto_approve).toBe(false);
  });

  it('DEFAULT_CONFIG turns coverage.type_level on, with a self-contained comment explaining it does nothing until a type declares `when:`', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as { coverage: { type_level: boolean } };
    expect(parsed.coverage.type_level).toBe(true);
    expect(DEFAULT_CONFIG).toMatch(/Type-level coverage:/);
    expect(DEFAULT_CONFIG).toMatch(/Does\n\s*#\s*NOTHING until a type in yg-architecture\.yaml declares `when:`/);
  });
});

describe('DEFAULT_ARCHITECTURE', () => {
  it('ships with empty node_types and commented placeholder', () => {
    expect(DEFAULT_ARCHITECTURE).toMatch(/node_types: \{\}/);
    expect(DEFAULT_ARCHITECTURE).toMatch(/# Define your node types/);
    expect(DEFAULT_ARCHITECTURE).toMatch(/# Example/);
  });

  it('has no pre-defined types', () => {
    const parsed = parseYaml(DEFAULT_ARCHITECTURE) as Record<string, unknown>;
    const nodeTypes = parsed.node_types as Record<string, unknown>;
    expect(Object.keys(nodeTypes).length).toBe(0);
  });
});
