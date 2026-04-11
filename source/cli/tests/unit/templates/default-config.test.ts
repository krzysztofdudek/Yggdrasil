import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../../../src/templates/default-config.js';

describe('default-config', () => {
  it('DEFAULT_CONFIG is valid YAML', () => {
    const parsed = parseYaml(DEFAULT_CONFIG);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('DEFAULT_CONFIG contains required keys', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.name).toBeDefined();
    expect(parsed.node_types).toBeDefined();
    expect(parsed.artifacts).toBeUndefined();
    expect(parsed.quality).toBeDefined();
  });

  it('DEFAULT_CONFIG contains version field equal to 4.0.0', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.version).toBe('4.0.0');
  });

  it('DEFAULT_CONFIG node_types includes module, service, library', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      node_types: Record<string, { description: string }>;
    };
    const names = Object.keys(parsed.node_types);
    expect(names).toContain('module');
    expect(names).toContain('service');
    expect(names).toContain('library');
  });

  it('DEFAULT_CONFIG does not contain artifacts section', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.artifacts).toBeUndefined();
  });

  it('DEFAULT_CONFIG node_types includes infrastructure', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      node_types: Record<string, { description: string }>;
    };
    const names = Object.keys(parsed.node_types);
    expect(names).toContain('infrastructure');
  });

  it('DEFAULT_CONFIG quality.max_direct_relations is 10', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      quality: { max_direct_relations: number };
    };
    expect(parsed.quality.max_direct_relations).toBe(10);
  });
});
