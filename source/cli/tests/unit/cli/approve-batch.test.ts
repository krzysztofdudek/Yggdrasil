import { describe, it, expect } from 'vitest';
import { filterCascadeNodes } from '../../../src/cli/approve.js';
import type { CheckIssue } from '../../../src/core/check.js';

describe('filterCascadeNodes', () => {
  const makeE021 = (nodePath: string, causeFiles: string[]): CheckIssue => ({
    severity: 'error',
    code: 'E021',
    rule: 'cascade-drift',
    message: 'cascade',
    nodePath,
    cascadeCauses: causeFiles.map(f => ({
      file: f,
      layer: 'aspects' as const,
      description: `aspect changed (${f})`,
    })),
  });

  it('matches nodes whose cascade causes start with the prefix', () => {
    const issues: CheckIssue[] = [
      makeE021('cli/commands/approve', ['.yggdrasil/aspects/deterministic/rules.md']),
      makeE021('cli/commands/check', ['.yggdrasil/aspects/deterministic/yg-aspect.yaml']),
      makeE021('cli/commands/init', ['.yggdrasil/aspects/logging/rules.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual(['cli/commands/approve', 'cli/commands/check']);
  });

  it('returns empty array when no E021 issues match', () => {
    const issues: CheckIssue[] = [
      makeE021('cli/commands/init', ['.yggdrasil/aspects/logging/rules.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });

  it('ignores non-E021 issues', () => {
    const issues: CheckIssue[] = [{
      severity: 'error',
      code: 'E020',
      rule: 'direct-drift',
      message: 'direct drift',
      nodePath: 'cli/commands/approve',
    }];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });

  it('matches flow cause prefix', () => {
    const issues: CheckIssue[] = [
      makeE021('cli/commands/approve', ['.yggdrasil/flows/checkout/description.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/flows/checkout/');
    expect(result).toEqual(['cli/commands/approve']);
  });

  it('matches parent model cause prefix', () => {
    const issues: CheckIssue[] = [
      makeE021('cli/commands/approve', ['.yggdrasil/model/cli/responsibility.md']),
      makeE021('cli/core/check', ['.yggdrasil/model/cli/core/responsibility.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/model/cli/');
    expect(result).toEqual(['cli/commands/approve', 'cli/core/check']);
  });

  it('does not match when cause file is in a different aspect with shared prefix', () => {
    const issues: CheckIssue[] = [
      makeE021('cli/commands/approve', ['.yggdrasil/aspects/deterministic-v2/rules.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });
});
