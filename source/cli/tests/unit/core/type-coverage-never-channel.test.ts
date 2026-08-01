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
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { logAdd } from '../../../src/core/log/log-add.js';
import { checkMissingDescriptions, checkHighFanOut } from '../../../src/core/checks/relations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');

describe('the never-channel family for type-covered files', () => {
  it('yg log add rejects a type-covered file path exactly as it rejects any other non-node path (regression-pin on the pre-existing graph.nodes.has guard)', async () => {
    // type-coverage-basic — src/svc/handler.ts is type-covered (matches the
    // svc type cleanly), never a node key: the fixture's own architecture
    // comment states it has NO nodes at all.
    const graph = await loadGraph(FIXTURE);
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
    const graph = await loadGraph(FIXTURE);
    const issues = checkMissingDescriptions(graph);
    expect(issues.some((i) => i.messageData?.what?.includes('src/svc/handler.ts'))).toBe(false);
  });

  it('max_direct_relations / high-fan-out never fires for a type-covered file — same node-only iteration', async () => {
    const graph = await loadGraph(FIXTURE);
    const issues = checkHighFanOut(graph);
    expect(issues.some((i) => i.messageData?.what?.includes('src/svc/handler.ts'))).toBe(false);
  });
});
