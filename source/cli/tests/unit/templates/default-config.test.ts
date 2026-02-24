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
    expect(parsed.knowledge_categories).toBeDefined();
    expect(parsed.quality).toBeDefined();
  });

  it('DEFAULT_CONFIG node_types includes module, service, library', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as { node_types: string[] };
    expect(parsed.node_types).toContain('module');
    expect(parsed.node_types).toContain('service');
    expect(parsed.node_types).toContain('library');
  });

  it('DEFAULT_CONFIG responsibility, interface, constraints, errors have structural_context', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      artifacts: Record<string, { structural_context?: boolean }>;
    };
    expect(parsed.artifacts['responsibility.md'].structural_context).toBe(true);
    expect(parsed.artifacts['interface.md'].structural_context).toBe(true);
    expect(parsed.artifacts['constraints.md'].structural_context).toBe(true);
    expect(parsed.artifacts['errors.md'].structural_context).toBe(true);
  });

  it('DEFAULT_CONFIG quality.context_budget has warning and error', () => {
    const parsed = parseYaml(DEFAULT_CONFIG) as {
      quality: { context_budget: { warning: number; error: number } };
    };
    expect(parsed.quality.context_budget.warning).toBe(10000);
    expect(parsed.quality.context_budget.error).toBe(20000);
  });
});
