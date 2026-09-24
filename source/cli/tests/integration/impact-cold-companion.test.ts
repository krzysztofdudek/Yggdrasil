/**
 * Integration tests for collectInvalidatedPairs — cold companion-LLM resolution.
 *
 * Uses the e2e-companion fixture: the `scenarios` node has a per:file companion-LLM
 * aspect (`scenario-matches-test`), a `uses -> specs` relation, and a companion.mjs
 * that reads ONE paired spec via ctx.fs.read (the spec path is in the scenario's
 * frontmatter `test:` key). Editing the paired spec must admit the scenario pair as
 * a potential invalidation.
 *
 * These are COLD tests: the lock is empty, so there are no warm lock entries.
 * `yg impact` executes no repository code, so the companion is NOT run to narrow
 * the answer: every scenario unit whose companion may read the edited spec (it is
 * within the scenarios node's allowed reads) is admitted as
 * `cold-potential-companion / potential` — an upper bound, the same one a cold
 * deterministic pair gets.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { collectInvalidatedPairs } from '../../src/cli/impact-handlers.js';
import type { LockFile } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'e2e-companion');

async function loadE2eCompanionFixture(): Promise<{ graph: Awaited<ReturnType<typeof loadGraph>>; projectRoot: string }> {
  const projectRoot = FIXTURE;
  const graph = await loadGraph(projectRoot);
  return { graph, projectRoot };
}

const emptyLock = (): LockFile => ({ version: 1, verdicts: {}, nodes: {} });

describe('collectInvalidatedPairs — cold companion-LLM', () => {
  it('cold: editing a spec the companion may read admits every scenario unit as a potential invalidation, without running the companion', async () => {
    const { graph, projectRoot } = await loadE2eCompanionFixture();
    const lock = emptyLock();
    const F = 'apps/e2e/tests/checkout.spec.ts';
    const set = await collectInvalidatedPairs(graph, F, lock, projectRoot);
    const hits = set.pairs.filter((p) => p.aspectId === 'scenario-matches-test');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.reasons).toEqual(['cold-potential-companion']);
      expect(h.mode).toBe('potential');
    }
    expect(hits.map((h) => h.unitKey)).toContain('file:references/e2e-test-scenarios/checkout.md');
    expect(set.unresolved).toHaveLength(0);
  });

  it('cold: a companion is never precise without a verdict — no unit is admitted as observe-companion', async () => {
    const { graph, projectRoot } = await loadE2eCompanionFixture();
    const set = await collectInvalidatedPairs(graph, 'apps/e2e/tests/login.spec.ts', emptyLock(), projectRoot);
    expect(set.pairs.some((p) => p.reasons.includes('observe-companion'))).toBe(false);
  });
});
