/**
 * Tests for cli/det-concurrency.ts — the worker-thread ceiling for the free
 * deterministic fill.
 *
 * Sizing on cores alone is what let a big machine multiply a big per-worker
 * footprint by a big worker count until a large repository could not rebuild its
 * deterministic verdicts at all. Every case here drives the pure resolver with
 * injected machine facts, so none of it depends on the box the tests run on.
 */
import { describe, it, expect } from 'vitest';

import { resolveDetConcurrency, detConcurrencyForThisMachine, detTaskBudgetMs, DEFAULT_DET_TASK_BUDGET_MS } from '../../../src/cli/det-concurrency.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('resolveDetConcurrency', () => {
  it('leaves one core for the parent when memory is not the binding constraint', () => {
    expect(resolveDetConcurrency({ cores: 14, totalMemoryBytes: 256 * GB, processRssBytes: 200 * MB })).toBe(13);
  });

  it('cuts the pool below the core count when memory would not hold that many workers', () => {
    // 16 GB machine, half of it budgeted, a parent already resident at 1 GB ⇒
    // ~1.5 GB assumed per worker ⇒ 5 workers, well under the 31 cores allow.
    const workers = resolveDetConcurrency({ cores: 32, totalMemoryBytes: 16 * GB, processRssBytes: 1 * GB });
    expect(workers).toBe(5);
    expect(workers).toBeLessThan(31);
  });

  it('scales down as the repository (and so the parent footprint) grows, with nothing to tune', () => {
    const machine = { cores: 32, totalMemoryBytes: 16 * GB };
    const small = resolveDetConcurrency({ ...machine, processRssBytes: 300 * MB });
    const large = resolveDetConcurrency({ ...machine, processRssBytes: 2 * GB });
    expect(large).toBeLessThan(small);
  });

  it('never returns less than one worker, however tight the machine', () => {
    expect(resolveDetConcurrency({ cores: 1, totalMemoryBytes: 512 * MB, processRssBytes: 400 * MB })).toBe(1);
    expect(resolveDetConcurrency({ cores: 0, totalMemoryBytes: 0, processRssBytes: 0 })).toBe(1);
  });

  it('applies a floor to the per-worker estimate, so an implausibly small reading cannot license an unbounded pool', () => {
    // A parent reporting ~0 resident would divide the budget by nothing without
    // the floor. With it, an 8 GB machine budgets 4 GB against a 128 MB floor.
    const workers = resolveDetConcurrency({ cores: 1024, totalMemoryBytes: 8 * GB, processRssBytes: 1 });
    expect(workers).toBe(32);
  });

  it('is bounded by cores whenever memory is plentiful — the pool never exceeds what can run at once', () => {
    for (const cores of [2, 4, 8, 64]) {
      expect(resolveDetConcurrency({ cores, totalMemoryBytes: 1024 * GB, processRssBytes: 100 * MB }))
        .toBe(cores - 1);
    }
  });
});

describe('resolveDetConcurrency — sized from the largest unit a worker may parse', () => {
  it('estimates a worker as the parent plus that unit\'s trees, not a multiple of the parent', () => {
    const machine = { cores: 32, totalMemoryBytes: 16 * GB, processRssBytes: 400 * MB };
    // A small unit: parent + trees stays well under the old 1.5 x parent guess.
    expect(resolveDetConcurrency({ ...machine, largestUnitSourceBytes: 1 * MB }))
      .toBeGreaterThan(resolveDetConcurrency(machine));
  });

  it('cuts the pool as the largest component grows', () => {
    const machine = { cores: 32, totalMemoryBytes: 16 * GB, processRssBytes: 400 * MB };
    const small = resolveDetConcurrency({ ...machine, largestUnitSourceBytes: 2 * MB });
    const large = resolveDetConcurrency({ ...machine, largestUnitSourceBytes: 200 * MB });
    expect(large).toBeLessThan(small);
    // 8 GB budget / (400 MB + 200 MB x 20 = 4.4 GB) = 1 worker.
    expect(large).toBe(1);
  });
});

describe('detConcurrencyForThisMachine', () => {
  it('measures the real machine and returns a usable worker count', () => {
    const workers = detConcurrencyForThisMachine();
    expect(Number.isInteger(workers)).toBe(true);
    expect(workers).toBeGreaterThanOrEqual(1);
  });
});

describe('detTaskBudgetMs — the per-check wall-clock budget', () => {
  it('defaults to a finite budget', () => {
    expect(detTaskBudgetMs({})).toBe(DEFAULT_DET_TASK_BUDGET_MS);
    expect(DEFAULT_DET_TASK_BUDGET_MS).toBeGreaterThan(0);
  });
  it('YG_DET_TASK_TIMEOUT_MS overrides it; 0 switches the bound off', () => {
    expect(detTaskBudgetMs({ YG_DET_TASK_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(detTaskBudgetMs({ YG_DET_TASK_TIMEOUT_MS: '0' })).toBe(0);
  });
  it('a value that is not a whole number of milliseconds keeps the default', () => {
    expect(detTaskBudgetMs({ YG_DET_TASK_TIMEOUT_MS: 'fast' })).toBe(DEFAULT_DET_TASK_BUDGET_MS);
    expect(detTaskBudgetMs({ YG_DET_TASK_TIMEOUT_MS: '-1' })).toBe(DEFAULT_DET_TASK_BUDGET_MS);
  });
});
