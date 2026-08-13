/**
 * What a measured change narrows in the fill stage's own classification
 * (core/fill-classify.ts), and — just as load-bearing — what it must NOT.
 *
 * The stage answers three different questions off one classification, and a
 * change scope moves exactly one of them:
 *   - which pairs get FILLED: the free deterministic half stays whole-project,
 *     the paid half narrows to the change;
 *   - which components the mandatory-log gate is asked about: every component
 *     owning an unverified pair, unnarrowed, because that gate is
 *     all-or-nothing about the code as it stands;
 *   - which numbers a person is shown: the subjects and the budget of what will
 *     actually be filled, never the larger set the gate looks at.
 *
 * Real on-disk projects (a real `.yggdrasil/` graph + real source under a fresh
 * mkdtemp), a real verifyLock pass, real aspect and tier resolution. The burn
 * set is the one thing constructed here, because it is plain data the CLI
 * boundary computes from git and hands to the engine — the same shape the
 * report path is handed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyFillPairs } from '../../../src/core/fill-classify.js';
import { progressivePairKey, type BurnSet } from '../../../src/core/progressive-scope.js';
import { readLock } from '../../../src/io/lock-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Consensus 3, so a budget derived from the filtered set is visibly not a pair count. */
const CONFIG_YAML =
  'reviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 3\n      config:\n        model: llama3\n';

const DET_RULE = 'export function check(ctx) { void ctx; return []; }\n';

/**
 * Two components with different obligations: `alpha` owes both a free check and
 * a reviewed one, `beta` owes only a reviewed one. That asymmetry is the point —
 * it is what makes "the component set the gate sees" and "the component set the
 * header counts" two different sets rather than accidentally the same one.
 */
async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-scope-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(ygg, { recursive: true });
  await writeFile(path.join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  await writeFile(path.join(root, 'src', 'beta.ts'), 'export const beta = 2;\n');
  await writeFile(path.join(ygg, 'yg-config.yaml'), CONFIG_YAML);
  await writeFile(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n    log_required: false\n',
  );

  for (const [name, aspects] of [
    ['alpha', ['free-rule', 'reviewed-rule']],
    ['beta', ['reviewed-rule']],
  ] as const) {
    const nodeDir = path.join(ygg, 'model', name);
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      `name: ${name}\ntype: service\ndescription: x\nmapping:\n  - src/${name}.ts\naspects:\n${aspects.map((a) => `  - ${a}`).join('\n')}\n`,
    );
  }

  for (const [id, kind, rule] of [
    ['free-rule', 'deterministic', DET_RULE],
    ['reviewed-rule', 'llm', 'Every file must be documented.\n'],
  ] as const) {
    const aspectDir = path.join(ygg, 'aspects', id);
    await mkdir(aspectDir, { recursive: true });
    await writeFile(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: ${kind}\nstatus: enforced\n`,
    );
    await writeFile(path.join(aspectDir, kind === 'llm' ? 'content.md' : 'check.mjs'), rule);
  }
  return root;
}

/** A burn set naming exactly the pairs listed — nothing global, nothing else. */
function burnOver(pairs: Array<[string, string]>): BurnSet {
  return {
    global: false,
    pairKeys: new Set(pairs.map(([aspectId, unitKey]) => progressivePairKey(aspectId, unitKey))),
    nodePaths: new Set(),
    files: new Set(),
    logOnlyNodePaths: new Set(),
    changedInputCount: 1,
  };
}

const unitsOf = (pairs: Array<{ aspectId: string; unitKey: string }>): string[] =>
  pairs.map((p) => `${p.aspectId} ${p.unitKey}`).sort();

/**
 * The scope as the fill stage receives it: the measurement plus the reference
 * listing the byte guard checks it against. `null` for that listing here — every
 * case in this file is about what a measured scope narrows, not about the guard,
 * and a null listing is the documented "no content check this run".
 */
async function classify(root: string, scope?: BurnSet, onlyDeterministic = false): ReturnType<typeof classifyFillPairs> {
  const graph = await loadGraph(root);
  const forFill = scope === undefined ? undefined : { burn: scope, blobOidByPath: null };
  return classifyFillPairs(graph, readLock(graph.rootPath), undefined, onlyDeterministic, forFill);
}

describe('classifyFillPairs — what a measured change narrows', () => {
  it('answers for the whole project when no change was measured', async () => {
    const root = await setupProject();

    const result = await classify(root);

    expect(unitsOf(result.llmPairs)).toEqual(['reviewed-rule node:alpha', 'reviewed-rule node:beta']);
    expect(result.skippedOutsideLlmPairs).toBe(0);
    // Two pairs at consensus 3.
    expect(result.reviewerCallBudget).toBe(6);
  });

  it('buys review only for the pairs the change is accountable for', async () => {
    const root = await setupProject();

    const result = await classify(root, burnOver([['reviewed-rule', 'node:alpha']]));

    expect(unitsOf(result.llmPairs)).toEqual(['reviewed-rule node:alpha']);
    expect(result.skippedOutsideLlmPairs).toBe(1);
    // One pair at consensus 3 — the budget follows the filtered set, so it is a
    // bill this run can actually spend.
    expect(result.reviewerCallBudget).toBe(3);
    // The free half is untouched by the measurement: alpha's deterministic pair
    // is in scope and beta owes none, but a whole-project free half is what the
    // NEXT measurement reads its observations from.
    expect(unitsOf(result.detPairs)).toEqual(['free-rule node:alpha']);
  });

  it('leaves the free half whole-project even when the change reached none of it', async () => {
    const root = await setupProject();

    const result = await classify(root, burnOver([['reviewed-rule', 'node:beta']]));

    expect(unitsOf(result.detPairs)).toEqual(['free-rule node:alpha']);
    expect(unitsOf(result.llmPairs)).toEqual(['reviewed-rule node:beta']);
  });

  it('reaches everything when the change reached something no pair can bound', async () => {
    const root = await setupProject();
    const global: BurnSet = { ...burnOver([]), global: true };

    const result = await classify(root, global);

    expect(unitsOf(result.llmPairs)).toEqual(['reviewed-rule node:alpha', 'reviewed-rule node:beta']);
    expect(result.skippedOutsideLlmPairs).toBe(0);
  });

  // The pin that matters most: the log gate's component set is NOT the set the
  // header counts. Narrowing it would excuse a component whose source moved with
  // no justification entry simply because some other change did not reach it.
  it('keeps the log gate’s component set unnarrowed while the reported one follows the fill', async () => {
    const root = await setupProject();

    const result = await classify(root, burnOver([['reviewed-rule', 'node:alpha']]));

    // Every component owning an unverified pair — beta included, though nothing
    // of beta's will be filled this run.
    expect([...result.nodeSet].sort()).toEqual(['alpha', 'beta']);
    // What will actually be filled lives on alpha alone.
    expect([...result.reportNodeSet].sort()).toEqual(['alpha']);
    expect([...result.reportFileSet]).toEqual([]);
    // And the classification still reports every unverified pair it found, which
    // is what the convergence sentinel is primed with — narrowing THAT would
    // make a run that deliberately filled less look like one that converged
    // badly.
    expect(result.unverifiedPairs).toHaveLength(3);
  });

  it('reports the deterministic-only skip alone, never both counts for the same pairs', async () => {
    const root = await setupProject();

    const result = await classify(root, burnOver([['reviewed-rule', 'node:alpha']]), true);

    expect(result.llmPairs).toEqual([]);
    // All three reviewed obligations… of which there are two, both unreviewed
    // this run for the SAME reason: no reviewer runs at all under this mode.
    expect(result.skippedLlmPairs).toBe(2);
    // Reporting the outside ones separately would announce the same pairs twice,
    // once as a subset of the other.
    expect(result.skippedOutsideLlmPairs).toBe(0);
    expect(result.reviewerCallBudget).toBe(0);
  });
});
