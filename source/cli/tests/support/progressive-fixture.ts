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
//   Four options shape the harder scenarios: `logRequired` turns on the type's
//   mandatory-log requirement, and `alphaRelatesToBeta` makes `alpha` declare a
//   relation to `beta`. Together they let a test edit BETA's declaration and
//   watch that reach alpha — a component being re-gated without one of its own
//   files being touched. `extraComponents` adds further untouched subjects, and
//   `reviewedAspect` attaches a second enforced rule that only a reviewer can
//   settle — the pair of options a scenario about PAID work needs, since the
//   question there is always "how much of it did this run decide to buy" — and
//   its `perFile` flag makes that rule owe one review per file rather than one
//   per component, which is what lets a scenario put a hidden edit on a file
//   whose own review is not the one under test.
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
  /**
   * Turn ON the type's mandatory-log requirement, so a component whose source
   * moved past the entry its log records is refused until a fresh entry exists.
   *
   * Off by default, and it has to stay that way for every other scenario: with
   * it on, a component that has never recorded an entry blocks the whole
   * verdict-filling step, so a fixture using it must add an entry per component
   * BEFORE the first fill.
   */
  logRequired?: boolean;
  /**
   * Have `alpha` declare a relation to `beta`. Nothing in the source imports
   * anything, so the declaration is inert to every rule here — its only purpose
   * is to give a change to BETA's declaration a documented way to reach alpha,
   * which is how a component can be re-gated without its own files being
   * touched at all.
   */
  alphaRelatesToBeta?: boolean;
  /**
   * Put `auto_approve` in the committed configuration, so a BARE `yg check`
   * records verdicts with no flag typed at all. The shape that matters for
   * progressive mode: the person asks for a plain gate and gets the recording
   * path with no flag typed at all.
   */
  autoApprove?: 'deterministic' | 'full';
  /**
   * Extra components beyond `alpha` and `beta`, one clean file each. They exist
   * for scenarios that need MORE THAN ONE subject a branch does not touch —
   * anything counting what a run left alone needs at least two, or a count of
   * one proves nothing about pluralisation or about summing.
   */
  extraComponents?: string[];
  /**
   * Attach a second ENFORCED rule to the type, judged by a reviewer rather than
   * by a script, and point the tier at `endpoint` — an in-process mock speaking
   * the same wire protocol (tests/e2e/support/mock-reviewer.ts).
   *
   * It is a fixture OPTION rather than an edit a test makes afterwards because
   * the endpoint has to be in the FIRST commit: writing it later would leave the
   * work tree dirty, or put a config edit in the very diff the scenario is
   * measuring. Start the mock, then build the fixture around its address.
   *
   * The rule is deliberately one a clean file PASSES only if the reviewer says
   * so: nothing about it can be decided locally, so a pair of it is unverified
   * until something pays for a review — which is the whole subject of the
   * scoped-fill scenarios.
   */
  /**
   * Attach the free, script-judged rule (`no-todo-comments`) to the type.
   * ON by default — it is what gives `beta` its standing refusal, which is how
   * most scenarios here observe an in-scope / outside split at all.
   *
   * Turned OFF for the scenarios about a component file that is NO rule's review
   * subject. A script-judged rule reviews every file a component maps, binary
   * ones included, so with it attached there is always some rule holding that
   * file — and the question those scenarios ask (what happens when nothing
   * holds it) cannot arise. A component whose only rule is reviewer-judged is an
   * ordinary project, not a contrivance.
   */
  deterministicAspect?: boolean;
  /**
   * The status the script-judged rule is attached at. `enforced` (the default)
   * gives `beta` a standing blocking refusal; `advisory` gives it a standing
   * WARNING instead — a refusal that never blocks and is never re-coded by the
   * change-scope classification, because it was a warning from the start.
   *
   * That second shape is the one a repository adopting a mined graph actually
   * lives with, and it is the only way to observe a finding that stands on
   * untouched code while blocking nothing.
   */
  deterministicAspectStatus?: 'enforced' | 'advisory';
  reviewedAspect?: {
    endpoint: string;
    /**
     * Judge the rule ONCE PER FILE rather than once per component, so a
     * component owning several files owes several separate reviews.
     *
     * The distinction is invisible to most scenarios and decisive for one: only
     * a per-file rule can have a review whose OWN subject did not move while a
     * neighbouring file in the same component did — which is where a scope that
     * re-admits per rule check and one that re-admits per component stop
     * agreeing.
     */
     perFile?: boolean;
    /**
     * Restrict the rule's subject set to source files (`**\/*.ts`), leaving any
     * other file a component maps — a README, a note beside the code — owned by
     * that component and reviewed by nothing.
     *
     * That gap is ordinary, not contrived: a rule written about code says so in
     * its scope. It matters here because a component file that is no rule's
     * subject is exactly where "ask about this rule's files" and "ask about this
     * component's files" stop being the same question.
     */
    sourceFilesOnly?: boolean;
  };
}

export interface ProgressiveFixture {
  /** Absolute path to the repository — also the project root and the git top level. */
  dir: string;
  /** The branch the initial commit lands on. */
  reference: string;
  /** Write `relPath` and commit it on whatever branch is currently checked out. */
  commit(relPath: string, content: string): void;
  /**
   * Commit everything currently in the work tree, gitignored files included, on
   * whatever branch is checked out — for the files a CLI run produced rather
   * than the test (a log entry, the committed halves of the verdict record).
   */
  commitAll(message: string): void;
  /** Check out an existing branch (or the reference) without touching any file. */
  checkout(branch: string): void;
  /** Cut `branch` off the reference, then write and commit `relPath`. */
  branchWithEdit(branch: string, relPath: string, content: string): void;
  /** The declaration file of one component, with `description` substituted in. */
  nodeDeclaration(dir: string, description: string): string;
  /**
   * A SHALLOW checkout of one branch, in its own directory: the CI shape where
   * the reference branch is not merely behind but absent — history truncated to
   * a single commit and no remote-tracking ref for anything else fetched.
   * Returns the new directory; it is removed by {@link ProgressiveFixture.cleanup}
   * along with everything else.
   *
   * Built by fetching rather than cloning on purpose: every git command here
   * stays pinned to a fixture directory (see tests/support/git-fixture.ts), and
   * `git clone` is the one operation that cannot be, since it creates the
   * repository it would be pinned to.
   */
  shallowCheckout(branch: string): string;
  /** Remove the temp directory. Safe to call twice. */
  cleanup(): void;
}

function architecture(logRequired: boolean, reviewed: boolean, deterministic: boolean): string {
  const aspects = [
    ...(deterministic ? ['      - no-todo-comments'] : []),
    ...(reviewed ? ['      - has-doc-comment'] : []),
  ];
  return `node_types:
  service:
    description: 'Discrete service unit'
    log_required: ${logRequired ? 'true' : 'false'}
    when:
      path: "**"
    aspects:
${aspects.join('\n')}
`;
}

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

const aspectYaml = (status: 'enforced' | 'advisory'): string => `name: NoTodoComments
description: Source files must not contain TODO comments — track work in the issue tracker, not the code.
reviewer:
  type: deterministic
status: ${status}
`;

/** The reviewer-judged rule `reviewedAspect` installs, and the prose it judges by. */
function reviewedAspectYaml(opts: NonNullable<ProgressiveFixtureOptions['reviewedAspect']>): string {
  const scope: string[] = [];
  // `per:` is required whenever a scope block exists at all, so it is emitted
  // for either option rather than only for the one that varies it.
  if (opts.perFile === true || opts.sourceFilesOnly === true) {
    scope.push(`  per: ${opts.perFile === true ? 'file' : 'node'}`);
  }
  if (opts.sourceFilesOnly === true) scope.push('  files:', '    path: "**/*.ts"');
  return `name: HasDocComment
description: Every source file must begin with a documentation comment describing the file's purpose.
reviewer:
  type: llm
status: enforced
${scope.length > 0 ? `scope:\n${scope.join('\n')}\n` : ''}`;
}

const REVIEWED_ASPECT_CONTENT = `Every source file must begin with a comment.

The first non-empty line of each source file must be a comment (for example a
\`//\` line comment or a \`/* */\` block comment) that describes what the file does.

A file whose first non-empty line is code — not a comment — violates this rule.
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

function nodeYaml(name: string, dir: string, description: string, relations: string[]): string {
  return `name: ${name}
type: service
description: "${description}"
aspects: []
relations: [${relations.join(', ')}]
mapping:
  - src/${dir}/
`;
}

/** The description each component's declaration ships with on the first commit. */
function defaultDescription(dir: string): string {
  return `The ${dir} service — one file, one rule, nothing else.`;
}

function configYaml(opts: ProgressiveFixtureOptions): string {
  return [
    'version: "5.2.0"',
    ...(opts.autoApprove !== undefined ? [`auto_approve: ${opts.autoApprove}`] : []),
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
    // Reserved port 1 (tcpmux) — guaranteed unreachable. Without a reviewed
    // rule every rule here is deterministic and no reviewer is ever contacted;
    // the endpoint is pinned unreachable purely so a stray LLM pair could never
    // reach a live service. With one, the address is the caller's in-process
    // mock, so the whole reviewer path runs for real against nothing remote.
    `        endpoint: ${opts.reviewedAspect?.endpoint ?? 'http://127.0.0.1:1'}`,
    ...(opts.progressiveReference !== undefined
      ? ['progressive:', `  reference: ${opts.progressiveReference}`]
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

  const withDeterministic = opts.deterministicAspect !== false;
  // The graph directory itself, unconditionally — it used to be created as a
  // side effect of making the script-judged rule's folder, which a fixture that
  // attaches no such rule never reaches.
  mkdirSync(ygg, { recursive: true });
  if (withDeterministic) mkdirSync(path.join(ygg, 'aspects', 'no-todo-comments'), { recursive: true });

  const alphaRelations = opts.alphaRelatesToBeta === true ? ['{ target: beta, type: uses }'] : [];
  const componentName = (dir: string): string => dir.charAt(0).toUpperCase() + dir.slice(1);
  const nodeDeclaration = (dir: string, description: string): string =>
    nodeYaml(componentName(dir), dir, description, dir === 'alpha' ? alphaRelations : []);

  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), architecture(opts.logRequired === true, opts.reviewedAspect !== undefined, withDeterministic), 'utf-8');
  writeFileSync(path.join(ygg, 'yg-config.yaml'), configYaml(opts), 'utf-8');
  writeFileSync(path.join(ygg, '.gitignore'), YGG_GITIGNORE, 'utf-8');
  if (withDeterministic) {
    writeFileSync(path.join(ygg, 'aspects', 'no-todo-comments', 'yg-aspect.yaml'), aspectYaml(opts.deterministicAspectStatus ?? 'enforced'), 'utf-8');
    writeFileSync(path.join(ygg, 'aspects', 'no-todo-comments', 'check.mjs'), CHECK_MJS, 'utf-8');
  }
  if (opts.reviewedAspect !== undefined) {
    mkdirSync(path.join(ygg, 'aspects', 'has-doc-comment'), { recursive: true });
    writeFileSync(path.join(ygg, 'aspects', 'has-doc-comment', 'yg-aspect.yaml'), reviewedAspectYaml(opts.reviewedAspect), 'utf-8');
    writeFileSync(path.join(ygg, 'aspects', 'has-doc-comment', 'content.md'), REVIEWED_ASPECT_CONTENT, 'utf-8');
  }

  // `alpha` is clean; `beta` carries the one pre-existing failure — refused on
  // the reference branch, and never touched by any branch this fixture cuts.
  // Every extra component is clean, like alpha.
  const components: Array<{ dir: string; source: string }> = [
    { dir: 'alpha', source: 'export const alpha = 1;\n' },
    { dir: 'beta', source: '// TODO: this one is meant to stay broken.\nexport const beta = 2;\n' },
    ...(opts.extraComponents ?? []).map((name) => ({ dir: name, source: `export const ${name} = 3;\n` })),
  ];
  for (const { dir: name, source } of components) {
    mkdirSync(path.join(ygg, 'model', name), { recursive: true });
    mkdirSync(path.join(dir, 'src', name), { recursive: true });
    writeFileSync(path.join(ygg, 'model', name, 'yg-node.yaml'), nodeDeclaration(name, defaultDescription(name)), 'utf-8');
    writeFileSync(path.join(dir, 'src', name, `${name}.ts`), source, 'utf-8');
  }

  git(dir, ['init', '-q', '-b', REFERENCE_BRANCH]);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);

  /** Extra directories this fixture created, cleaned up alongside its own. */
  const shallowClones: string[] = [];

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
    nodeDeclaration,
    commitAll(message: string): void {
      // Deliberately NOT forced, unlike `commit` above: this one sweeps the whole
      // work tree, and the local caches a CLI run leaves behind are gitignored
      // precisely because committing them would make every later run dirty the
      // tree — which is exactly the state several progressive rows are about.
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', message]);
    },
    checkout(branch: string): void {
      git(dir, ['checkout', '-q', branch]);
    },
    branchWithEdit(branch: string, relPath: string, content: string): void {
      git(dir, ['checkout', '-q', '-b', branch, REFERENCE_BRANCH]);
      commit(relPath, content);
    },
    shallowCheckout(branch: string): string {
      const shallow = mkdtempSync(path.join(tmpdir(), `yg-progressive-${opts.label}-shallow-`));
      shallowClones.push(shallow);
      git(shallow, ['init', '-q']);
      // A local path as a URL, which is what makes `--depth` meaningful: git
      // takes a shortcut for a plain local path and copies the whole history.
      git(shallow, ['remote', 'add', 'origin', `file://${dir}`]);
      // ONE branch, ONE commit. Nothing else is fetched, so no remote-tracking
      // ref exists for the reference branch — the reference is not behind, it is
      // absent, and the truncated history is why.
      git(shallow, ['fetch', '-q', '--depth', '1', 'origin', `${branch}:${branch}`]);
      git(shallow, ['checkout', '-q', branch]);
      return shallow;
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
      for (const clone of shallowClones.splice(0)) rmSync(clone, { recursive: true, force: true });
    },
  };
}
