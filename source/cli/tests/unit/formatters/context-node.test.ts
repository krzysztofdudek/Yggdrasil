import { describe, it, expect } from 'vitest';
import { formatNodeContext } from '../../../src/formatters/context-node.js';
import type { NodeContextData } from '../../../src/formatters/context-node.js';

function makeNodeData(overrides: Partial<NodeContextData> = {}): NodeContextData {
  return {
    path: 'cli/core/validator',
    name: 'Validator',
    type: 'library',
    description: 'Structural validation and completeness checks',
    sourceFiles: ['source/cli/src/core/validator.ts', 'source/cli/src/core/effective-aspects.ts'],
    aspects: [{
      id: 'deterministic',
      name: 'Determinism',
      description: 'Same inputs produce identical outputs',
      source: 'architecture (type: library)',
      verifiedAgainst: 'aspects/deterministic/content.md',
      claims: [
        'Functions do not use Date.now(), Math.random(), or filesystem writes',
        'Exported functions return values derived only from their arguments',
      ],
      implies: ['posix-paths'],
    }],
    flows: [{
      id: 'validate',
      name: 'Validate',
      description: 'Runs all structural and completeness checks',
      readPath: 'flows/validate/description.md',
    }],
    dependencies: [{
      path: 'cli/core/context',
      relation: 'calls',
      description: 'context assembly',
      readPath: 'model/cli/core/context/interface.md',
    }],
    dependentCount: 3,
    dependentPaths: ['cli/commands/check', 'cli/commands/approve', 'cli/commands/context'],
    parentPath: 'cli/core',
    parentType: 'module',
    parentReadPath: 'model/cli/core/responsibility.md',
    artifactPaths: [
      'model/cli/core/validator/responsibility.md',
      'model/cli/core/validator/interface.md',
    ],
    tokenBudget: { current: 3137, limit: 10000, status: 'ok' },
    ...overrides,
  };
}

describe('formatNodeContext', () => {
  it('formats node overview as structured text', () => {
    const output = formatNodeContext(makeNodeData());

    // Header
    expect(output).toContain('cli/core/validator — Structural validation and completeness checks (library)');
    // Source files
    expect(output).toContain('Source files (2):');
    expect(output).toContain('  source/cli/src/core/validator.ts');
    // Aspects with claims
    expect(output).toContain('Must satisfy (1 aspect, 2 claims):');
    expect(output).toContain('deterministic — Same inputs produce identical outputs');
    expect(output).toContain('Source: architecture (type: library)');
    expect(output).toContain('Verified against: aspects/deterministic/content.md');
    expect(output).toContain('Functions do not use Date.now()');
    expect(output).toContain('Implies: posix-paths');
    // Flows
    expect(output).toContain('Participates in (1 flow):');
    expect(output).toContain('validate — Runs all structural');
    expect(output).toContain('read: flows/validate/description.md');
    // Dependencies
    expect(output).toContain('Dependencies (1):');
    expect(output).toContain('cli/core/context (calls)');
    expect(output).toContain('read: model/cli/core/context/interface.md');
    // Dependents with consequence framing
    expect(output).toContain('Dependents (3):');
    // Parent
    expect(output).toContain('Parent: cli/core (module)');
    // Artifacts
    expect(output).toContain('read: model/cli/core/validator/responsibility.md');
    // Token budget
    expect(output).toContain('Token budget: 3,137 / 10,000 (ok)');
  });

  it('shows consequence framing for 6+ dependents', () => {
    const output = formatNodeContext(makeNodeData({ dependentCount: 8, dependentPaths: [] }));
    expect(output).toContain("Changes to this node's interface will trigger cascade review on 8 nodes");
    expect(output).toContain('Run: yg impact');
  });

  it('shows HIGH blast radius for 16+ dependents', () => {
    const output = formatNodeContext(makeNodeData({ dependentCount: 20, dependentPaths: [] }));
    expect(output).toContain('HIGH blast radius');
    expect(output).toContain('Strongly recommended: yg impact');
  });

  it('shows plain list for 1-5 dependents', () => {
    const output = formatNodeContext(makeNodeData({
      dependentCount: 3,
      dependentPaths: ['cli/commands/check', 'cli/commands/approve', 'cli/commands/context'],
    }));
    expect(output).toContain('cli/commands/check');
    expect(output).toContain('cli/commands/approve');
    expect(output).toContain('cli/commands/context');
  });

  it('handles node with no description', () => {
    const output = formatNodeContext(makeNodeData({ description: undefined }));
    expect(output).toContain('cli/core/validator (library)');
    expect(output).not.toContain('undefined');
  });

  it('handles node with no aspects', () => {
    const output = formatNodeContext(makeNodeData({ aspects: [] }));
    expect(output).not.toContain('Must satisfy');
  });

  it('handles node with no flows', () => {
    const output = formatNodeContext(makeNodeData({ flows: [] }));
    expect(output).not.toContain('Participates in');
  });

  it('handles node with no dependents', () => {
    const output = formatNodeContext(makeNodeData({ dependentCount: 0 }));
    expect(output).not.toContain('Dependents');
  });

  it('handles node with no parent', () => {
    const output = formatNodeContext(makeNodeData({ parentPath: undefined }));
    expect(output).not.toContain('Parent:');
  });
});
