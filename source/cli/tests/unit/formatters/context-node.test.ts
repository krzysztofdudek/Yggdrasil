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
    expect(output).toContain('deterministic [enforced] — Same inputs produce identical outputs');
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
    // Workflow footer — lock vocabulary, never the retired `yg approve`.
    expect(output).toContain('After modifying source files in this node: run yg check, then yg check --approve');
    expect(output).not.toContain('yg approve');
  });

  it('surfaces a reviewed-seam direct-relation ceiling override with its justification', () => {
    const output = formatNodeContext(makeNodeData({
      maxDirectRelations: { limit: 21, reason: 'Single auditable gateway; splitting defeats the seam.' },
    }));
    expect(output).toContain('Direct-relation ceiling: 21 (reviewed-seam override; the global default applies to every other node)');
    expect(output).toContain('Justification: Single auditable gateway; splitting defeats the seam.');
  });

  it('omits the direct-relation ceiling line when no override is declared', () => {
    const output = formatNodeContext(makeNodeData());
    expect(output).not.toContain('Direct-relation ceiling:');
  });

  it('renders per-aspect subject counts (N files / vacuous / per-file units)', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [
        {
          id: 'per-node-rule',
          name: 'Per node',
          description: 'Whole-node rule',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/per-node-rule/content.md',
        },
        {
          id: 'vacuous-rule',
          name: 'Vacuous',
          description: 'Excludes every file here',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/vacuous-rule/content.md',
        },
        {
          id: 'per-file-rule',
          name: 'Per file',
          description: 'File-local rule',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/per-file-rule/content.md',
        },
      ],
      aspectSubjects: {
        'per-node-rule': { count: 3, perFile: false },
        'vacuous-rule': { count: 0, perFile: false },
        'per-file-rule': { count: 2, perFile: true },
      },
    }));

    expect(output).toContain('Subjects: 3 files');
    expect(output).toContain('Subjects: 0 files — vacuous');
    expect(output).toContain('Subjects: 2 units (per-file)');
  });

  it('uses singular file/unit wording for a count of 1', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [
        {
          id: 'one-file',
          name: 'One file',
          description: 'x',
          source: 'own',
          verifiedAgainst: '.yggdrasil/aspects/one-file/content.md',
        },
        {
          id: 'one-unit',
          name: 'One unit',
          description: 'y',
          source: 'own',
          verifiedAgainst: '.yggdrasil/aspects/one-unit/content.md',
        },
      ],
      aspectSubjects: {
        'one-file': { count: 1, perFile: false },
        'one-unit': { count: 1, perFile: true },
      },
    }));
    expect(output).toContain('Subjects: 1 file');
    expect(output).not.toContain('Subjects: 1 files');
    expect(output).toContain('Subjects: 1 unit (per-file)');
  });

  it('renders the log-state line when logState is present', () => {
    const requiredFresh = formatNodeContext(makeNodeData({
      logState: { required: true, freshPresent: true },
    }));
    expect(requiredFresh).toContain('log entry required before --approve: yes; fresh entry present: yes');

    const notRequired = formatNodeContext(makeNodeData({
      logState: { required: false, freshPresent: false },
    }));
    expect(notRequired).toContain('log entry required before --approve: no; fresh entry present: no');
  });

  it('omits the log-state line when logState is absent', () => {
    const output = formatNodeContext(makeNodeData({ logState: undefined }));
    expect(output).not.toContain('log entry required before --approve');
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

  it('renders [enforced] tag and read lines for enforced aspect with references', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'deterministic',
        name: 'Determinism',
        description: 'Same inputs produce identical outputs',
        source: 'architecture (type: library)',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
        status: 'enforced',
        references: [
          { path: '.yggdrasil/aspects/deterministic/refs/table.md', description: 'lookup table' },
        ],
      }],
    }));

    expect(output).toContain('deterministic [enforced] — Same inputs produce identical outputs');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/content.md');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/refs/table.md — lookup table');
    expect(output).not.toContain('(reviewer skipped');
  });

  it('renders [draft] tag with skip line and omits read lines for draft aspect', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'experimental-rule',
        name: 'Experimental',
        description: 'Not yet enforced',
        source: 'own declaration',
        verifiedAgainst: '.yggdrasil/aspects/experimental-rule/content.md',
        status: 'draft',
        references: [
          { path: '.yggdrasil/aspects/experimental-rule/refs/notes.md' },
        ],
      }],
    }));

    expect(output).toContain('experimental-rule [draft] — Not yet enforced');
    expect(output).toContain('(reviewer skipped; aspect is draft)');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/content.md');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/refs/notes.md');
  });

  it('preserves declaration order when mixing statuses', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [
        {
          id: 'aspect-enforced',
          name: 'Enforced',
          description: 'Enforced first',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/aspect-enforced/content.md',
          status: 'enforced',
        },
        {
          id: 'aspect-draft',
          name: 'Draft',
          description: 'Draft second',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/aspect-draft/content.md',
          status: 'draft',
        },
        {
          id: 'aspect-advisory',
          name: 'Advisory',
          description: 'Advisory third',
          source: 'own declaration',
          verifiedAgainst: '.yggdrasil/aspects/aspect-advisory/content.md',
          status: 'advisory',
        },
      ],
    }));

    const enforcedIdx = output.indexOf('aspect-enforced [enforced]');
    const draftIdx = output.indexOf('aspect-draft [draft]');
    const advisoryIdx = output.indexOf('aspect-advisory [advisory]');
    expect(enforcedIdx).toBeGreaterThan(-1);
    expect(draftIdx).toBeGreaterThan(enforcedIdx);
    expect(advisoryIdx).toBeGreaterThan(draftIdx);
  });

  it('renders Implies line for draft aspect when implies are set', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'experimental-rule',
        name: 'Experimental',
        description: 'Not yet enforced',
        source: 'own declaration',
        verifiedAgainst: '.yggdrasil/aspects/experimental-rule/content.md',
        status: 'draft',
        implies: ['posix-paths'],
      }],
    }));

    expect(output).toContain('experimental-rule [draft] — Not yet enforced');
    expect(output).toContain('(reviewer skipped; aspect is draft)');
    expect(output).toContain('Implies: posix-paths');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/content.md');
  });

  it('renders reference without description for enforced aspect', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'deterministic',
        name: 'Determinism',
        description: 'Same inputs produce identical outputs',
        source: 'architecture (type: library)',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
        status: 'enforced',
        references: [
          { path: '.yggdrasil/aspects/deterministic/refs/table.md' },
        ],
      }],
    }));

    expect(output).toContain('read: .yggdrasil/aspects/deterministic/refs/table.md');
    // No em-dash trailing description
    expect(output).not.toContain('refs/table.md —');
  });

  it('defaults to [enforced] when status is undefined', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'deterministic',
        name: 'Determinism',
        description: 'Same inputs produce identical outputs',
        source: 'architecture (type: library)',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
      }],
    }));

    expect(output).toContain('deterministic [enforced]');
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

  it('renders companion read: line for LLM aspect with companionReadPath', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'my-llm-aspect',
        name: 'My LLM Aspect',
        description: 'Some LLM rule',
        source: 'own declaration',
        verifiedAgainst: '.yggdrasil/aspects/my-llm-aspect/content.md',
        status: 'enforced',
        companionReadPath: '.yggdrasil/aspects/my-llm-aspect/companion.mjs',
      }],
    }));

    expect(output).toContain('read: .yggdrasil/aspects/my-llm-aspect/content.md');
    expect(output).toContain('read: .yggdrasil/aspects/my-llm-aspect/companion.mjs');
  });

  it('does NOT render companion read: line for aspect without companionReadPath', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'my-plain-llm-aspect',
        name: 'My Plain LLM Aspect',
        description: 'Plain LLM rule',
        source: 'own declaration',
        verifiedAgainst: '.yggdrasil/aspects/my-plain-llm-aspect/content.md',
        status: 'enforced',
      }],
    }));

    expect(output).not.toContain('companion.mjs');
  });

  it('does NOT render companion read: line for draft aspect (draft short-circuit)', () => {
    const output = formatNodeContext(makeNodeData({
      aspects: [{
        id: 'my-draft-aspect',
        name: 'My Draft Aspect',
        description: 'Draft rule',
        source: 'own declaration',
        verifiedAgainst: '.yggdrasil/aspects/my-draft-aspect/content.md',
        status: 'draft',
        companionReadPath: '.yggdrasil/aspects/my-draft-aspect/companion.mjs',
      }],
    }));

    expect(output).not.toContain('companion.mjs');
    expect(output).toContain('(reviewer skipped; aspect is draft)');
  });
});
