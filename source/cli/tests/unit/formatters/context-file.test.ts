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
    expect(output).toContain('deterministic — Same inputs produce identical outputs');
    expect(output).toContain('read: .yggdrasil/aspects/deterministic/content.md');
    expect(output).toContain('Source: required aspect for type \'library\'');
    expect(output).toContain('Dependencies consumed:');
    expect(output).toContain('cli/core/context — buildContext()');
    expect(output).toContain('Node context: run yg context --node cli/core/validator');
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
});
