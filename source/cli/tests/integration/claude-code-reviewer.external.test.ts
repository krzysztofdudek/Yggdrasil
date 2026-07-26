import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '../../src/llm/claude-code.js';

/**
 * Live round-trip through the `claude` CLI agent (requires the binary on PATH and
 * a working session).
 *
 * This belongs in the external tier, alongside the Ollama round-trip, because it
 * depends on something outside the repository: a subprocess that reaches a vendor
 * over the network. It used to sit in the unit tier, where the gate ran it on every
 * commit — and a slow or throttled provider then failed the gate for reasons that
 * had nothing to do with the change under test. Worse, the failure was self-
 * inflicting: the more pairs a session verified through this same binary, the
 * likelier the following gate run failed.
 *
 * Nothing was lost by moving it. What the unit tier needs from this path is the
 * response SHAPE, and that is proven deterministically and without a network by
 * the parse-level tests — `parseAspectResponse` is exercised twenty-four times
 * across the base-provider, corpus and Ollama suites. What only a live call can
 * prove is that the subprocess wiring works end to end, which is an integration
 * question and is asked here, deliberately, by `npm run test:external`.
 */
describe('claude-code integration (requires the claude CLI on PATH)', () => {
  it('returns a verdict with the response shape from a real call', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });

    const prompt = `<task>
You verify whether source code satisfies a requirement.

Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation"}
</task>

<aspect id="no-var" description="No var declarations">
Source code must not use the var keyword. Use const or let instead.
</aspect>

<source-files>
<file path="example.ts">
const x = 1;
</file>
</source-files>`;

    const result = await provider.verifyAspect(prompt);
    expect(result).toHaveProperty('satisfied');
    expect(result).toHaveProperty('reason');
    expect(typeof result.satisfied).toBe('boolean');
  }, 120_000);
});
