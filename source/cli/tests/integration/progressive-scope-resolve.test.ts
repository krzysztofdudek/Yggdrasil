/**
 * In-process tests for core/progressive-scope-resolve.ts — what a `yg check`
 * run gates against once the project names a reference branch — over real
 * throwaway git repositories (tests/support/progressive-fixture.ts). Each case
 * pins one answer: the silent whole-project gate for a run that never asked for
 * a measurement, a real scope, the whole-project gate a change to the graph's
 * own terms earns (with the notice saying so), and the notices for a state that
 * cannot be measured honestly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { resolveChangeScope, type ChangeScopeDecision } from '../../src/core/progressive-scope-resolve.js';

const fixtures: ProgressiveFixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

function project(label: string, reference?: string): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, ...(reference !== undefined ? { progressiveReference: reference } : {}) });
  fixtures.push(fixture);
  return fixture;
}

async function resolve(dir: string, fullFlag = false): Promise<ChangeScopeDecision> {
  const graph = await loadGraph(dir);
  return resolveChangeScope({ graph, projectRoot: dir, coverageVisibleFiles: await walkRepoFiles(dir), fullFlag });
}

describe('resolveChangeScope', () => {
  it('gates the whole project, silently, when the project names no reference', async () => {
    const f = project('no-ref');
    expect(await resolve(f.dir)).toEqual({ kind: 'whole-project' });
  });

  it('gates the whole project, silently, when the whole project is asked for', async () => {
    const f = project('full', 'main');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    expect(await resolve(f.dir, true)).toEqual({ kind: 'whole-project' });
  });

  it('measures a committed change against the reference: a scope, the reference tree listing, no notice', async () => {
    const f = project('scoped', 'main');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('scoped');
    if (decision.kind !== 'scoped') return;
    expect(decision.referenceName).toBe('main');
    expect(decision.notice).toBeUndefined();
    expect(decision.blobOidByPath).not.toBeNull();
    expect(decision.burn.global).toBe(false);
  });

  it('answers for the whole project, and says why, when the change edits the architecture', async () => {
    const f = project('arch', 'main');
    const archPath = path.join(f.dir, '.yggdrasil', 'yg-architecture.yaml');
    f.branchWithEdit('feature', '.yggdrasil/yg-architecture.yaml', `${readFileSync(archPath, 'utf-8')}# edited\n`);
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('scoped');
    if (decision.kind !== 'scoped') return;
    expect(decision.notice?.what).toContain('This change reaches the whole project');
    expect(decision.notice?.why).toContain('yg-architecture.yaml');
  });

  it('answers for the whole project, and says why, when the change moves what the configuration means', async () => {
    const f = project('config', 'main');
    const configPath = path.join(f.dir, '.yggdrasil', 'yg-config.yaml');
    f.branchWithEdit('feature', '.yggdrasil/yg-config.yaml', readFileSync(configPath, 'utf-8').replace('    - src/\n', '    - src/\n    - lib/\n'));
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('scoped');
    if (decision.kind !== 'scoped') return;
    expect(decision.notice?.why).toContain('yg-config.yaml');
  });

  it('refuses to guess when the reference does not resolve, with a notice naming the cause', async () => {
    const f = project('missing-ref', 'no-such-branch');
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('unmeasurable');
    if (decision.kind !== 'unmeasurable') return;
    expect(decision.notice.what).toContain("could not be measured against 'no-such-branch'");
  });

  it('refuses to guess when the verdict record committed at the reference cannot be read', async () => {
    const f = project('bad-lock', 'main');
    f.commit('.yggdrasil/yg-lock.nondeterministic.json', '{ not json');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('unmeasurable');
    if (decision.kind !== 'unmeasurable') return;
    expect(decision.notice.why).toContain('verdict record committed at the reference could not be read');
  });

  it('refuses to guess when the committed record reads back empty, since an emptied record is not an absent one', async () => {
    const f = project('empty-lock', 'main');
    f.commit('.yggdrasil/yg-lock.nondeterministic.json', '\n');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    expect((await resolve(f.dir)).kind).toBe('unmeasurable');
  });

  it('refuses to guess for a record whose verdicts are not a map of units', async () => {
    const f = project('shape-lock', 'main');
    f.commit('.yggdrasil/yg-lock.nondeterministic.json', JSON.stringify({ verdicts: { rule: ['not', 'a', 'map'] } }));
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    expect((await resolve(f.dir)).kind).toBe('unmeasurable');
  });

  it('measures uncommitted work in the tree along with the commits', async () => {
    const f = project('dirty', 'main');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    writeFileSync(path.join(f.dir, 'src', 'alpha', 'alpha.ts'), 'export const alpha = 3;\n');
    const decision = await resolve(f.dir);
    expect(decision.kind).toBe('scoped');
  });

  it('refuses to guess in a shallow checkout that holds no reference', async () => {
    const f = project('shallow', 'main');
    f.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const shallow = f.shallowCheckout('feature');
    const decision = await resolve(shallow);
    expect(decision.kind).toBe('unmeasurable');
  });
});
