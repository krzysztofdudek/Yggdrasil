import { describe, it, expect } from 'vitest';
import type { ApproveResult } from '../../../src/model/drift.js';
import { formatResult } from '../../../src/cli/approve.js';

function makeApproveResult(overrides: Partial<ApproveResult> = {}): ApproveResult {
  return {
    action: 'approved',
    currentHash: 'abcdef01',
    previousHash: '12345678',
    blackboxBlocked: false,
    antiLaunderingBlocked: false,
    reviewedAttempted: false,
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
  it('displays aspect verification results in approve output', () => {
    const result = makeApproveResult({
      action: 'refused',
      refuseReason: 'Reviewer verification found issues',
      axes: { ownArtifacts: 'unchanged', source: 'unchanged', otherTracked: 'unchanged' },
      aspectResults: {
        'deterministic': { satisfied: true, reason: 'ok' },
        'pure-transforms': { satisfied: false, reason: 'fs.readFileSync on line 89' },
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

  it('shows LLM skipped notice when not configured', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: 'not-configured',
    });
    const output = captureOutput(() => formatResult('some/node', result));
    expect(output).toContain('aspects not verified');
    expect(output).toContain('Structural checks only');
  });

  it('shows LLM unavailable notice', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: 'unavailable',
    });
    const output = captureOutput(() => formatResult('some/node', result));
    expect(output).toContain('aspects not verified');
  });

  it('shows LLM skipped for blackbox', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: 'blackbox',
    });
    const output = captureOutput(() => formatResult('some/node', result));
    expect(output).toContain('blackbox');
  });
});
