/**
 * SCOPE GUARD regression pin: `coverage.excluded` gates the NODELESS tier
 * only. An explicitly-mapped file (a node's own `mapping:` entry) keeps
 * enforcing exactly as before Q1 (absolute exclusion), because mapping is
 * stronger intent than exclusion — `computeExpectedPairs` (explicit-node pair
 * enumeration) has no dependency on `coverage.excluded` at all.
 *
 * This is a regression guard, not a RED-then-GREEN behavior change: it must
 * pass identically before and after Task 2's implementation. If it ever
 * fails, `isExcludedByCoverage` has leaked into `core/pairs.ts` or the
 * fill/GC path somewhere it must never reach.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

/** Always-passing deterministic check — content is irrelevant to this guard. */
const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';

/**
 * A throwaway project: one node explicitly mapping src/legacy/thing.ts, a
 * deterministic aspect attached, coverage.excluded: ['src/legacy/'].
 */
function scaffoldScopeGuardProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-scope-guard-'));
  const yggRoot = path.join(dir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'legacy');
  const aspectDir = path.join(yggRoot, 'aspects', 'legacy-check');
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(aspectDir, { recursive: true });
  mkdirSync(path.join(dir, 'src', 'legacy'), { recursive: true });

  writeFileSync(
    path.join(yggRoot, 'yg-config.yaml'),
    ['version: "5.2.0"', 'coverage:', '  excluded:', '    - src/legacy/', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'yg-architecture.yaml'),
    ['node_types:', '  legacyType:', '    description: legacy type', '    log_required: false', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(nodeDir, 'yg-node.yaml'),
    ['name: Legacy', 'type: legacyType', 'description: legacy node', 'mapping:', '  - src/legacy/thing.ts', 'aspects:', '  - legacy-check', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    ['name: legacy-check', 'description: a trivial deterministic aspect that always passes', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), DET_PASS, 'utf-8');
  writeFileSync(path.join(dir, 'src', 'legacy', 'thing.ts'), 'export const legacy = 1;\n', 'utf-8');

  return dir;
}

describe('SCOPE GUARD — an explicitly-mapped file under coverage.excluded still enforces (Q1 gates the NODELESS tier only)', () => {
  it('a node mapping a file under an excluded root produces a pair and keeps its verdict across --approve', async () => {
    const dir = scaffoldScopeGuardProject();
    try {
      const graph = await loadGraph(dir);
      const files = await walkRepoFiles(dir);

      const { pairs } = await computeExpectedPairs(graph);
      const legacyPair = pairs.find((p) => p.nodePath === 'legacy' && p.subjectFiles.includes('src/legacy/thing.ts'));
      expect(legacyPair).toBeDefined(); // NOT dropped by coverage.excluded — mapping is stronger intent

      await runFill(graph, { gitTrackedFiles: files, write: () => {} });
      const lockAfterFirst = readLock(graph.rootPath);
      const verdictAfterFirst = lockAfterFirst.verdicts['legacy-check']?.[legacyPair!.unitKey];
      expect(verdictAfterFirst).toBeDefined(); // the pair's verdict was actually written

      // Re-approve: the verdict must be RETAINED byte-for-byte, not pruned as
      // "detached" and not re-hashed — a change here would mean
      // isExcludedByCoverage leaked into computeExpectedPairs (or the GC
      // universe) somewhere it must never reach.
      const graphAgain = await loadGraph(dir);
      await runFill(graphAgain, { gitTrackedFiles: files, write: () => {} });
      const lockAfterSecond = readLock(graphAgain.rootPath);
      expect(lockAfterSecond.verdicts['legacy-check']?.[legacyPair!.unitKey]).toEqual(verdictAfterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
