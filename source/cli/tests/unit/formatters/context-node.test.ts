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
      verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
      implies: ['posix-paths'],
    }],
    flows: [{
      id: 'validate',
      name: 'Validate',
      description: 'Runs all structural and completeness checks',
      readPath: 'flows/validate/yg-flow.yaml',
    }],
    dependencies: [{
      path: 'cli/core/context',
      relation: 'calls',
      description: 'context assembly',
      readPath: 'model/cli/core/context/yg-node.yaml',
    }],
    dependentCount: 3,
    dependentPaths: ['cli/commands/check', 'cli/commands/approve', 'cli/commands/context'],
    parentPath: 'cli/core',
    parentType: 'module',
    parentReadPath: 'model/cli/core/yg-node.yaml',
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
    expect(output).toContain('Must satisfy (1 aspect):');
    expect(output).toContain('deterministic — Same inputs produce identical outputs');
    expect(output).toContain('Source: architecture (type: library)');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/content.md');
    expect(output).toContain('Implies: posix-paths');
    // Flows
    expect(output).toContain('Participates in (1 flow):');
    expect(output).toContain('validate — Runs all structural');
    expect(output).toContain('read: flows/validate/yg-flow.yaml');
    // Dependencies
    expect(output).toContain('Dependencies (1):');
    expect(output).toContain('cli/core/context (calls)');
    expect(output).toContain('read: model/cli/core/context/yg-node.yaml');
    // Dependents with consequence framing
    expect(output).toContain('Dependents (3):');
    // Parent
    expect(output).toContain('Parent: cli/core (module)');
    // Workflow footer
    expect(output).toContain('After modifying source files');
  });

  it('shows consequence framing for 6+ dependents', () => {
    const output = formatNodeContext(makeNodeData({ dependentCount: 8, dependentPaths: [] }));
    expect(output).toContain("Moderate blast radius — changes trigger cascade review on 8 nodes");
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

  it('shows portAspects required for dependency with port aspects', () => {
    const output = formatNodeContext(makeNodeData({
      dependencies: [{
        path: 'payments/payment-service',
        relation: 'uses',
        consumes: ['charge'],
        portAspects: [{ aspectId: 'idempotency', verifiedAgainst: '.yggdrasil/aspects/idempotency/content.md' }],
      }],
    }));
    expect(output).toContain('Required: idempotency');
  });

  it('shows dependency with description and consumes', () => {
    const output = formatNodeContext(makeNodeData({
      dependencies: [{
        path: 'auth/auth-api',
        relation: 'uses',
        description: 'Authentication provider',
        consumes: ['authenticate', 'verify'],
      }],
    }));
    expect(output).toContain('auth/auth-api (uses) — Authentication provider — consumes: authenticate, verify');
  });

  it('shows dependency without description or readPath', () => {
    const output = formatNodeContext(makeNodeData({
      dependencies: [{
        path: 'utils/logger',
        relation: 'uses',
      }],
    }));
    expect(output).toContain('utils/logger (uses)');
    expect(output).not.toContain('undefined');
  });

  it('handles dependentCount 1-5 with no dependentPaths (undefined)', () => {
    const output = formatNodeContext(makeNodeData({
      dependentCount: 2,
      dependentPaths: undefined,
    }));
    expect(output).toContain('Dependents (2):');
    expect(output).toContain('Run: yg impact');
  });

  it('uses singular for 1 aspect', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'deterministic',
        name: 'Determinism',
        description: 'Same inputs produce identical outputs',
        source: 'architecture',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
      }],
    }));
    expect(output).toContain('Must satisfy (1 aspect):');
  });

  it('uses singular for 1 flow', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [],
      flows: [{
        id: 'validate',
        name: 'Validate',
        description: 'Runs all structural and completeness checks',
        readPath: 'flows/validate/yg-flow.yaml',
      }],
    }));
    expect(output).toContain('Participates in (1 flow):');
  });

  it('shows parent with no parentType or parentReadPath', () => {
    const output = formatNodeContext(makeNodeData({
      parentPath: 'cli',
      parentType: undefined,
      parentReadPath: undefined,
    }));
    expect(output).toContain('Parent: cli (module)');
    // No read line directly after Parent: line
    const lines = output.split('\n');
    const parentLineIdx = lines.findIndex(l => l.startsWith('Parent:'));
    expect(parentLineIdx).toBeGreaterThan(-1);
    expect(lines[parentLineIdx + 1]).not.toContain('read: model/cli/');
  });

  it('uses plural form for 2+ aspects (line 61 plural branch)', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [
        {
          id: 'aspect-a',
          name: 'Aspect A',
          description: 'First aspect',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/aspect-a/content.md',
        },
        {
          id: 'aspect-b',
          name: 'Aspect B',
          description: 'Second aspect',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/aspect-b/content.md',
        },
      ],
    }));
    // Should say "2 aspects" (plural)
    expect(output).toContain('Must satisfy (2 aspects):');
  });

  it('uses plural form for 2+ flows (line 76 plural branch)', () => {
    const output = formatNodeContext(makeNodeData({
      flows: [
        {
          id: 'flow-a',
          name: 'Flow A',
          description: 'First flow',
          readPath: 'flows/flow-a/yg-flow.yaml',
        },
        {
          id: 'flow-b',
          name: 'Flow B',
          description: 'Second flow',
          readPath: 'flows/flow-b/yg-flow.yaml',
        },
      ],
    }));
    // Should say "2 flows" (plural)
    expect(output).toContain('Participates in (2 flows):');
  });
});
