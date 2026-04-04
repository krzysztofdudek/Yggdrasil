import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CheckResult } from '../../../src/core/check.js';
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
});
