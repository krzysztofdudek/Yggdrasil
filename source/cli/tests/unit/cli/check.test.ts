import { describe, it, expect } from 'vitest';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import { formatOutput } from '../../../src/cli/check.js';

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'Test',
    nodeCount: 0,
    nodeTypeCounts: new Map(),
    aspectCount: 0,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues: [],
    suggestedNext: null,
    llmAvailable: true,
    ...overrides,
  };
}

function makeError(code: string, message: string, nodePath?: string): CheckIssue {
  return {
    severity: 'error',
    code,
    rule: code,
    message,
    nodePath: nodePath ?? 'some/node',
  };
}

function makeWarning(code: string, message: string): CheckIssue {
  return {
    severity: 'warning',
    code,
    rule: code,
    message,
    nodePath: 'some/node',
  };
}

describe('formatOutput', () => {
  it('check output does not include health score', () => {
    const output = formatOutput(makeCheckResult({ issues: [] }));
    expect(output).not.toContain('Health:');
  });

  it('displays full W001 message including breakdown', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('W001', 'Context is 18,000 tokens...\n     own: 2,100 | hierarchy: 3,200 | ...')],
    }));
    expect(output).toContain('own: 2,100');
  });

  it('hides warnings when errors exist, shows count in result line', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeError('E020', 'drift'), makeWarning('W001', 'budget')],
    }));
    expect(output).not.toContain('Warnings (');
    expect(output).toContain('1 warning');
  });

  it('shows full warnings when no errors', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('W001', 'budget warning message')],
    }));
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('budget warning message');
  });

  it('shows summary header when >10 E050 errors', () => {
    const issues = Array.from({ length: 15 }, (_, i) => makeError('E050', `Aspect 'auth' referenced by node-${i}...`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    expect(output).toContain('Architecture (15 errors)');
  });

  it('no summary header when <=10 E050 errors', () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeError('E050', `msg`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    expect(output).not.toContain('Architecture (5 errors)');
  });

  it('shows LLM notice when no provider configured', () => {
    const output = formatOutput(makeCheckResult({ llmAvailable: false }));
    expect(output).toContain('Claim verification disabled');
  });

  it('does not show LLM notice when provider is available', () => {
    const output = formatOutput(makeCheckResult({ llmAvailable: true }));
    expect(output).not.toContain('Claim verification disabled');
  });
});
