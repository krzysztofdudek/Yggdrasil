import { describe, it, expect } from 'vitest';
import type { ApproveResult } from '../../../src/model/types.js';
import { formatResult } from '../../../src/cli/approve.js';

function makeApproveResult(overrides: Partial<ApproveResult> = {}): ApproveResult {
  return {
    action: 'approved',
    currentHash: 'abcdef01',
    previousHash: '12345678',
    blackboxBlocked: false,
    antiLaunderingBlocked: false,
    acknowledgeAttempted: false,
    isBlackbox: false,
    ...overrides,
  };
}

function captureOutput(fn: () => void): string {
  const chunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return chunks.join('');
}

describe('formatResult — LLM results', () => {
  it('displays claim verification results in approve output', () => {
    const result = makeApproveResult({
      action: 'refused',
      refuseReason: 'LLM verification found issues',
      axes: { ownArtifacts: 'unchanged', source: 'unchanged', otherTracked: 'unchanged' },
      claimResults: {
        deterministic: {
          'no-side-effects': { satisfied: true, reason: 'ok' },
          'pure-transforms': { satisfied: false, reason: 'fs.readFileSync on line 89' },
        },
      },
      artifactReviewResults: {
        'responsibility.md': { current: false, reason: 'Missing new function' },
        'interface.md': { current: true, reason: 'up to date' },
      },
    });
    const output = captureOutput(() => formatResult('cli/core/validator', result));
    expect(output).toContain('SATISFIED');
    expect(output).toContain('NOT SATISFIED');
    expect(output).toContain('fs.readFileSync');
    expect(output).toContain('STALE');
    expect(output).toContain('Missing new function');
    expect(output).toContain('current');
  });

  it('shows LLM skipped notice when llmSkipped is true', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: true,
    });
    const output = captureOutput(() => formatResult('some/node', result));
    expect(output).toContain('LLM');
  });
});
