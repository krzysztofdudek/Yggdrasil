/**
 * Tests for computeTypeAspectCascade's exception guard: the original guard
 * caught EVERYTHING from computeEffectiveAspects/computeEffectiveAspectStatuses and always
 * yielded an empty result. Narrowed here to catch ONLY ImpliesCycleError (a
 * known, already-separately-reported structural fault) and rethrow anything
 * else — a genuine unexpected bug must not be silently hidden behind an empty
 * result forever.
 *
 * Isolated into its OWN file (rather than added to type-effective.test.ts)
 * because it must mock core/graph/aspects.js's two cascade entry points — a
 * mock that would otherwise silently break every one of that file's 30+
 * real-graph-driven tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../../src/model/graph.js';

const mockComputeEffectiveAspects = vi.fn();
const mockComputeEffectiveAspectStatuses = vi.fn();

vi.mock('../../../src/core/graph/aspects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/graph/aspects.js')>();
  return {
    ...actual,
    computeEffectiveAspects: (...args: unknown[]) => mockComputeEffectiveAspects(...args),
    computeEffectiveAspectStatuses: (...args: unknown[]) => mockComputeEffectiveAspectStatuses(...args),
  };
});

const { computeTypeAspectCascade } = await import('../../../src/core/type-effective.js');
const { ImpliesCycleError } = await import('../../../src/core/graph/aspects.js');

// A minimal graph whose ONLY job is to let `matchedType` resolve truthy so the
// cascade proceeds far enough to call the (mocked) effectiveness engine.
const MINIMAL_GRAPH = {
  nodes: new Map(),
  aspects: [],
  architecture: { node_types: { leaf: { description: 'leaf' } } },
  flows: [],
} as unknown as Graph;

describe('computeTypeAspectCascade exception guard', () => {
  beforeEach(() => {
    mockComputeEffectiveAspects.mockReset();
    mockComputeEffectiveAspectStatuses.mockReset();
  });

  it('absorbs ImpliesCycleError — yields an empty result, plus the cycle it absorbed, rather than aborting the caller', () => {
    mockComputeEffectiveAspects.mockImplementation(() => {
      throw new ImpliesCycleError('cycle detected', 'some-aspect');
    });
    const result = computeTypeAspectCascade(MINIMAL_GRAPH, 'src/leaf/a.ts', 'leaf');
    expect(result).toEqual({ effective: [], drops: [], cycle: { aspectId: 'some-aspect' } });
  });

  it('rethrows any OTHER unexpected error rather than silently swallowing a real bug', () => {
    mockComputeEffectiveAspects.mockImplementation(() => {
      throw new TypeError('boom — not an implies cycle');
    });
    expect(() => computeTypeAspectCascade(MINIMAL_GRAPH, 'src/leaf/a.ts', 'leaf')).toThrow(
      'boom — not an implies cycle',
    );
  });

  it('rethrows an unexpected error from computeEffectiveAspectStatuses too (both calls are inside the same guard)', () => {
    mockComputeEffectiveAspects.mockReturnValue(new Set());
    mockComputeEffectiveAspectStatuses.mockImplementation(() => {
      throw new Error('boom from the status half');
    });
    expect(() => computeTypeAspectCascade(MINIMAL_GRAPH, 'src/leaf/a.ts', 'leaf')).toThrow(
      'boom from the status half',
    );
  });
});
