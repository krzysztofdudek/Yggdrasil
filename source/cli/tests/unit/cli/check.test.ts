import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    ...overrides,
  };
}

function makeError(code: string, message: string): CheckIssue {
  return {
    severity: 'error',
    code,
    rule: code,
    message,
    nodePath: 'some/node',
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
  let output: string;

  beforeEach(() => {
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
      output += String(data);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('check output does not include health score', () => {
    formatOutput(makeCheckResult({ issues: [] }));
    expect(output).not.toContain('Health:');
  });

  it('displays full W001 message including breakdown', () => {
    formatOutput(makeCheckResult({
      issues: [makeWarning('W001', 'Context is 18,000 tokens...\n     own: 2,100 | hierarchy: 3,200 | ...')],
    }));
    expect(output).toContain('own: 2,100');
  });

  it('hides warnings when errors exist, shows count in result line', () => {
    formatOutput(makeCheckResult({
      issues: [makeError('E020', 'drift'), makeWarning('W001', 'budget')],
    }));
    expect(output).not.toContain('Warnings (');
    expect(output).toContain('1 warning');
  });

  it('shows full warnings when no errors', () => {
    formatOutput(makeCheckResult({
      issues: [makeWarning('W001', 'budget warning message')],
    }));
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('budget warning message');
  });
});
