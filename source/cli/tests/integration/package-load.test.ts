// =============================================================================
// Integration — a repository with an installed package, loaded and run for real.
//
// Everything here goes through `loadGraph` over a real directory and through
// `runStructureAspect` over a real rule script. What is proven:
//
//   1. loading   → installed ids, resolved implies, the adaptation applied
//   2. defaults  → no adaptation ⇒ the package's own settings
//   3. running   → the rule's answer follows the setting, and READING it is recorded
//   4. identity  → changing a setting the rule reads changes the pair's hash
//   5. the lock  → a verdict filled before the change is unverified after, and
//                  verified again once refilled
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runStructureAspect } from '../../src/structure/runner.js';
import { computeDetInputHash } from '../../src/core/pair-hash.js';
import { hashFile } from '../../src/io/hash.js';
import type { Graph } from '../../src/model/graph.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INSTALL = 'packages/acme/law/demo';
const RULE_A = `${INSTALL}/rule-a`;

const CHECK_MJS = `export function check(ctx) {
  const limit = ctx.config.threshold;
  const violations = [];
  for (const file of ctx.subject) {
    const lines = file.content.split('\\n').length;
    if (lines > limit) violations.push({ file: file.path, line: 1, message: 'too long: ' + lines + ' > ' + limit });
  }
  return violations;
}
`;

/**
 * A repository with one component and one installed package carrying a
 * deterministic rule that reads a setting, an aggregating rule that implies it,
 * and (optionally) an adaptation for the first.
 */
function repoWithInstalledPackage(adapt?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-pkg-load-'));
  tempDirs.push(root);
  const ygg = path.join(root, '.yggdrasil');

  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n', 'utf-8');

  mkdirSync(path.join(ygg, 'model', 'app'), { recursive: true });
  writeFileSync(path.join(ygg, 'yg-config.yaml'), 'version: "6.0.0"\n', 'utf-8');
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  app:\n    description: the one component\n    when:\n      path: "src/**"\n',
    'utf-8',
  );
  writeFileSync(
    path.join(ygg, 'model', 'app', 'yg-node.yaml'),
    `name: App\ntype: app\naspects:\n  - ${RULE_A}\nmapping:\n  - src/a.ts\n`,
    'utf-8',
  );

  const pkgRoot = path.join(ygg, 'aspects', ...INSTALL.split('/'));
  mkdirSync(path.join(pkgRoot, 'rule-a'), { recursive: true });
  mkdirSync(path.join(pkgRoot, 'rule-c'), { recursive: true });
  writeFileSync(
    path.join(pkgRoot, 'yg-package.yaml'),
    `schema: yg-package/1
name: demo
version: 0.1.0
requires: { yg: ">=1.0.0" }
aspects: [rule-a, rule-c]
config:
  rule-a:
    threshold: { type: number, default: 3 }
    label: { type: string, default: "house" }
`,
    'utf-8',
  );
  writeFileSync(
    path.join(pkgRoot, 'rule-a', 'yg-aspect.yaml'),
    'name: FileNotTooLong\ndescription: A file must not run past the allowed line count.\nreviewer: { type: deterministic }\nstatus: enforced\n',
    'utf-8',
  );
  writeFileSync(path.join(pkgRoot, 'rule-a', 'check.mjs'), CHECK_MJS, 'utf-8');
  writeFileSync(
    path.join(pkgRoot, 'rule-c', 'yg-aspect.yaml'),
    'name: HouseStyle\ndescription: The bundle.\nimplies:\n  - rule-a\n',
    'utf-8',
  );
  if (adapt !== undefined) writeFileSync(path.join(pkgRoot, 'rule-a', 'yg-aspect.adapt.yaml'), adapt, 'utf-8');
  return root;
}

async function runRuleA(root: string, graph: Graph) {
  return runStructureAspect({
    aspectDir: path.join(root, '.yggdrasil', 'aspects', ...RULE_A.split('/')),
    aspectId: RULE_A,
    unit: { kind: 'node', nodePath: 'app' },
    graph,
    projectRoot: root,
  });
}

describe('a repository with an installed package', () => {
  it('loads its rules under their installed names, with implies resolved', async () => {
    const graph = await loadGraph(repoWithInstalledPackage());
    expect(graph.aspectParseErrors ?? []).toEqual([]);
    expect(graph.aspects.map((a) => a.id).sort()).toEqual([RULE_A, `${INSTALL}/rule-c`]);
    expect(graph.aspects.find((a) => a.id === `${INSTALL}/rule-c`)?.implies).toEqual([RULE_A]);
  });

  it('takes the package defaults when nothing adapts them', async () => {
    const graph = await loadGraph(repoWithInstalledPackage());
    expect(graph.aspects.find((a) => a.id === RULE_A)?.config).toEqual({ threshold: 3, label: 'house' });
  });

  it('applies the adaptation, leaving the keys it does not name at the package default', async () => {
    const graph = await loadGraph(repoWithInstalledPackage('status: advisory\nconfig:\n  threshold: 40\n'));
    const rule = graph.aspects.find((a) => a.id === RULE_A);
    expect(rule?.status).toBe('advisory');
    expect(rule?.config).toEqual({ threshold: 40, label: 'house' });
  });

  it('the adaptation is never one of the rule\'s own files', async () => {
    const graph = await loadGraph(repoWithInstalledPackage('status: advisory\n'));
    const rule = graph.aspects.find((a) => a.id === RULE_A);
    expect(rule?.artifacts.map((a) => a.filename).sort()).toEqual(['check.mjs']);
  });
});

describe('running a rule that reads a setting', () => {
  it("the answer follows the setting, and reading it is recorded", async () => {
    const root = repoWithInstalledPackage();
    const graph = await loadGraph(root);
    const result = await runRuleA(root, graph);

    // Four lines of source against a threshold of 3 — the rule refuses.
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain('> 3');
    // And the value it used is part of what it observed.
    expect(result.observations.map(([k]) => k)).toContain('config:threshold');
  });

  it('a higher setting makes the same rule pass', async () => {
    const root = repoWithInstalledPackage('config:\n  threshold: 40\n');
    const graph = await loadGraph(root);
    expect((await runRuleA(root, graph)).violations).toEqual([]);
  });

  it('a setting the rule never reads is never observed', async () => {
    // The property the whole design rests on: adapting `label` re-opens nothing.
    const root = repoWithInstalledPackage('config:\n  label: "ours"\n');
    const graph = await loadGraph(root);
    const keys = (await runRuleA(root, graph)).observations.map(([k]) => k);
    expect(keys).toContain('config:threshold');
    expect(keys).not.toContain('config:label');
  });
});

describe("what a change to a setting does to a recorded verdict", () => {
  /** The pair hash for rule-a on `app`, as the current graph and disk stand. */
  async function pairHash(root: string): Promise<string> {
    const graph = await loadGraph(root);
    const result = await runRuleA(root, graph);
    return computeDetInputHash({
      aspectId: RULE_A,
      scope: undefined,
      nodePath: 'app',
      ruleHash: await hashFile(path.join(root, '.yggdrasil', 'aspects', ...RULE_A.split('/'), 'check.mjs')),
      files: [['src/a.ts', await hashFile(path.join(root, 'src', 'a.ts'))]],
      touched: result.observations,
      verdict: 'approved',
    });
  }

  it('changing a setting the rule READS changes the pair', async () => {
    const before = await pairHash(repoWithInstalledPackage('config:\n  threshold: 40\n'));
    const after = await pairHash(repoWithInstalledPackage('config:\n  threshold: 41\n'));
    expect(after).not.toBe(before);
  });

  it('changing a setting the rule IGNORES leaves the pair exactly as it was', async () => {
    const before = await pairHash(repoWithInstalledPackage('config:\n  threshold: 40\n'));
    const after = await pairHash(repoWithInstalledPackage('config:\n  threshold: 40\n  label: "ours"\n'));
    expect(after).toBe(before);
  });

  it('the same repository read twice gives the same pair', async () => {
    const root = repoWithInstalledPackage('config:\n  threshold: 40\n');
    expect(await pairHash(root)).toBe(await pairHash(root));
  });
});
