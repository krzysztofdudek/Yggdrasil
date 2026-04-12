import { describe, it, expect, vi } from 'vitest';
import { verifyAspects, chunkSourceFiles, buildPrompt } from '../../../src/llm/aspect-verifier.js';
import type { LlmProvider } from '../../../src/llm/types.js';

function mockProvider(responses: Array<{ satisfied: boolean; reason: string }>): LlmProvider {
  let callIndex = 0;
  return {
    verifyAspect: vi.fn(async () => responses[callIndex++] ?? { satisfied: true, reason: 'ok' }),
    isAvailable: vi.fn(async () => true),
    getContextWindowSize: vi.fn(async () => 8192),
  };
}

describe('buildPrompt', () => {
  it('produces self-contained prompt with all content inline', () => {
    const prompt = buildPrompt(
      { id: 'posix-paths', description: 'POSIX path handling', content: 'Use forward slashes' },
      'Loads graph files',
      'cli/core/loader',
      [{ path: 'src/loader.ts', content: 'const x = 1;' }],
    );
    expect(prompt).toContain('<task>');
    expect(prompt).toContain('posix-paths');
    expect(prompt).toContain('POSIX path handling');
    expect(prompt).toContain('Use forward slashes');
    expect(prompt).toContain('Loads graph files');
    expect(prompt).toContain('cli/core/loader');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('{"satisfied": true|false');
  });
});

describe('chunkSourceFiles', () => {
  it('returns single chunk for small files', () => {
    const files = [{ path: 'a.ts', content: 'x' }];
    const chunks = chunkSourceFiles(files, 8192);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it('splits into multiple chunks when exceeding budget', () => {
    const bigContent = 'x'.repeat(10000);
    const files = [
      { path: 'a.ts', content: bigContent },
      { path: 'b.ts', content: bigContent },
    ];
    const chunks = chunkSourceFiles(files, 2000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('truncates single oversized file', () => {
    const files = [{ path: 'huge.ts', content: 'x'.repeat(100000) }];
    const chunks = chunkSourceFiles(files, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0].content).toContain('[... truncated]');
  });

  it('returns empty array wrapper for empty input', () => {
    const chunks = chunkSourceFiles([], 8192);
    expect(chunks).toEqual([[]]);
  });

  it('clamps min token budget to 1000', () => {
    const files = [{ path: 'a.ts', content: 'short' }];
    const chunks = chunkSourceFiles(files, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0].content).toBe('short');
  });
});

describe('verifyAspects', () => {
  it('returns satisfied for passing aspect', async () => {
    const provider = mockProvider([{ satisfied: true, reason: 'ok' }]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test aspect', content: 'Must do X' }],
      sourceFiles: [{ path: 'test.ts', content: 'export function x() {}' }],
      nodeDescription: 'Test node',
      nodePath: 'test/node',
    });
    expect(results['test']).toEqual({ satisfied: true, reason: expect.stringContaining('satisfied') });
  });

  it('returns not satisfied for failing aspect', async () => {
    const provider = mockProvider([{ satisfied: false, reason: 'Missing X' }]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'Must do X' }],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
      nodeDescription: 'Test node',
      nodePath: 'test/node',
    });
    expect(results['test']).toEqual({ satisfied: false, reason: 'Missing X' });
  });

  it('skips verification for empty source files', async () => {
    const provider = mockProvider([]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'content' }],
      sourceFiles: [],
      nodeDescription: 'Test node',
      nodePath: 'test/node',
    });
    expect(results['test'].satisfied).toBe(true);
    expect(provider.verifyAspect).not.toHaveBeenCalled();
  });

  it('fail-fast: stops on first failing chunk', async () => {
    const provider = mockProvider([
      { satisfied: false, reason: 'chunk 1 fails' },
    ]);
    const bigContent = 'x'.repeat(10000);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'content' }],
      sourceFiles: [
        { path: 'a.ts', content: bigContent },
        { path: 'b.ts', content: bigContent },
      ],
      nodeDescription: 'Test node',
      nodePath: 'test/node',
      maxTokens: 2000,
    });
    expect(results['test'].satisfied).toBe(false);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(1);
  });

  it('consensus majority-pass returns satisfied', async () => {
    const provider = mockProvider([
      { satisfied: true, reason: 'yes' },
      { satisfied: true, reason: 'yes' },
      { satisfied: false, reason: 'no' },
    ]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'content' }],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
      nodeDescription: 'Test',
      nodePath: 'test/node',
      consensus: 3,
    });
    expect(results['test'].satisfied).toBe(true);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(3);
  });

  it('consensus majority-fail returns not satisfied', async () => {
    const provider = mockProvider([
      { satisfied: false, reason: 'no1' },
      { satisfied: true, reason: 'yes' },
      { satisfied: false, reason: 'no2' },
    ]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'content' }],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
      nodeDescription: 'Test',
      nodePath: 'test/node',
      consensus: 3,
    });
    expect(results['test'].satisfied).toBe(false);
  });

  it('default consensus=1 calls provider once', async () => {
    const provider = mockProvider([{ satisfied: true, reason: 'ok' }]);
    await verifyAspects({
      provider,
      aspects: [{ id: 'test', description: 'Test', content: 'content' }],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
      nodeDescription: 'Test',
      nodePath: 'test/node',
    });
    expect(provider.verifyAspect).toHaveBeenCalledTimes(1);
  });
});
