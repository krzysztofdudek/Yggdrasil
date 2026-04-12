import { describe, it, expect } from 'vitest';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';

describe('buildIssueMessage', () => {
  it('joins what/why/next with single newlines', () => {
    const result = buildIssueMessage({
      what: 'Source files changed since last approve.',
      why: 'Graph metadata may no longer describe the actual behavior.',
      next: 'Review changes, then: yg approve --node cli/core',
    });
    expect(result).toBe(
      'Source files changed since last approve.\n' +
      'Graph metadata may no longer describe the actual behavior.\n' +
      'Review changes, then: yg approve --node cli/core',
    );
  });

  it('preserves internal newlines within sections', () => {
    const result = buildIssueMessage({
      what: 'Context package changed due to 2 upstream modifications.\nCause: aspect X changed',
      why: 'Source may no longer satisfy updated claims.',
      next: 'Load context: yg context --node cli/core\nVerify compliance, then approve.',
    });
    expect(result).toContain('Cause: aspect X changed\nSource may no longer');
  });
});
