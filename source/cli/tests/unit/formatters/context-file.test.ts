import { describe, it, expect } from 'vitest';
import { formatFileContext } from '../../../src/formatters/context-file.js';

describe('formatFileContext', () => {
  it('formats file-level details as structured text', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'deterministic',
        aspectDescription: 'Same inputs produce identical outputs',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
        source: 'required aspect for type \'library\'',
      }],
      dependencies: [
        { path: 'cli/core/context', consumed: ['buildContext()'] },
        { path: 'cli/model', consumed: ['Graph', 'ValidationIssue'] },
      ],
      dependentCount: 3,
    });

    expect(output).toContain('source/cli/src/core/validator.ts');
    expect(output).toContain('Owner: cli/core/validator (library)');
    expect(output).toContain('Must satisfy:');
    expect(output).toContain('deterministic [enforced] — Same inputs produce identical outputs');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/content.md');
    expect(output).toContain('Source: required aspect for type \'library\'');
    expect(output).toContain('Dependencies consumed:');
    expect(output).toContain('cli/core/context — buildContext()');
    expect(output).toContain('next: yg context --node cli/core/validator');
  });

  it('formats unmapped file with candidates', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/experimental/foo.ts',
      ownerPath: undefined,
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
      candidates: [
        { nodePath: 'cli/core', mappingPrefix: 'source/cli/src/core/' },
        { nodePath: 'cli/commands', mappingPrefix: 'source/cli/src/commands/' },
      ],
    });

    expect(output).toContain('Owner: unmapped');
    expect(output).toContain('Candidate nodes');
    expect(output).toContain('cli/core');
  });

  it('formats unmapped file with no candidates', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/unknown/foo.ts',
      ownerPath: undefined,
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('Owner: unmapped');
    expect(output).not.toContain('Candidate nodes');
  });

  // A type-covered file (enforced by its architecture type alone, no owning
  // component) must lead with the SAME ownership vocabulary `yg owner --file`
  // already uses for the identical file ("-> type:X"), not the word
  // "unmapped" — which is the product's own word for genuinely NOT covered,
  // contradicted two lines later by "Matched type: X" on the very same file.
  it('leads with the matched type, not "unmapped", for a type-covered file', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/handlers/reviewCart.ts',
      ownerPath: undefined,
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
      typeCoverage: {
        typeId: 'handler',
        chainTerminationText: "inherited rules stop at 'handler' — it has no parent type to inherit from",
        applied: [],
        dropped: [],
      },
    });

    expect(output).toContain('Owner: type:handler');
    expect(output).not.toContain('Owner: unmapped');
    expect(output).toContain('Matched type: handler');
  });

  it('shows dependents count when > 0', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [],
      dependencies: [],
      dependentCount: 5,
    });

    expect(output).toContain('Dependents: 5 nodes');
    expect(output).toContain('yg impact --file');
  });

  it('omits dependents section when count is 0', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Dependents:');
  });

  it('omits aspects section when empty', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Must satisfy:');
  });

  it('falls back to "unknown" when ownerType is not set', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/foo.ts',
      ownerPath: 'cli/core/foo',
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
    });
    expect(output).toContain('Owner: cli/core/foo (unknown)');
  });

  it('omits source line when aspect.source is undefined', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/bar.ts',
      ownerPath: 'cli/core/bar',
      ownerType: 'library',
      aspects: [{
        aspectId: 'deterministic',
        aspectDescription: 'Same inputs produce identical outputs',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
      }],
      dependencies: [],
      dependentCount: 0,
    });
    expect(output).toContain('deterministic');
    expect(output).not.toContain('Source:');
  });

  it('lists a dependency entered through the default port with no dangling dash', () => {
    const output = formatFileContext({
      filePath: 'src/orders/order.ts',
      ownerPath: 'orders',
      ownerType: 'service',
      aspects: [],
      dependencies: [{ path: 'pay', consumed: ['default'] }],
      dependentCount: 0,
    });
    expect(output).toContain('Dependencies consumed:\n  pay\n');
    expect(output).not.toContain('pay — ');
  });

  it('omits dependencies section when empty', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Dependencies consumed:');
  });

  it('renders [enforced] tag and read lines for enforced aspect with references', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'deterministic',
        aspectDescription: 'Same inputs produce identical outputs',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
        status: 'enforced',
        references: [
          { path: '.yggdrasil/aspects/deterministic/refs/table.md', description: 'lookup table' },
        ],
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('deterministic [enforced] — Same inputs produce identical outputs');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/content.md');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/refs/table.md — lookup table');
    expect(output).not.toContain('(not checked; the rule is draft)');
  });

  it('renders [draft] tag with skip line and omits read lines for draft aspect', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'experimental-rule',
        aspectDescription: 'Not yet enforced',
        verifiedAgainst: '.yggdrasil/aspects/experimental-rule/content.md',
        status: 'draft',
        references: [
          { path: '.yggdrasil/aspects/experimental-rule/refs/notes.md' },
        ],
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('experimental-rule [draft] — Not yet enforced');
    expect(output).toContain('(not checked; the rule is draft)');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/content.md');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/refs/notes.md');
  });

  it('preserves declaration order when mixing statuses', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [
        {
          aspectId: 'aspect-enforced',
          aspectDescription: 'Enforced first',
          verifiedAgainst: '.yggdrasil/aspects/aspect-enforced/content.md',
          status: 'enforced',
        },
        {
          aspectId: 'aspect-draft',
          aspectDescription: 'Draft second',
          verifiedAgainst: '.yggdrasil/aspects/aspect-draft/content.md',
          status: 'draft',
        },
        {
          aspectId: 'aspect-advisory',
          aspectDescription: 'Advisory third',
          verifiedAgainst: '.yggdrasil/aspects/aspect-advisory/content.md',
          status: 'advisory',
        },
      ],
      dependencies: [],
      dependentCount: 0,
    });

    const enforcedIdx = output.indexOf('aspect-enforced [enforced]');
    const draftIdx = output.indexOf('aspect-draft [draft]');
    const advisoryIdx = output.indexOf('aspect-advisory [advisory]');
    expect(enforcedIdx).toBeGreaterThan(-1);
    expect(draftIdx).toBeGreaterThan(enforcedIdx);
    expect(advisoryIdx).toBeGreaterThan(draftIdx);
  });

  it('renders Source line for draft aspect when source is set', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'experimental-rule',
        aspectDescription: 'Not yet enforced',
        verifiedAgainst: '.yggdrasil/aspects/experimental-rule/content.md',
        status: 'draft',
        source: 'required aspect for type \'library\'',
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('experimental-rule [draft] — Not yet enforced');
    expect(output).toContain('(not checked; the rule is draft)');
    expect(output).toContain('Source: required aspect for type \'library\'');
    expect(output).not.toContain('read: .yggdrasil/aspects/experimental-rule/content.md');
  });

  it('defaults to [enforced] when status is undefined', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'deterministic',
        aspectDescription: 'Same inputs produce identical outputs',
        verifiedAgainst: '.yggdrasil/aspects/deterministic/content.md',
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('deterministic [enforced]');
  });

  it('renders companion read: line for LLM aspect with companionReadPath', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'my-llm-aspect',
        aspectDescription: 'Some LLM rule',
        verifiedAgainst: '.yggdrasil/aspects/my-llm-aspect/content.md',
        status: 'enforced',
        companionReadPath: '.yggdrasil/aspects/my-llm-aspect/companion.mjs',
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).toContain('read: .yggdrasil/aspects/my-llm-aspect/content.md');
    expect(output).toContain('read: .yggdrasil/aspects/my-llm-aspect/companion.mjs');
  });

  it('does NOT render companion read: line for aspect without companionReadPath', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'my-plain-llm-aspect',
        aspectDescription: 'Plain LLM rule',
        verifiedAgainst: '.yggdrasil/aspects/my-plain-llm-aspect/content.md',
        status: 'enforced',
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('companion.mjs');
  });

  it('does NOT render companion read: line for draft aspect (draft short-circuit)', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [{
        aspectId: 'my-draft-aspect',
        aspectDescription: 'Draft rule',
        verifiedAgainst: '.yggdrasil/aspects/my-draft-aspect/content.md',
        status: 'draft',
        companionReadPath: '.yggdrasil/aspects/my-draft-aspect/companion.mjs',
      }],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('companion.mjs');
    expect(output).toContain('(not checked; the rule is draft)');
  });

  it('gives a type-covered file its type decisions, indented under the type block', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/handlers/reviewCart.ts',
      ownerPath: undefined,
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
      typeCoverage: { typeId: 'handler', chainTerminationText: 'no parent type', applied: [], dropped: [] },
      logs: { typeDecisions: [{ typeId: 'handler', logPath: '.yggdrasil/types/handler/log.md', entries: [{ datetime: 'D1', body: 'Handlers never write the store.\n' }] }] },
    });

    expect(output).toContain("  Decisions in force for type 'handler' (.yggdrasil/types/handler/log.md):");
    expect(output.indexOf('Decisions in force')).toBeGreaterThan(output.indexOf('Matched type: handler'));
  });

  it('gives an owned file its node log before the back-pointer to the whole node context', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      aspects: [],
      dependencies: [],
      dependentCount: 0,
      logs: { typeDecisions: [], nodeLog: { nodePath: 'cli/core/validator', logPath: '.yggdrasil/model/cli/core/validator/log.md', entries: [{ datetime: 'D2', body: 'Why.\n' }], trimmed: false, omitted: 0 } },
    });

    expect(output).toContain('[D2]');
    expect(output.indexOf('[D2]')).toBeLessThan(output.indexOf('next: yg context --node cli/core/validator'));
  });

  it('lists the rules a type applies to a type-covered file, an unverified pair marked, and the ones it does not enforce there', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/handlers/reviewCart.ts',
      ownerPath: undefined,
      ownerType: undefined,
      aspects: [],
      dependencies: [],
      dependentCount: 0,
      typeCoverage: {
        typeId: 'handler',
        chainTerminationText: 'no parent type',
        applied: [
          { aspectId: 'no-store-writes', aspectDescription: 'Handlers never write the store', verifiedAgainst: '.yggdrasil/aspects/no-store-writes/content.md', unverified: true },
          { aspectId: 'named-export', aspectDescription: 'One named export', verifiedAgainst: '.yggdrasil/aspects/named-export/check.mjs', status: 'advisory' },
        ],
        dropped: [{ aspectId: 'has-tests', reasonText: 'its when: does not match this file' }],
      },
    });

    expect(output).toContain('  Must satisfy:');
    expect(output).toContain('    no-store-writes [enforced, unverified] — Handlers never write the store');
    expect(output).toContain('    named-export [advisory] — One named export');
    expect(output).toContain('  Attached to this type but not enforced here:');
    expect(output).toContain('    has-tests — its when: does not match this file');
    expect(output).not.toContain('No rules from this type apply');
  });
});
