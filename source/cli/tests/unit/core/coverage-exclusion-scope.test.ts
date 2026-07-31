/**
 * SUPREME EXCLUSION regression pin: `coverage.excluded` cuts everything it
 * matches, including a node's own explicit `mapping:` entry. A file under an
 * excluded root produces no pair even when a node names it directly — the
 * mapping claim does not outrank the exclusion.
 *
 * The mirror case is pinned alongside it: a file the mapping names that is
 * NOT under any excluded root keeps enforcing exactly as before — exclusion
 * must cut only what it actually matches, never anything else.
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
 * A throwaway project: one node explicitly mapping both src/legacy/thing.ts
 * (under the excluded root) and src/current/thing.ts (outside it), a
 * deterministic aspect attached, coverage.excluded: ['src/legacy/'].
 */
function scaffoldSupremeExclusionProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-supreme-exclusion-'));
  const yggRoot = path.join(dir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'legacy');
  const aspectDir = path.join(yggRoot, 'aspects', 'legacy-check');
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(aspectDir, { recursive: true });
  mkdirSync(path.join(dir, 'src', 'legacy'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'current'), { recursive: true });

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
    [
      'name: Legacy',
      'type: legacyType',
      'description: legacy node',
      'mapping:',
      '  - src/legacy/thing.ts',
      '  - src/current/thing.ts',
      'aspects:',
      '  - legacy-check',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    ['name: legacy-check', 'description: a trivial deterministic aspect that always passes', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), DET_PASS, 'utf-8');
  writeFileSync(path.join(dir, 'src', 'legacy', 'thing.ts'), 'export const legacy = 1;\n', 'utf-8');
  writeFileSync(path.join(dir, 'src', 'current', 'thing.ts'), 'export const current = 1;\n', 'utf-8');

  return dir;
}

describe('SUPREME EXCLUSION — coverage.excluded cuts a node\'s own explicit mapping too', () => {
  it('a node mapping a file under an excluded root produces NO pair, even though the node explicitly names it', async () => {
    const dir = scaffoldSupremeExclusionProject();
    try {
      const graph = await loadGraph(dir);
      const { pairs } = await computeExpectedPairs(graph);
      const legacyPair = pairs.find((p) => p.subjectFiles.includes('src/legacy/thing.ts'));
      expect(legacyPair).toBeUndefined(); // excluded — the mapping claim does not outrank it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the mirror case: a file the SAME mapping names that is NOT under any excluded root keeps enforcing', async () => {
    const dir = scaffoldSupremeExclusionProject();
    try {
      const graph = await loadGraph(dir);
      const files = await walkRepoFiles(dir);

      const { pairs } = await computeExpectedPairs(graph);
      const currentPair = pairs.find((p) => p.nodePath === 'legacy' && p.subjectFiles.includes('src/current/thing.ts'));
      expect(currentPair).toBeDefined(); // NOT excluded — over-correction would silently drop this real file

      await runFill(graph, { coverageVisibleFiles: files, write: () => {} });
      const lockAfterFirst = readLock(graph.rootPath);
      const verdictAfterFirst = lockAfterFirst.verdicts['legacy-check']?.[currentPair!.unitKey];
      expect(verdictAfterFirst).toBeDefined(); // the pair's verdict was actually written

      // Re-approve: the verdict must be RETAINED byte-for-byte, not pruned as
      // "detached" and not re-hashed.
      const graphAgain = await loadGraph(dir);
      await runFill(graphAgain, { coverageVisibleFiles: files, write: () => {} });
      const lockAfterSecond = readLock(graphAgain.rootPath);
      expect(lockAfterSecond.verdicts['legacy-check']?.[currentPair!.unitKey]).toEqual(verdictAfterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
