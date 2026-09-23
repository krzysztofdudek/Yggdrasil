// =============================================================================
// The golden output corpus: what the CLI says, byte for byte, in a fixed set of
// project states — so every change to how the CLI communicates shows up as a
// reviewable diff of committed files instead of drifting silently.
//
// WHAT IT BUILDS
//   A handful of small, fully local project states (no reviewer is ever
//   contacted: every reviewer endpoint is the reserved, unreachable port 1, and
//   no case records a judgment-rule verdict). Each state is built in its own
//   temp directory, and an ordered list of CLI invocations is run against it.
//   Every invocation's exit code, stdout and stderr land in one text file under
//   tests/fixtures/golden-corpus/<state>/<case>.txt.
//
//   Invocations run IN ORDER on one directory, so a state can record a fill and
//   then read the report that fill left behind — the same sequence a person
//   types.
//
// NORMALISATION
//   Only what cannot be reproduced run to run is rewritten: the temp directory
//   (`<ROOT>`), wall-clock timestamps (`<TIME>`), durations (`<DUR>`), and git
//   object names (`<SHA>`). Runs of per-pair progress lines are sorted, because
//   the order parallel checks FINISH in is not the order they were queued in.
//   Everything else — wording, counts, blank lines, ordering of report blocks —
//   is kept exactly, since that is the thing under review.
//
//   This module imports ONLY Node builtins and the git-fixture helpers — never
//   anything under `src/**` — so the e2e suite reading it stays on the public
//   CLI surface.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGitFixture } from './git-fixture.js';
import { createProgressiveFixture } from './progressive-fixture.js';

/** One CLI invocation recorded into the corpus. */
export interface GoldenCase {
  /** File stem under the state's directory — `<name>.txt`. */
  name: string;
  /** Arguments after `yg`. */
  args: string[];
}

/** One project state and the invocations recorded against it. */
export interface GoldenState {
  name: string;
  /** Build the project; returns its root. */
  build(): string;
  cases: GoldenCase[];
}

/** The reviewer endpoint every state uses: reserved port 1, nothing listens there. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
}

/** Install the agent-rules artifacts, as every real project has after `yg init`. */
function installRules(root: string): void {
  const r = spawnSync('node', [binPath(), 'init', '--upgrade'], { cwd: root, encoding: 'utf-8', env: cliEnv() });
  if (r.status !== 0) throw new Error(`yg init --upgrade failed in ${root}: ${r.stderr}`);
}

function freshDir(label: string): string {
  // realpath: on macOS the temp root is a symlink, and the CLI prints the
  // resolved form — normalisation must match what is actually printed.
  return realpathSync(mkdtempSync(path.join(tmpdir(), `yg-golden-${label}-`)));
}

function gitInit(root: string): void {
  const r = runGitFixture(root, ['init', '-q', '-b', 'main']);
  if (r.status !== 0) throw new Error(`git init failed in ${root}: ${r.stderr}`);
}

function configYaml(extra = ''): string {
  return `version: "6.0.0"
coverage:
  required:
    - src/
  excluded: []
reviewer:
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: test
        endpoint: ${DEAD_ENDPOINT}
${extra}`;
}

const NO_TODO_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({ file: file.path, line: i + 1, column: 0, message: 'TODO marker left in shipped code — move it to the tracker' });
      }
    }
  }
  return violations;
}
`;

const HEADER_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.content.startsWith('//')) {
      violations.push({ file: file.path, line: 1, column: 0, message: 'File does not start with a header comment' });
    }
  }
  return violations;
}
`;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The synthetic service graph: `count` services under one `app` module, each
 * mapping one directory under src/. Rules: `no-todo` (a script, enforced) and
 * `readable-names` (a reviewer rule, enforced — never recorded here, so its
 * pairs stay unverified). `todo` lists the services that ship a TODO.
 */
function serviceGraph(root: string, opts: {
  count: number;
  todo: number[];
  logRequired?: boolean;
  reviewerRule?: boolean;
  brokenRelationFrom?: number;
  uncoveredFile?: boolean;
  longDescriptions?: boolean;
}): void {
  const aspects = ['      - no-todo', ...(opts.reviewerRule !== false ? ['      - readable-names'] : [])];
  write(root, '.yggdrasil/yg-config.yaml', configYaml());
  write(root, '.yggdrasil/yg-architecture.yaml', `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
  service:
    description: 'One service: a directory under src/.'
    when:
      path: "src/svc-*/**"
    log_required: ${opts.logRequired === true ? 'true' : 'false'}
    parents: [module]
    aspects:
${aspects.join('\n')}
    relations:
      uses: [service]
`);
  write(root, '.yggdrasil/aspects/no-todo/yg-aspect.yaml', `name: NoTodo
description: Unfinished work belongs in the tracker, not in shipped code.
reviewer:
  type: deterministic
`);
  write(root, '.yggdrasil/aspects/no-todo/check.mjs', NO_TODO_CHECK);
  if (opts.reviewerRule !== false) {
    write(root, '.yggdrasil/aspects/readable-names/yg-aspect.yaml', `name: ReadableNames
description: Names say what a thing is for.
reviewer:
  type: llm
`);
    write(root, '.yggdrasil/aspects/readable-names/content.md', 'Every exported name says what the thing is for.\n');
  }
  write(root, '.yggdrasil/model/app/yg-node.yaml', `name: App
type: module
description: "The application: every service lives under it."
`);
  for (let i = 1; i <= opts.count; i++) {
    const id = `svc-${pad(i)}`;
    const relations = opts.brokenRelationFrom === i ? '\nrelations:\n  - target: app/svc-99\n    type: uses' : '';
    const description = opts.longDescriptions === true && i % 6 === 1
      ? `Service ${id} handles one slice of the application. It owns its directory under src and nothing else. It depends on no other service today, and a later split may give it one. This sentence exists to make the description long enough to show how a listing treats a description of several sentences.`
      : `Service ${id}.`;
    write(root, `.yggdrasil/model/app/${id}/yg-node.yaml`, `name: ${id}
type: service
description: "${description}"
mapping:
  - src/${id}/${relations}
`);
    const body = opts.todo.includes(i)
      ? `// ${id}\n// TODO: finish this\nexport const value${i} = ${i};\n`
      : `// ${id}\nexport const value${i} = ${i};\n`;
    write(root, `src/${id}/index.ts`, body);
  }
  if (opts.uncoveredFile === true) write(root, 'src/tools/gen.ts', '// generator\nexport const gen = 1;\n');
}

/** Every state the corpus records. */
export const GOLDEN_STATES: GoldenState[] = [
  {
    // A brand-new project: what `yg init` prints and what the first check says.
    name: 'fresh-init',
    build(): string {
      const root = freshDir('fresh');
      gitInit(root);
      write(root, 'src/app.ts', 'export const app = 1;\n');
      return root;
    },
    cases: [
      { name: 'init', args: ['init'] },
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
    ],
  },
  {
    // The 24-service graph: a fill with refusals, then every read-only view of
    // the report it leaves — 24 unverified reviewer pairs, 8 refusals, one
    // broken relation, one unowned file.
    name: 'synthetic-24',
    build(): string {
      const root = freshDir('synthetic');
      gitInit(root);
      serviceGraph(root, { count: 24, todo: [3, 6, 9, 12, 15, 18, 21, 24], brokenRelationFrom: 5, uncoveredFile: true, longDescriptions: true });
      installRules(root);
      return root;
    },
    cases: [
      { name: 'fill-only-deterministic', args: ['check', '--approve', '--only-deterministic'] },
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
      { name: 'check-summary', args: ['check', '--summary'] },
      { name: 'check-top-2', args: ['check', '--top', '2'] },
      { name: 'check-aspect-no-todo', args: ['check', '--aspect', 'no-todo'] },
      { name: 'check-details', args: ['check', '--details'] },
      { name: 'dry-run', args: ['check', '--approve', '--dry-run'] },
      { name: 'tree', args: ['tree'] },
      { name: 'tree-long', args: ['tree', '--long', '--depth', '1'] },
      { name: 'tree-json', args: ['tree', '--json', '--root', 'app/svc-01'] },
      { name: 'owner-json', args: ['owner', '--file', 'src/svc-01/index.ts', '--json'] },
      { name: 'find-json', args: ['find', 'svc-07', '--json'] },
      { name: 'log-read-json', args: ['log', 'read', '--node', 'app/svc-01', '--json'] },
      { name: 'advise', args: ['advise'] },
      { name: 'advise-json', args: ['advise', '--json'] },
    ],
  },
  {
    // The mandatory-log gate: 24 services whose type requires a log entry, none
    // written — the recording run stops before recording anything.
    name: 'log-gate',
    build(): string {
      const root = freshDir('loggate');
      gitInit(root);
      serviceGraph(root, { count: 24, todo: [], logRequired: true, reviewerRule: false });
      installRules(root);
      return root;
    },
    cases: [
      { name: 'fill-only-deterministic', args: ['check', '--approve', '--only-deterministic'] },
      { name: 'fill-only-deterministic-json', args: ['check', '--approve', '--only-deterministic', '--json'] },
      { name: 'check', args: ['check'] },
    ],
  },
  {
    // A node file that does not parse, referenced by a flow: the cascade.
    name: 'cascade',
    build(): string {
      const root = freshDir('cascade');
      gitInit(root);
      serviceGraph(root, { count: 3, todo: [], reviewerRule: false });
      write(root, '.yggdrasil/flows/checkout/yg-flow.yaml', `name: Checkout
description: Buying something.
nodes:
  - app/svc-01
  - app/svc-02
`);
      appendFileSync(path.join(root, '.yggdrasil/model/app/svc-02/yg-node.yaml'), 'bad: [unclosed\n');
      installRules(root);
      return root;
    },
    cases: [
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
    ],
  },
  {
    // yg-config.yaml does not parse: the whole run falls back to defaults.
    name: 'config-invalid',
    build(): string {
      const root = freshDir('configinvalid');
      gitInit(root);
      serviceGraph(root, { count: 3, todo: [2], reviewerRule: false, uncoveredFile: true });
      installRules(root);
      appendFileSync(path.join(root, '.yggdrasil/yg-config.yaml'), 'quality: [\n');
      return root;
    },
    cases: [
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
    ],
  },
  {
    // Progressive mode: a branch that touches one component, with a standing
    // refusal on another it never touched.
    name: 'progressive',
    build(): string {
      const fx = createProgressiveFixture({ label: 'golden', progressiveReference: 'main', extraComponents: ['gamma'] });
      const r = spawnSync('node', [binPath(), 'check', '--approve', '--only-deterministic', '--full'], { cwd: fx.dir, encoding: 'utf-8', env: cliEnv() });
      if (r.status === null) throw new Error('progressive setup fill did not run');
      fx.branchWithEdit('feature', 'src/alpha/alpha.ts', '// TODO: new work\nexport const alpha = 1;\n');
      return realpathSync(fx.dir);
    },
    cases: [
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
    ],
  },
  {
    // A type attaches a rule BELOW the rule's own default status.
    name: 'status-downgrade',
    build(): string {
      const root = freshDir('downgrade');
      gitInit(root);
      serviceGraph(root, { count: 4, todo: [], reviewerRule: false });
      write(root, '.yggdrasil/aspects/header-comment/yg-aspect.yaml', `name: HeaderComment
description: Every file starts with a comment saying what it is.
reviewer:
  type: deterministic
`);
      write(root, '.yggdrasil/aspects/header-comment/check.mjs', HEADER_CHECK);
      write(root, '.yggdrasil/yg-architecture.yaml', `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
  service:
    description: 'One service: a directory under src/.'
    when:
      path: "src/svc-*/**"
    parents: [module]
    aspects:
      - no-todo
      - id: header-comment
        status: advisory
    relations:
      uses: [service]
`);
      installRules(root);
      return root;
    },
    cases: [
      { name: 'check', args: ['check'] },
    ],
  },
  {
    // A per-file rule over components that own several files each: one pair
    // per file, never yet recorded.
    name: 'file-scoped',
    build(): string {
      const root = freshDir('filescoped');
      gitInit(root);
      serviceGraph(root, { count: 2, todo: [], reviewerRule: false });
      write(root, '.yggdrasil/aspects/self-contained/yg-aspect.yaml', `name: SelfContained
description: Each file stands on its own.
reviewer:
  type: deterministic
scope:
  per: file
`);
      write(root, '.yggdrasil/aspects/self-contained/check.mjs', 'export function check() { return []; }\n');
      write(root, '.yggdrasil/yg-architecture.yaml', `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
  service:
    description: 'One service: a directory under src/.'
    when:
      path: "src/svc-*/**"
    parents: [module]
    aspects:
      - no-todo
      - self-contained
    relations:
      uses: [service]
`);
      for (const svc of ['svc-01', 'svc-02']) {
        for (const f of ['a', 'b', 'c']) write(root, `src/${svc}/${f}.ts`, `// ${f}\nexport const ${f} = 1;\n`);
      }
      installRules(root);
      return root;
    },
    cases: [
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
    ],
  },
  {
    // What a failing command says, across commands.
    name: 'errors',
    build(): string {
      const root = freshDir('errors');
      gitInit(root);
      serviceGraph(root, { count: 2, todo: [], reviewerRule: false });
      installRules(root);
      return root;
    },
    cases: [
      { name: 'log-add-unknown-node', args: ['log', 'add', '--node', 'nope', '--reason', 'x'] },
      { name: 'log-add-no-reason', args: ['log', 'add', '--node', 'app/svc-01'] },
      { name: 'log-read-unknown-node', args: ['log', 'read', '--node', 'nope'] },
      { name: 'node-unknown', args: ['node', 'nope'] },
      { name: 'impact-unknown-node', args: ['impact', '--node', 'nope'] },
      { name: 'tree-unknown-root', args: ['tree', '--root', 'nope'] },
      { name: 'check-unknown-option', args: ['check', '--message'] },
      { name: 'check-top-0', args: ['check', '--top', '0'] },
      { name: 'check-json-top', args: ['check', '--json', '--top'] },
      { name: 'check-unknown-aspect', args: ['check', '--aspect', 'nope'] },
      { name: 'owner-unknown-file', args: ['owner', '--file', 'nope.ts'] },
      { name: 'node-unknown-json', args: ['node', 'nope', '--json'] },
      { name: 'log-read-unknown-node-json', args: ['log', 'read', '--node', 'nope', '--json'] },
    ],
  },
  {
    // No .yggdrasil/ at all.
    name: 'uninitialised',
    build(): string {
      const root = freshDir('uninit');
      gitInit(root);
      return root;
    },
    cases: [
      { name: 'check', args: ['check'] },
      { name: 'check-json', args: ['check', '--json'] },
      { name: 'tree', args: ['tree'] },
    ],
  },
];

/** The compiled CLI the corpus is recorded from. */
export function binPath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist', 'bin.js');
}

/**
 * The environment every invocation runs under: colour off, not in CI, no
 * inherited reviewer credentials — the same bytes on every machine.
 */
export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS', 'YG_DEBUG', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) delete env[k];
  env.COLUMNS = '100';
  return env;
}

/** Run one case and render it as the corpus file text. */
export function recordCase(root: string, c: GoldenCase): string {
  const r = spawnSync('node', [binPath(), ...c.args], { cwd: root, encoding: 'utf-8', env: cliEnv() });
  const out = normalise(r.stdout ?? '', root);
  const err = normalise(r.stderr ?? '', root);
  return `$ yg ${c.args.join(' ')}\nexit: ${String(r.status)}\n--- stdout\n${out}${out.endsWith('\n') || out === '' ? '' : '\n'}--- stderr\n${err}${err.endsWith('\n') || err === '' ? '' : '\n'}`;
}

/** Rewrite everything that legitimately differs run to run; keep the rest exactly. */
export function normalise(text: string, root: string): string {
  let t = text.split(root).join('<ROOT>').split(path.basename(root)).join('<ROOT-NAME>');
  t = t.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<TIME>');
  t = t.replace(/\b\d+(?:\.\d+)?(ms|s)\b(?=[\s,.)"]|$)/g, '<DUR>');
  t = t.replace(/("(?:durationMs|elapsedMs|ms)"\s*:\s*)\d+/g, '$1<DUR>');
  t = t.replace(/\b[0-9a-f]{40}\b/g, '<SHA>');
  // Sort each run of consecutive per-pair progress lines: parallel checks
  // finish in whatever order the machine allows.
  const lines = t.split('\n');
  const outLines: string[] = [];
  let run: string[] = [];
  const flush = (): void => { outLines.push(...run.sort()); run = []; };
  for (const l of lines) {
    if (/^\s*\[(det|llm)\] /.test(l)) run.push(l);
    else { flush(); outLines.push(l); }
  }
  flush();
  return outLines.join('\n');
}

/** Build a state, run its cases in order, clean up; returns case name → text. */
export function recordState(state: GoldenState): Map<string, string> {
  const root = state.build();
  try {
    const out = new Map<string, string>();
    for (const c of state.cases) out.set(c.name, recordCase(root, c));
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
