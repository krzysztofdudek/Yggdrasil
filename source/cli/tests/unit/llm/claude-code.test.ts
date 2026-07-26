import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '../../../src/llm/claude-code.js';

/**
 * Unit tests for the claude-code provider — everything assertable without
 * reaching the network.
 *
 * The live round-trip lives in the external tier
 * (`tests/integration/claude-code-reviewer.external.test.ts`, run by
 * `npm run test:external`), which is where this repository already puts tests
 * depending on a real provider. It used to sit here, and the gate ran it on every
 * commit with a two-minute budget: a slow or throttled provider then failed the
 * gate for reasons unrelated to the change being committed, and self-inflictingly
 * so — the more pairs a session verified through that same binary, the likelier
 * the next gate run failed.
 *
 * Moving it cost no coverage. Its assertions were that the result carries
 * `satisfied` and `reason` — the response SHAPE — and the shape is proven
 * deterministically by the parse-level tests, which exercise
 * `parseAspectResponse` twenty-four times across the base-provider, corpus and
 * Ollama suites. A live call cannot prove the shape any better; what it uniquely
 * proves is that the subprocess wiring works, which is an integration question
 * and is now asked as one.
 */
describe('ClaudeCodeProvider', () => {
  it('constructs with a model', () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    expect(provider).toBeDefined();
  });

  it('isAvailable answers a boolean either way, never throwing', async () => {
    // Deliberately does not assert WHICH. The binary may or may not be on PATH in
    // a given environment, and asserting either way would make the test report
    // the environment rather than the code.
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    expect(typeof (await provider.isAvailable())).toBe('boolean');
  });

  it('spawns the claude binary', () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    expect((provider as unknown as { binary: string }).binary).toBe('claude');
  });
});
