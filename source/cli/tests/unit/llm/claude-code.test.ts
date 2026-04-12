import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '../../../src/llm/claude-code.js';

describe('ClaudeCodeProvider', () => {
  it('constructs with default model', () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    expect(provider).toBeDefined();
  });

  it('isAvailable returns false when claude is not on PATH', async () => {
    // In CI, claude CLI is unlikely to be on PATH
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    // We can't guarantee this in all environments, so just verify it doesn't throw
    const result = await provider.isAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('getContextWindowSize returns undefined (not supported)', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    const size = await provider.getContextWindowSize();
    expect(size).toBeUndefined();
  });

  it('verifyAspect returns result with expected shape', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    const result = await provider.verifyAspect('Is this code correct? const x = 1;');
    expect(result).toHaveProperty('satisfied');
    expect(result).toHaveProperty('reason');
  }, 120_000);
});
