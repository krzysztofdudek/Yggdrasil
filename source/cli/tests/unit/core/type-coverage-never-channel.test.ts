/**
 * The "never" channel family for type-covered files: three checks that
 * structurally cannot fire against a type-covered file's path, because each
 * one only ever iterates `graph.nodes` (or, for `yg log add`, only ever
 * accepts a path that is a KEY in `graph.nodes`) — and a type-covered file's
 * path was never a key in `graph.nodes` and never will be (virtual entries
 * never enter `graph.nodes`).
 *
 * Pure regression pins: every assertion here is already true today, by
 * construction, independent of the type-level classification lattice. They
 * exist so a FUTURE change to node resolution or these checks' own iteration
 * (e.g. someone "helpfully" widening either to also look at type-covered
 * files) trips a RED test instead of silently shipping.
 *
 * `logAdd` is a disk writer (it appends a log.md under the graph's own
 * model/ tree once its guard lets a call through), so this drives a
 * per-test mkdtemp copy of the fixture rather than the committed original —
 * the very guard this file exists to regression-pin, if it ever regresses,
 * would otherwise write into a fixture roughly thirty other tests read
 * golden counts from.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { logAdd } from '../../../src/core/log/log-add.js';
import { checkMissingDescriptions, checkHighFanOut } from '../../../src/core/checks/relations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');

let tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-never-channel-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('the never-channel family for type-covered files', () => {
  it('yg log add rejects a type-covered file path exactly as it rejects any other non-node path (regression-pin on the pre-existing graph.nodes.has guard)', async () => {
    // type-coverage-basic — src/svc/handler.ts is type-covered (matches the
    // svc type cleanly), never a node key: the fixture's own architecture
    // comment states it has NO nodes at all.
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await logAdd({
      graph,
      nodePath: 'src/svc/handler.ts',
      reasonText: 'x',
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.what).toMatch(/not found/i);
  });

  it('description-missing never fires for a type-covered file — the check iterates graph.nodes only, which a type-covered file never joins', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    // graph.nodes is empty in this fixture, so an empty result would hold
    // whether or not the check does anything at all. Add a real node (fully
    // in-memory — nothing here touches disk) that DOES lack a description,
    // so the check's silence on the type-covered file is proven against a
    // check that demonstrably fires, not against one that never runs.
    graph.nodes.set('probe/undescribed', {
      path: 'probe/undescribed',
      meta: { name: 'Probe', type: 'svc' },
      children: [],
      parent: null,
    });
    const issues = checkMissingDescriptions(graph);
    expect(issues.some((i) => i.nodePath === 'probe/undescribed')).toBe(true);
    expect(issues.some((i) => i.messageData?.what?.includes('src/svc/handler.ts'))).toBe(false);
  });

  it('max_direct_relations / high-fan-out never fires for a type-covered file — same node-only iteration', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    // Same reasoning as the description-missing case above: an in-memory
    // node with more direct relations than the built-in ceiling proves the
    // check actually fires before trusting its silence on the type-covered
    // file.
    graph.nodes.set('probe/high-fan-out', {
      path: 'probe/high-fan-out',
      meta: {
        name: 'Probe',
        type: 'svc',
        relations: Array.from({ length: 11 }, (_, i) => ({ target: `probe/dep-${i}`, type: 'uses' as const })),
      },
      children: [],
      parent: null,
    });
    const issues = checkHighFanOut(graph);
    expect(issues.some((i) => i.nodePath === 'probe/high-fan-out')).toBe(true);
    expect(issues.some((i) => i.messageData?.what?.includes('src/svc/handler.ts'))).toBe(false);
  });
});
