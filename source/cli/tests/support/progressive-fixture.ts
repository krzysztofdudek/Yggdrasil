// =============================================================================
// Minimal real Yggdrasil project in a throwaway git repository, for exercising
// anything that measures a change against a committed reference branch.
//
// WHAT IT BUILDS
//   Two component nodes (`alpha`, `beta`), one file each, and one real
//   deterministic rule attached to both by their architecture type — the same
//   shape as the `portal-basic` / `e2e-lifecycle` fixture families, written out
//   here rather than copied so the reference-branch history can be built around
//   it. `src/beta/beta.ts` deliberately ships a TODO, so once the deterministic
//   verdicts are filled the repository holds exactly one PRE-EXISTING failure
//   that no later change touches — which is what makes an in-scope / outside
//   split observable at all. `src/alpha/alpha.ts` is clean.
//
//   The initial commit lands on the reference branch (`main`); `branchWithEdit`
//   then cuts a branch off it and commits one edit, so the change is visible
//   through the COMMITTED half of a diff against the reference while the work
//   tree stays clean.
//
//   Every git operation goes through `tests/support/git-fixture.ts`, so it is
//   pinned to the fixture directory and can never reach this repository's real
//   `.git` — see that module for why that matters inside the pre-commit gate.
//
//   This module imports ONLY Node builtins and the git-fixture helper — never
//   anything under `src/**` — so e2e suites (which must stay on the public CLI
//   surface) can use it freely.
// =============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGitFixture } from './git-fixture.js';

/** The reference branch every fixture's initial commit lands on. */
export const REFERENCE_BRANCH = 'main';

export interface ProgressiveFixtureOptions {
  /** Short label woven into the temp directory name, to keep failures readable. */
  label: string;
  /**
   * When set, the COMMITTED `yg-config.yaml` carries
   * `progressive: { reference: <value> }` from the very first commit.
   *
   * It has to be there from the start rather than added later: the block is
   * itself part of what a scoped run measures, so introducing it ON the branch
   * under test would be a change to the measurement's own terms — which the
   * engine deliberately treats as reaching everything. Committing it to the
   * reference keeps the branch's diff to what the test actually wants to vary.
   */
  progressiveReference?: string;
}

export interface ProgressiveFixture {
  /** Absolute path to the repository — also the project root and the git top level. */
  dir: string;
  /** The branch the initial commit lands on. */
  reference: string;
  /** Write `relPath` and commit it on whatever branch is currently checked out. */
  commit(relPath: string, content: string): void;
  /** Cut `branch` off the reference, then write and commit `relPath`. */
  branchWithEdit(branch: string, relPath: string, content: string): void;
  /** Remove the temp directory. Safe to call twice. */
  cleanup(): void;
}

const ARCHITECTURE = `node_types:
  service:
    description: 'Discrete service unit'
    log_required: false
    when:
      path: "**"
    aspects:
      - no-todo-comments
`;

/**
 * Language-agnostic content scan, no AST import — the fixture stays runnable
 * with nothing resolvable beside it. Same rule as the `e2e-lifecycle` family's
 * `no-todo-comments`: adding a TODO refuses, removing it passes.
 */
const CHECK_MJS = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: 0,
          message: 'TODO comment found — remove it or track the work in the issue tracker.',
        });
      }
    }
  }
  return violations;
}
`;

const ASPECT_YAML = `name: NoTodoComments
description: Source files must not contain TODO comments — track work in the issue tracker, not the code.
reviewer:
  type: deterministic
status: enforced
`;

/**
 * The gitignore `yg init` installs inside `.yggdrasil/`, trimmed to the entries
 * this fixture can actually produce. The deterministic lock is the one that
 * matters: it is a local cache, and leaving it untracked would put an engine
 * output into every `git status` the fixture is read through.
 */
const YGG_GITIGNORE = `yg-secrets.yaml
.ast-cache/
.type-class-cache/
.debug.log
.yg-lock.deterministic.json
.yg-events.jsonl*
.feature-field.json
*.tmp
`;

function nodeYaml(name: string, dir: string): string {
  return `name: ${name}
type: service
description: "The ${dir} service — one file, one rule, nothing else."
aspects: []
relations: []
mapping:
  - src/${dir}/
`;
}

function configYaml(progressiveReference: string | undefined): string {
  return [
    'version: "5.2.0"',
    'coverage:',
    '  required:',
    '    - src/',
    '  excluded: []',
    'reviewer:',
    '  tiers:',
    '    standard:',
    '      provider: ollama',
    '      consensus: 1',
    '      config:',
    '        model: test',
    // Reserved port 1 (tcpmux) — guaranteed unreachable. The only rule here is
    // deterministic, so no reviewer is ever contacted; the endpoint is pinned
    // unreachable purely so a stray LLM pair could never reach a live service.
    '        endpoint: http://127.0.0.1:1',
    ...(progressiveReference !== undefined
      ? ['progressive:', `  reference: ${progressiveReference}`]
      : []),
    '',
  ].join('\n');
}

/** Run a git command in the fixture, throwing with the real stderr on failure. */
function git(dir: string, args: string[]): void {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) {
    // git reports some refusals (an empty commit, most notably) on stdout, so
    // both streams are surfaced — a bare stderr would report the failure with
    // no reason attached at all.
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

export function createProgressiveFixture(opts: ProgressiveFixtureOptions): ProgressiveFixture {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-progressive-${opts.label}-`));
  const ygg = path.join(dir, '.yggdrasil');

  mkdirSync(path.join(ygg, 'aspects', 'no-todo-comments'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'alpha'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'beta'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'alpha'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'beta'), { recursive: true });

  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), ARCHITECTURE, 'utf-8');
  writeFileSync(path.join(ygg, 'yg-config.yaml'), configYaml(opts.progressiveReference), 'utf-8');
  writeFileSync(path.join(ygg, '.gitignore'), YGG_GITIGNORE, 'utf-8');
  writeFileSync(path.join(ygg, 'aspects', 'no-todo-comments', 'yg-aspect.yaml'), ASPECT_YAML, 'utf-8');
  writeFileSync(path.join(ygg, 'aspects', 'no-todo-comments', 'check.mjs'), CHECK_MJS, 'utf-8');
  writeFileSync(path.join(ygg, 'model', 'alpha', 'yg-node.yaml'), nodeYaml('Alpha', 'alpha'), 'utf-8');
  writeFileSync(path.join(ygg, 'model', 'beta', 'yg-node.yaml'), nodeYaml('Beta', 'beta'), 'utf-8');

  writeFileSync(path.join(dir, 'src', 'alpha', 'alpha.ts'), 'export const alpha = 1;\n', 'utf-8');
  // The one pre-existing failure: refused on the reference branch, and never
  // touched by any branch this fixture cuts.
  writeFileSync(
    path.join(dir, 'src', 'beta', 'beta.ts'),
    '// TODO: this one is meant to stay broken.\nexport const beta = 2;\n',
    'utf-8',
  );

  git(dir, ['init', '-q', '-b', REFERENCE_BRANCH]);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);

  const commit = (relPath: string, content: string): void => {
    const target = path.join(dir, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    // `-f` so a path the local gitignore covers (an engine output a test wants
    // committed on purpose) still lands in history rather than being silently
    // skipped, leaving the test asserting against a commit that never happened.
    git(dir, ['add', '-f', '--', relPath]);
    git(dir, ['commit', '-qm', `edit ${relPath}`]);
  };

  return {
    dir,
    reference: REFERENCE_BRANCH,
    commit,
    branchWithEdit(branch: string, relPath: string, content: string): void {
      git(dir, ['checkout', '-q', '-b', branch, REFERENCE_BRANCH]);
      commit(relPath, content);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
