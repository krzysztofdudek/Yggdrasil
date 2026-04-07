import { describe, it, expect } from 'vitest';
import { formatFileContext } from '../../../src/formatters/context-file.js';

describe('formatFileContext', () => {
  it('formats file-level details as structured text', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      claims: [{
        aspectId: 'deterministic',
        aspectDescription: 'Same inputs produce identical outputs',
        verifiedAgainst: 'aspects/deterministic/content.md',
        source: 'required aspect for type \'library\'',
        claims: [
          'Functions do not use Date.now(), Math.random(), or filesystem writes',
          'Exported functions return values derived only from their arguments',
        ],
      }],
      dependencies: [
        { path: 'cli/core/context', consumed: ['buildContext()'] },
        { path: 'cli/model', consumed: ['Graph', 'ValidationIssue'] },
      ],
      dependentCount: 3,
    });

    expect(output).toContain('source/cli/src/core/validator.ts');
    expect(output).toContain('Owner: cli/core/validator (library)');
    expect(output).toContain('Claims to satisfy:');
    expect(output).toContain('deterministic — Same inputs produce identical outputs');
    expect(output).toContain('Verified against: aspects/deterministic/content.md');
    expect(output).toContain('Source: required aspect for type \'library\'');
    expect(output).toContain('Functions do not use Date.now()');
    expect(output).toContain('Dependencies consumed:');
    expect(output).toContain('cli/core/context — buildContext()');
    expect(output).toContain('Node context: run yg context --node cli/core/validator');
  });

  it('formats file with port-required claims under dependencies', () => {
    const output = formatFileContext({
      filePath: 'source/orders/service.ts',
      ownerPath: 'orders/order-service',
      ownerType: 'service',
      claims: [],
      dependencies: [{
        path: 'payments/payment-service',
        consumed: ['charge'],
        portClaims: [{
          aspectId: 'correlation-tracking',
          aspectDescription: 'Every call includes correlation ID',
          verifiedAgainst: 'aspects/correlation-tracking/content.md',
          claims: ['Every outgoing call includes a correlation ID from request context'],
        }],
      }],
      dependentCount: 0,
    });

    expect(output).toContain('payments/payment-service — charge');
    expect(output).toContain('Claims to satisfy:');
    expect(output).toContain('correlation-tracking');
    expect(output).toContain('Every outgoing call includes a correlation ID');
    expect(output).toContain('Verified against: aspects/correlation-tracking/content.md');
  });

  it('formats unmapped file with candidates', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/experimental/foo.ts',
      ownerPath: undefined,
      ownerType: undefined,
      claims: [],
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
      claims: [],
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
      claims: [],
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
      claims: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Dependents:');
  });

  it('omits claims section when empty', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      claims: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Claims to satisfy:');
  });

  it('omits dependencies section when empty', () => {
    const output = formatFileContext({
      filePath: 'source/cli/src/core/validator.ts',
      ownerPath: 'cli/core/validator',
      ownerType: 'library',
      claims: [],
      dependencies: [],
      dependentCount: 0,
    });

    expect(output).not.toContain('Dependencies consumed:');
  });
});
