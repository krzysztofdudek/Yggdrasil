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
    expect(parsed.artifacts).toBeDefined();
    expect(parsed.quality).toBeDefined();
  });

  it('DEFAULT_CONFIG contains version field equal to 2.0.0', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as Record<string, unknown>;
    expect(parsed.version).toBe('2.0.0');
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

  it('DEFAULT_CONFIG responsibility and interface have included_in_relations, internals does not', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      artifacts: Record<string, { included_in_relations?: boolean }>;
    };
    expect(parsed.artifacts['responsibility.md'].included_in_relations).toBe(true);
    expect(parsed.artifacts['interface.md'].included_in_relations).toBe(true);
    expect(parsed.artifacts['internals.md'].included_in_relations).toBeUndefined();
  });

  it('DEFAULT_CONFIG node_types includes infrastructure', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      node_types: Record<string, { description: string }>;
    };
    const names = Object.keys(parsed.node_types);
    expect(names).toContain('infrastructure');
  });

  it('DEFAULT_CONFIG quality.context_budget has warning and error', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      quality: { context_budget: { warning: number; error: number } };
    };
    expect(parsed.quality.context_budget.warning).toBe(10000);
    expect(parsed.quality.context_budget.error).toBe(20000);
  });
});
