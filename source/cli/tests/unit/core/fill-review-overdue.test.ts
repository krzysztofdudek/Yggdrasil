/**
 * Regression: the `yg check --approve` fill stage must surface the same
 * review-cadence (aspect-review-overdue, spec RZ-18) warnings the plain
 * `yg check` path does. The plain path injects a UTC clock into runCheck;
 * runFill must thread the injected clock (RunFillOptions.reviewNowUtc) into BOTH
 * its dry-run cost-preview report AND its final post-fill report, or the overdue
 * warning silently disappears on the very command the workflow treats as the
 * terminal step of a change.
 *
 * HERMETIC: a fresh mkdtemp tree with a real .yggdrasil graph + a single
 * deterministic (passing) aspect carrying a past review_by date. No LLM, no
 * network, no wall clock read in any assertion (the clock is injected).
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';

/** A minimal real graph: one node, one passing deterministic aspect whose
 *  review_by date is 2026-08-01 (in the PAST relative to the future clock the
 *  tests inject). */
async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-overdue-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  const aspDir = path.join(yggRoot, 'aspects', 'past-rule');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(aspDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });

  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
  );
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n    log_required: false\n',
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - past-rule\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: past-rule\ndescription: past-rule\nreviewer:\n  type: deterministic\nreview_by: 2026-08-01\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
  return root;
}

const FUTURE_CLOCK = () => new Date('2027-10-01T00:00:00Z'); // after 2026-08-01

function overdueCount(issues: Array<{ code?: string }>): number {
  return issues.filter((i) => i.code === 'aspect-review-overdue').length;
}

describe('runFill threads the review-cadence clock into its reports (RZ-18 parity)', () => {
  it('full --approve report emits aspect-review-overdue when reviewNowUtc is past the date', async () => {
    const root = await setupProject();
    const graph = await loadGraph(path.join(root, '.yggdrasil'));
    const result = await runFill(graph, { gitTrackedFiles: null, reviewNowUtc: FUTURE_CLOCK });
    expect(overdueCount(result.checkResult.issues)).toBe(1);
  });

  it('dry-run cost-preview report also emits the overdue warning under the same clock', async () => {
    const root = await setupProject();
    const graph = await loadGraph(path.join(root, '.yggdrasil'));
    const result = await runFill(graph, { gitTrackedFiles: null, dryRun: true, reviewNowUtc: FUTURE_CLOCK });
    expect(overdueCount(result.checkResult.issues)).toBe(1);
  });

  it('core purity: with NO clock injected the overdue check is skipped (no warning)', async () => {
    const root = await setupProject();
    const graph = await loadGraph(path.join(root, '.yggdrasil'));
    const result = await runFill(graph, { gitTrackedFiles: null });
    expect(overdueCount(result.checkResult.issues)).toBe(0);
  });
});
