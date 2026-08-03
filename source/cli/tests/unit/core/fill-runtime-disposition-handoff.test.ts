/**
 * Unit tests for the same-process fill→check handoff (core/fill.ts's own
 * post-fill `runCheck` call, core/check.ts's `runtimeDispositions` option,
 * core/type-visibility.ts's `classifyRunnerDisposition`/`toRuntimeVisibilityRows`):
 * `yg check --approve` learns a component-free file's disposition from THIS
 * run's own attempt to run the check, and its own post-fill report names it —
 * a run that never fills (a later, separate `yg check`, no lock persistence)
 * has nothing to hand off and falls back to the pre-existing qualified
 * wording. Real structure runner, no mocking: both scenarios below execute a
 * real check.mjs that touches `ctx.node` unconditionally and watch it fail
 * for real, the same way `yg check --approve` would on a real project.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { runCheck } from '../../../src/core/check.js';
import { renderTypeVisibilityBlock } from '../../../src/cli/check-render-header.js';

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the fill→check handoff for a disposition this run just watched happen', () => {
  it('runFill\'s own post-fill report names the reason, instead of a bare "unverified" caveat', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-handoff-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'touches-ctx-node'), { recursive: true });
    mkdirSync(path.join(yggRoot, 'model'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'leafy'), { recursive: true });
    writeFileSync(
      path.join(yggRoot, 'yg-config.yaml'),
      `${V5_REVIEWER_CONFIG}\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n`,
    );
    writeFileSync(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  leafy:\n    description: x\n    when:\n      path: "src/leafy/**"\n    aspects:\n      - touches-ctx-node\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'yg-aspect.yaml'),
      'name: touches-ctx-node\ndescription: touches ctx.node on a file with no owning component\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'check.mjs'),
      'export function check(ctx) { void ctx.node.id; return []; }\n',
    );
    writeFileSync(path.join(root, 'src', 'leafy', 'a.ts'), 'export const a = 1;\n');

    const graph = await loadGraph(root);
    const fill = await runFill(graph, { coverageVisibleFiles: ['src/leafy/a.ts'], write: () => {} });

    // The row this run's OWN fill attempt discovered — the ground truth
    // `renderTypeVisibilityBlock` below reads to name the reason.
    expect(fill.checkResult.typeVisibility?.rows).toContainEqual({
      file: 'src/leafy/a.ts',
      aspectId: 'touches-ctx-node',
      reason: 'node-context-required',
    });

    const rendered = renderTypeVisibilityBlock(fill.checkResult);
    expect(rendered).toMatch(/Enforced: touches-ctx-node \(1, 1 cannot run — it needs component context/);
    expect(rendered).not.toContain('1 unverified');

    // A LATER, separate `yg check` (this same process, but no fill — the
    // no-write, fail-closed contract means the lock still holds no entry) has
    // nothing to hand off: the report degrades to the ORIGINAL qualified
    // wording rather than claiming the disposition is still known.
    const graph2 = await loadGraph(root);
    const plain = await runCheck(graph2, ['src/leafy/a.ts']);
    expect(plain.typeVisibility?.rows).toEqual([]);
    const renderedPlain = renderTypeVisibilityBlock(plain);
    expect(renderedPlain).toContain('Enforced: touches-ctx-node (1, 1 unverified)');
    expect(renderedPlain).not.toContain('cannot run');
  });

  it('a componented pair\'s runtime error never leaks into the type-visibility report — the handoff is nodeless-only', async () => {
    // Combines the SAME nodeless disposition above with an ordinary, real
    // component ('svc') whose own det aspect independently hits
    // STRUCTURE_UNDECLARED_FS_READ (the other classifiable disposition) by
    // reading a path outside its allowed reads. core/type-visibility.ts exists
    // ONLY for component-free files; a component's own runtime disposition
    // must never be translated into a TypeVisibilityRow (there is no "file"
    // in that report's sense to attribute it to) — proven by checking that
    // ONLY the nodeless row is ever collected, never the componented one, even
    // though both hit a code core/type-visibility.ts's translator recognizes.
    const root = mkdtempSync(path.join(tmpdir(), 'yg-handoff-guard-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'touches-ctx-node'), { recursive: true });
    mkdirSync(path.join(yggRoot, 'aspects', 'reads-undeclared'), { recursive: true });
    mkdirSync(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'leafy'), { recursive: true });
    writeFileSync(
      path.join(yggRoot, 'yg-config.yaml'),
      `${V5_REVIEWER_CONFIG}\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n`,
    );
    writeFileSync(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  leafy:\n    description: x\n    when:\n      path: "src/leafy/**"\n    aspects:\n      - touches-ctx-node\n  service:\n    description: s\n    log_required: false\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'yg-aspect.yaml'),
      'name: touches-ctx-node\ndescription: touches ctx.node on a file with no owning component\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'check.mjs'),
      'export function check(ctx) { void ctx.node.id; return []; }\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'reads-undeclared', 'yg-aspect.yaml'),
      'name: reads-undeclared\ndescription: reads a path outside its allowance\nreviewer:\n  type: deterministic\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'reads-undeclared', 'check.mjs'),
      'export function check(ctx) { ctx.fs.read("src/nowhere.ts"); return []; }\n',
    );
    writeFileSync(path.join(root, 'src', 'leafy', 'a.ts'), 'export const a = 1;\n');
    mkdirSync(path.join(root, 'src', 'svc'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'svc', 'index.ts'), 'export const s = 1;\n');
    writeFileSync(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc/index.ts\naspects:\n  - reads-undeclared\n',
    );

    const graph = await loadGraph(root);
    const fill = await runFill(graph, { coverageVisibleFiles: ['src/leafy/a.ts', 'src/svc/index.ts'], write: () => {} });

    // Both pairs really did runtime-error (sanity: the componented one is not
    // silently skipped for some unrelated reason).
    expect(fill.runtimeErrors).toBe(2);

    // Only the nodeless (component-free) row was ever translated.
    expect(fill.checkResult.typeVisibility?.rows).toEqual([
      { file: 'src/leafy/a.ts', aspectId: 'touches-ctx-node', reason: 'node-context-required' },
    ]);
  });
});
