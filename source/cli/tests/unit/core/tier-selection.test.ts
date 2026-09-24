import { describe, it, expect } from 'vitest';
import { selectTierForAspect } from '../../../src/core/tier-selection.js';
import type { AspectDef, ReviewerConfig, LlmConfig } from '../../../src/model/graph.js';

const tierA: LlmConfig = {
  provider: 'claude-code',
  model: 'sonnet',
  temperature: 0,
  consensus: 1,
};
const tierB: LlmConfig = {
  provider: 'claude-code',
  model: 'opus',
  temperature: 0,
  consensus: 3,
};

function aspect(reviewer: { type: 'llm' | 'deterministic'; tier?: string }): AspectDef {
  return {
    id: 'test-aspect',
    name: 'TestAspect',
    reviewer,
    artifacts: [],
  };
}

describe('selectTierForAspect', () => {
  it('returns the explicit tier when reviewer.tier is set', () => {
    const cfg: ReviewerConfig = { default: 'a', tiers: { a: tierA, b: tierB } };
    const r = selectTierForAspect(aspect({ type: 'llm', tier: 'b' }), cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tier).toBe(tierB);
      expect(r.tierName).toBe('b');
    }
  });

  it('errors when explicit tier does not exist', () => {
    const cfg: ReviewerConfig = { default: 'a', tiers: { a: tierA } };
    const r = selectTierForAspect(aspect({ type: 'llm', tier: 'missing' }), cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.what).toMatch(/references tier 'missing'/);
    }
  });

  it('uses default when tier is omitted and multiple tiers', () => {
    const cfg: ReviewerConfig = { default: 'a', tiers: { a: tierA, b: tierB } };
    const r = selectTierForAspect(aspect({ type: 'llm' }), cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tierName).toBe('a');
  });

  it('errors when no tier and no default with multiple tiers', () => {
    const cfg: ReviewerConfig = { tiers: { a: tierA, b: tierB } };
    const r = selectTierForAspect(aspect({ type: 'llm' }), cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.what).toMatch(/no tier and reviewer.default is unset/);
  });

  it('uses single tier as implicit default', () => {
    const cfg: ReviewerConfig = { tiers: { only: tierA } };
    const r = selectTierForAspect(aspect({ type: 'llm' }), cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tierName).toBe('only');
  });

  it('errors when called with deterministic aspect (programmer error)', () => {
    const cfg: ReviewerConfig = { tiers: { a: tierA } };
    const r = selectTierForAspect(aspect({ type: 'deterministic' }), cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.what).toMatch(/not a reviewer rule/);
  });

  it('errors when tiers is empty', () => {
    const cfg: ReviewerConfig = { tiers: {} };
    const r = selectTierForAspect(aspect({ type: 'llm' }), cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.what).toMatch(/reviewer.tiers is empty/);
  });

  it('errors when default references unknown tier', () => {
    const cfg: ReviewerConfig = { default: 'ghost', tiers: { a: tierA } };
    const r = selectTierForAspect(aspect({ type: 'llm' }), cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.what).toMatch(/references unknown tier 'ghost'/);
  });
});
