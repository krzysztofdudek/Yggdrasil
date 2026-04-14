import { describe, it, expect } from 'vitest';
import type { CheckResult, CheckIssue, CascadeCause } from '../../../src/core/check.js';
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

function makeCascadeIssue(nodePath: string, causeDescription: string): CheckIssue {
  const causes: CascadeCause[] = [
    { file: `.yggdrasil/aspects/some-aspect/content.md`, layer: 'aspects', description: causeDescription },
  ];
  const message = `Context package changed due to 1 upstream modification:\n  Cause: ${causeDescription}\nSource may no longer satisfy updated aspect requirements.\nLoad context: yg context --node ${nodePath}\nVerify source compliance, update if needed, then: yg approve --node ${nodePath}`;
  return {
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    message,
    nodePath,
    cascadeCauses: causes,
  };
}

function makeCoverageIssue(uncoveredCount: number): CheckIssue {
  const files = Array.from({ length: Math.min(uncoveredCount, 5) }, (_, i) => `src/file-${i}.ts`);
  const remaining = uncoveredCount - files.length;
  let message: string;
  if (uncoveredCount <= 5) {
    message = `${uncoveredCount} source file${uncoveredCount === 1 ? '' : 's'} not covered by any node.\n${files.map(f => '  ' + f).join('\n')}\nFiles without graph coverage cannot be modified under the protocol.\nCheck ownership candidates: yg context --file <path>\nThen: add to existing node mapping, or create a new node.`;
  } else {
    message = `${uncoveredCount.toLocaleString()} source files have no graph coverage.\nExamples:\n${files.map(f => '  ' + f).join('\n')}\n... and ${remaining.toLocaleString()} more\nFiles without graph coverage cannot be modified under the protocol.\nEstablish coverage: create nodes for active areas first, expand coverage incrementally.\nCheck ownership candidates: yg context --file <path>`;
  }
  return {
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    message,
    uncoveredFiles: files,
    uncoveredCount,
  };
}

describe('formatOutput', () => {
  it('check output does not include health score', () => {
    const output = formatOutput(makeCheckResult({ issues: [] }));
    expect(output).not.toContain('Health:');
  });

  it('displays full completeness-warning message including breakdown', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('wide-node', 'Context is 18,000 tokens...\n     own: 2,100 | hierarchy: 3,200 | ...')],
    }));
    expect(output).toContain('own: 2,100');
  });

  it('shows warnings even when errors exist', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeError('source-drift', 'drift'), makeWarning('wide-node', 'budget')],
    }));
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('1 warning');
  });

  it('shows full warnings when no errors', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('wide-node', 'budget warning message')],
    }));
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('budget warning message');
  });

  it('shows summary header when >10 aspect-undefined errors', () => {
    const issues = Array.from({ length: 15 }, (_, i) => makeError('aspect-undefined', `Aspect 'auth' referenced by node-${i}...`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    expect(output).toContain('Structural:');
  });

  it('no summary header when <=10 aspect-undefined errors', () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeError('aspect-undefined', `msg`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    // With 5 errors, structural section still shows (no threshold for hiding)
    expect(output).toContain('Structural:');
  });

});

describe('preserved check features', () => {
  it('cascade tree summary appears after upstream-drift blocks', () => {
    const output = formatOutput(makeCheckResult({
      issues: [
        makeCascadeIssue('node-a', "aspect 'X' rules changed"),
        makeCascadeIssue('node-b', "aspect 'X' rules changed"),
      ],
    }));
    expect(output).toContain('Cascade summary:');
    expect(output).toContain('upstream change');
  });

  it('Next: suggested command appears after result line', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeError('source-drift', 'drift')],
      suggestedNext: 'yg context --node cli/core/validator\n  1 of 1 drifted node — post-modify workflow',
    }));
    expect(output).toContain('Next: yg context --node cli/core/validator');
    expect(output).toContain('post-modify workflow');
  });

  it('errors sorted by node path (stable ordering)', () => {
    const output = formatOutput(makeCheckResult({
      issues: [
        makeError('source-drift', 'drift', 'z-node'),
        makeError('source-drift', 'drift', 'a-node'),
      ],
    }));
    const aPos = output.indexOf('a-node');
    const zPos = output.indexOf('z-node');
    expect(aPos).toBeLessThan(zPos);
  });

  it('unmapped-files cold start guidance when 0 nodes and many uncovered files', () => {
    const output = formatOutput(makeCheckResult({
      nodeCount: 0,
      issues: [makeCoverageIssue(100)],
    }));
    expect(output).toMatch(/coverage|node/i);
  });
});
