import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, REFERENCE_BRANCH, type ProgressiveFixture } from '../../support/progressive-fixture.js';
import { runGitFixture } from '../../support/git-fixture.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildFileContextData } from '../../../src/core/context-builder.js';
import { composeBriefExtras, computeScopeMarking } from '../../../src/cli/build-context.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import type { UnreadableSubject } from '../../../src/core/pairs.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

// ---------------------------------------------------------------------------
// Progressive-mode scope marking on `yg context --file` (D2, D3, D6): the
// (yours)/(inherited) suffixes on each rule and the "your change so far: N
// file(s); this file is in/not in it" header, in both the compact view and
// the full view, plus the two honest fallbacks — no reference configured
// (silence) and a reference that cannot be resolved (a stderr notice, no
// marking).
//
// Driven over real throwaway git repositories via `createProgressiveFixture`,
// the same fixture family `tests/e2e/cli-progressive-gate.test.ts` uses:
// `resolveChangeScope` shells to git directly, so there is no injection seam
// to fabricate a measurement through, and hand-building a `BurnSet` (as
// `tests/unit/core/check-progressive.test.ts`'s `burn()` helper does for
// direct `pairIsInScope` calls) cannot be threaded through the CLI.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const fixtures: ProgressiveFixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A type-level fixture (no owning component) with a committed progressive
 * reference, for pinning the SECOND aspect-header suffix site
 * (`context-file.ts:96`, the type-covered one) — unreachable from
 * `createProgressiveFixture`, which builds only component-owned files.
 *
 * `copyTypeLevelFixture` (Task 5's own helper, local to
 * `build-context-brief.test.ts`) cannot be imported here, so this inlines the
 * same copy call it makes, then appends `progressive: reference: <branch>` to
 * the copied config and commits it with `git init` / `checkout -b work` /
 * one edit, the same shape `branchWithEdit` gives a component fixture.
 */
function createTypeLevelProgressiveFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-progressive-typecov-'));
  cpSync(path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine'), dir, { recursive: true });
  appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), `progressive:\n  reference: ${REFERENCE_BRANCH}\n`, 'utf-8');

  const git = (args: string[]): void => {
    const r = runGitFixture(dir, args);
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
    }
  };
  git(['init', '-q', '-b', REFERENCE_BRANCH]);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-q', '-b', 'work']);
  appendFileSync(path.join(dir, 'src', 'leaf', 'a.ts'), 'export const b = 2;\n', 'utf-8');
  git(['add', '-A']);
  git(['commit', '-qm', 'edit leaf']);
  return dir;
}

describe.skipIf(!distExists)('yg context --file --brief — progressive scope marking', () => {
  it('marks a rule on a file the change touched as yours', () => {
    const f = createProgressiveFixture({ label: 'ctx-in', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const { stdout, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
    expect(status).toBe(0);
    expect(stdout).toContain('your change so far: 1 file; this file is in it');
    expect(stdout).toMatch(/no-todo-comments.*\(yours\)/);
  });

  it('marks a rule on a file the change left alone as inherited', () => {
    const f = createProgressiveFixture({ label: 'ctx-out', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const { stdout } = run(['context', '--file', 'src/beta/beta.ts', '--brief'], f.dir);
    expect(stdout).toContain('this file is not in it');
    expect(stdout).toMatch(/no-todo-comments.*\(inherited\)/);
  });

  it('says nothing about scope when the reference cannot be resolved, and explains why on stderr', () => {
    const f = createProgressiveFixture({ label: 'ctx-unmeasurable', progressiveReference: 'origin/never-fetched' });
    fixtures.push(f);
    const { stdout, stderr, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
    expect(status).toBe(0);
    expect(stdout).not.toContain('your change so far');
    expect(stdout).not.toContain('(yours)');
    expect(stdout).not.toContain('(inherited)');
    expect(stderr).toContain('Notice:');
    expect(stderr).toContain('origin/never-fetched');
  });

  it('adds no scope marking and no notice to a project that named no reference', () => {
    const f = createProgressiveFixture({ label: 'ctx-optout' });   // no progressiveReference
    fixtures.push(f);
    const full = run(['context', '--file', 'src/alpha/alpha.ts'], f.dir);
    expect(full.status).toBe(0);
    expect(full.stdout).not.toContain('(yours)');
    expect(full.stdout).not.toContain('(inherited)');
    expect(full.stdout).not.toContain('your change so far');
    expect(full.stderr).not.toContain('Notice:');
  });

  it('marks a rule in the full view too, without --brief', () => {
    const f = createProgressiveFixture({ label: 'ctx-full-yours', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const { stdout, status } = run(['context', '--file', 'src/alpha/alpha.ts'], f.dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/no-todo-comments.*\(yours\)/);
  });

  it('marks a rule at the type-covered aspect-header site too', () => {
    const dir = createTypeLevelProgressiveFixture();
    try {
      const { stdout, status } = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Owner: type:leaf');
      expect(stdout).toMatch(/\[\w+, unverified\].*\((?:yours|inherited)\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeScopeMarking — in-process yours/inherited mapping', () => {
  it('maps the changed file\'s rule to yours and reports it in the header', async () => {
    const f = createProgressiveFixture({ label: 'ctx-inproc-yours', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const graph = await loadGraph(f.dir);
    const data = buildFileContextData(graph, 'src/alpha/alpha.ts', 'alpha');
    const extras = await composeBriefExtras(graph, 'src/alpha/alpha.ts', data);
    expect(extras.scopeHeaderText).toBe('your change so far: 1 file; this file is in it');
    expect(extras.scopeByAspect?.get('no-todo-comments')).toBe('yours');
  });

  it('maps an untouched file\'s rule to inherited', async () => {
    const f = createProgressiveFixture({ label: 'ctx-inproc-inherited', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const graph = await loadGraph(f.dir);
    const data = buildFileContextData(graph, 'src/beta/beta.ts', 'beta');
    const extras = await composeBriefExtras(graph, 'src/beta/beta.ts', data);
    expect(extras.scopeHeaderText).toBe('your change so far: 1 file; this file is not in it');
    expect(extras.scopeByAspect?.get('no-todo-comments')).toBe('inherited');
  });

  it('returns no marking at all when the enumeration reports an unreadable subject', async () => {
    // Same inputs as the "maps the changed file's rule to yours" case above,
    // but with a non-empty `unreadable` argument — a known-short enumeration
    // must never produce a false (inherited)/(yours) claim, so the whole
    // marking is suppressed: no scopeByAspect, no scopeHeaderText.
    const f = createProgressiveFixture({ label: 'ctx-inproc-unreadable', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const graph = await loadGraph(f.dir);
    const { pairs } = await computeExpectedPairs(graph, {});
    const repoFiles = await walkRepoFiles(f.dir);
    const unreadable: UnreadableSubject[] = [{
      nodePath: 'alpha',
      aspectId: 'no-todo-comments',
      path: 'src/alpha/alpha.ts',
      reason: 'unreadable',
      messageData: { what: 'unreadable', why: 'unreadable', next: 'unreadable' },
    }];
    const marking = await computeScopeMarking(graph, 'src/alpha/alpha.ts', ['no-todo-comments'], pairs, repoFiles, unreadable);
    expect(marking).toEqual({});
  });
});
