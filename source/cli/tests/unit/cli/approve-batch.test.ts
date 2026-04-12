import { describe, it, expect } from 'vitest';
import { filterCascadeNodes } from '../../../src/cli/approve.js';
import type { CheckIssue } from '../../../src/core/check.js';

describe('filterCascadeNodes', () => {
  const makeCascadeDrift = (nodePath: string, causeFiles: string[]): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
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
      makeCascadeDrift('cli/commands/approve', ['.yggdrasil/aspects/deterministic/content.md']),
      makeCascadeDrift('cli/commands/check', ['.yggdrasil/aspects/deterministic/yg-aspect.yaml']),
      makeCascadeDrift('cli/commands/init', ['.yggdrasil/aspects/logging/content.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual(['cli/commands/approve', 'cli/commands/check']);
  });

  it('returns empty array when no upstream-drift issues match', () => {
    const issues: CheckIssue[] = [
      makeCascadeDrift('cli/commands/init', ['.yggdrasil/aspects/logging/content.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });

  it('ignores non-upstream-drift issues', () => {
    const issues: CheckIssue[] = [{
      severity: 'error',
      code: 'source-drift',
      rule: 'direct-drift',
      message: 'direct drift',
      nodePath: 'cli/commands/approve',
    }];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });

  it('matches flow cause prefix', () => {
    const issues: CheckIssue[] = [
      makeCascadeDrift('cli/commands/approve', ['.yggdrasil/flows/checkout/yg-flow.yaml']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/flows/checkout/');
    expect(result).toEqual(['cli/commands/approve']);
  });

  it('matches parent model cause prefix', () => {
    const issues: CheckIssue[] = [
      makeCascadeDrift('cli/commands/approve', ['.yggdrasil/model/cli/yg-node.yaml']),
      makeCascadeDrift('cli/core/check', ['.yggdrasil/model/cli/core/yg-node.yaml']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/model/cli/');
    expect(result).toEqual(['cli/commands/approve', 'cli/core/check']);
  });

  it('does not match when cause file is in a different aspect with shared prefix', () => {
    const issues: CheckIssue[] = [
      makeCascadeDrift('cli/commands/approve', ['.yggdrasil/aspects/deterministic-v2/content.md']),
    ];
    const result = filterCascadeNodes(issues, '.yggdrasil/aspects/deterministic/');
    expect(result).toEqual([]);
  });
});
