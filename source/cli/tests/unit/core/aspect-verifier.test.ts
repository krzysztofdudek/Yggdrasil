import { describe, it, expect, vi } from 'vitest';
import { buildPrompt, verifyWithConsensus, consensusTally } from '../../../src/llm/aspect-verifier.js';
import type { LlmProvider, AspectResponse } from '../../../src/llm/types.js';

describe('buildPrompt', () => {
  it('includes the unified yg-suppress instruction in the task block', () => {
    const prompt = buildPrompt(
      { id: 'test-aspect', description: 'Test', content: 'Must do X' },
      'Test node',
      'test/node',
      [{ path: 'test.ts', content: 'code' }],
    );
    // The instruction now points at pre-resolved <suppressed-ranges> spans and
    // tells the reviewer to honor exactly those lines (the deterministic matcher's
    // spans), not to re-derive marker scope. The retired self-interpretation phrase
    // ('treat the suppressed code as satisfied') must be gone.
    expect(prompt).toContain('yg-suppress');
    expect(prompt).toContain('Honor exactly these line ranges');
    expect(prompt).not.toContain('treat the suppressed code as satisfied');
  });

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
    // The component DESCRIPTION argument is accepted and ignored — a description
    // is not a verdict input, so it must not reach the reviewer (see
    // llm/prompt.ts's nodeElement). The component PATH still does.
    expect(prompt).not.toContain('Loads graph files');
    expect(prompt).toContain('cli/core/loader');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('{"satisfied": true|false');
  });

  it('escapes adopter source content and metadata so it cannot break the XML framing (F3)', () => {
    const prompt = buildPrompt(
      { id: 'rule', description: 'a "quoted" rule', content: 'Must do X' },
      'node with </node> and <x>',
      'svc/handler',
      [{ path: 'src/a.ts', content: 'const s = "</file><inject>evil</inject>";' }],
    );
    // The raw markup-breaking sequences from source content must NOT appear
    // verbatim — they are escaped to &lt;/&gt; entities.
    expect(prompt).not.toContain('</file><inject>');
    expect(prompt).toContain('&lt;/file&gt;&lt;inject&gt;');
    // The component description is dropped entirely rather than escaped, so its
    // markup cannot reach the prompt in EITHER form — a stronger guarantee than
    // escaping, and the reason this argument is now ignored.
    expect(prompt).not.toContain('<x>');
    expect(prompt).not.toContain('&lt;x&gt;');
    // The structural <file ...> wrapper the runner emits is still present.
    expect(prompt).toContain('<file path="src/a.ts">');
  });
});

describe('verifyWithConsensus', () => {
  it('(a) consensus=1 wraps the single response — votes.length===1, response deep-equals it', async () => {
    const single: AspectResponse = { satisfied: true, reason: 'ok', errorSource: 'codeViolation' };
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => single),
      isAvailable: vi.fn(async () => true),
    };
    const result = await verifyWithConsensus(provider, 'prompt', 1);
    expect(result.votes).toHaveLength(1);
    expect(result.response).toEqual(single);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(1);
  });

  it('(b) consensus=1 with a THROWING provider still rejects — the throw propagates unchanged (fail-closed)', async () => {
    const boom = new Error('provider exploded');
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => { throw boom; }),
      isAvailable: vi.fn(async () => true),
    };
    await expect(verifyWithConsensus(provider, 'prompt', 1)).rejects.toThrow('provider exploded');
  });

  it('(c) consensus=3 [sat, unsat(codeViolation), sat] aggregates satisfied, votes.length===3', async () => {
    const responses: AspectResponse[] = [
      { satisfied: true, reason: 'yes1', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'no', errorSource: 'codeViolation' },
      { satisfied: true, reason: 'yes2', errorSource: 'codeViolation' },
    ];
    let i = 0;
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => responses[i++]),
      isAvailable: vi.fn(async () => true),
    };
    const result = await verifyWithConsensus(provider, 'prompt', 3);
    expect(result.response.satisfied).toBe(true);
    expect(result.response.errorSource).toBe('codeViolation');
    expect(result.votes).toHaveLength(3);
    expect(result.votes).toEqual(responses);
  });

  it('(d) consensus=3 all-losing provider-error votes aggregate errorSource: provider (byte-equivalence guard)', async () => {
    const responses: AspectResponse[] = [
      { satisfied: false, reason: 'provider down', errorSource: 'provider' },
      { satisfied: false, reason: 'provider down', errorSource: 'provider' },
      { satisfied: false, reason: 'provider down', errorSource: 'provider' },
    ];
    let i = 0;
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => responses[i++]),
      isAvailable: vi.fn(async () => true),
    };
    const result = await verifyWithConsensus(provider, 'prompt', 3);
    expect(result.response.satisfied).toBe(false);
    expect(result.response.errorSource).toBe('provider');
    expect(result.votes).toHaveLength(3);
  });

  it('(e) consensus=3 [provider-error, codeViolation, codeViolation] refuses with the real violation reason, not the provider-error text', async () => {
    const responses: AspectResponse[] = [
      { satisfied: false, reason: 'OpenAI request failed', errorSource: 'provider' },
      { satisfied: false, reason: 'Rule X violated: missing null check', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'Rule X violated again', errorSource: 'codeViolation' },
    ];
    let i = 0;
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => responses[i++]),
      isAvailable: vi.fn(async () => true),
    };
    const result = await verifyWithConsensus(provider, 'prompt', 3);
    expect(result.response.satisfied).toBe(false);
    expect(result.response.errorSource).toBe('codeViolation');
    // The reason must come from a codeViolation vote, not the leading provider error.
    expect(result.response.reason).toBe('Rule X violated: missing null check');
  });

  it('(f) the refusal reason is order-independent [codeViolation, provider-error, codeViolation]', async () => {
    const responses: AspectResponse[] = [
      { satisfied: false, reason: 'Rule Y violated: unsafe cast', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'Anthropic request failed', errorSource: 'provider' },
      { satisfied: false, reason: 'Rule Y violated too', errorSource: 'codeViolation' },
    ];
    let i = 0;
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => responses[i++]),
      isAvailable: vi.fn(async () => true),
    };
    const result = await verifyWithConsensus(provider, 'prompt', 3);
    expect(result.response.errorSource).toBe('codeViolation');
    expect(result.response.reason).toBe('Rule Y violated: unsafe cast');
  });

  // ── Issue 209 (m13): a provider-error vote is not a refusal ──────────────────
  it('(g) error votes are left out of the majority: [sat, sat, err, err, refuse] at consensus 5 APPROVES (2 of 3 verdicts)', async () => {
    const responses: AspectResponse[] = [
      { satisfied: true, reason: 'ok 1', errorSource: 'codeViolation' },
      { satisfied: true, reason: 'ok 2', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'timed out', errorSource: 'provider' },
      { satisfied: false, reason: 'unparseable', errorSource: 'provider' },
      { satisfied: false, reason: 'Rule Z violated', errorSource: 'codeViolation' },
    ];
    let i = 0;
    const provider: LlmProvider = { verifyAspect: vi.fn(async () => responses[i++]), isAvailable: vi.fn(async () => true) };
    const result = await verifyWithConsensus(provider, 'prompt', 5);
    expect(result.response).toEqual({ satisfied: true, reason: 'ok 1', errorSource: 'codeViolation' });
    expect(consensusTally(result.votes)).toEqual({ satisfied: 2, total: 3 });
  });

  it('(h) too few verdicts for a majority is infra, never a refusal: [refuse, err, err] at consensus 3', async () => {
    const responses: AspectResponse[] = [
      { satisfied: false, reason: 'Rule Z violated', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'HTTP 529 overloaded', errorSource: 'provider' },
      { satisfied: false, reason: 'HTTP 529 overloaded', errorSource: 'provider' },
    ];
    let i = 0;
    const provider: LlmProvider = { verifyAspect: vi.fn(async () => responses[i++]), isAvailable: vi.fn(async () => true) };
    const result = await verifyWithConsensus(provider, 'prompt', 3);
    expect(result.response.satisfied).toBe(false);
    expect(result.response.errorSource).toBe('provider');
    expect(result.response.reason).toContain('only 1 of 3 consensus votes returned a verdict');
    expect(result.response.reason).toContain('HTTP 529 overloaded');
  });

  it('(i) the votes run concurrently: every pass is in flight before any answers', async () => {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => { release = r; });
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async () => {
        started += 1;
        if (started === 3) release();
        await allStarted; // a sequential loop would wait here forever on the first vote
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      }),
      isAvailable: vi.fn(async () => true),
    };
    const result = await Promise.race([
      verifyWithConsensus(provider, 'prompt', 3),
      new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 1000)),
    ]);
    expect(result).not.toBe('stuck');
    expect(started).toBe(3);
  });

  it('(j) a throwing pass still fails the pair, once every pass has settled', async () => {
    let settled = 0;
    const provider: LlmProvider = {
      verifyAspect: vi.fn(async (): Promise<AspectResponse> => {
        const n = settled;
        await new Promise((r) => setTimeout(r, n === 0 ? 0 : 20));
        settled += 1;
        if (n === 0) throw new Error('boom');
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' };
      }),
      isAvailable: vi.fn(async () => true),
    };
    await expect(verifyWithConsensus(provider, 'prompt', 3)).rejects.toThrow('boom');
    expect(settled).toBe(3);
  });
});
