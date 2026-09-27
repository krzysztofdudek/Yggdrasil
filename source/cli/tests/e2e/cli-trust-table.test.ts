// =============================================================================
// CLI E2E — the trust table in docs/the-lock.md ("Some commands execute code
// from the repository"), backed row by row.
//
// A security table is only worth what its rows are: an adopter decides from it
// which command a CI job on an untrusted branch may run. So every row is run
// here against one project whose rules leave evidence of each thing the table
// talks about:
//   - check.mjs      appends "check" to a marker file whenever it runs;
//   - companion.mjs  appends "companion" to the same file whenever it runs;
//   - the reviewer   is an in-process mock that counts the prompts it is sent
//                    (a prompt carries the reviewed source).
// Each row states what the command does to all three, and the test asserts
// exactly that — a command that starts or stops running repository code, or
// starts sending source to a reviewer, fails here before the table can lie.
//
// HERMETIC: a fresh mkdtemp project per row, the mock on an ephemeral loopback
// port, the child's environment stripped of CI and every provider key (a row
// that is about CI sets it back explicitly).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { gitFixtureEnv } from '../support/git-fixture.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, type MockReviewer } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const DET = 'marker-script';
const LLM = 'marker-reviewer';
/** A reviewer rule with no companion, attached nowhere: only `yg drill` runs it. */
const LLM_PLAIN = 'plain-reviewer';
const NODE = 'app';
const FILE = 'src/app.ts';

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Write the graph under `<root>/<graphDir>/.yggdrasil` and the source under
 * `<root>/src`. The marker path is written into the rule code itself, so it
 * holds wherever and however the rule is loaded.
 */
function writeGraph(root: string, graphRoot: string, marker: string, endpoint: string, extraConfig = ''): void {
  const y = (rel: string, content: string) => w(graphRoot, path.join('.yggdrasil', rel), content);
  y('yg-config.yaml', `version: "6.0.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: mock
        endpoint: "${endpoint}"
${extraConfig}`);
  y('yg-architecture.yaml', `node_types:
  app:
    description: 'The application code.'
    log_required: false
    when:
      path: "src/**"
    aspects:
      - ${DET}
      - ${LLM}
`);
  y(`model/${NODE}/yg-node.yaml`, `name: App
description: The application code.
type: app
mapping:
  - src/
`);
  y(`aspects/${DET}/yg-aspect.yaml`, `name: MarkerScript
description: A script rule that records every run of its check.mjs.
reviewer:
  type: deterministic
status: enforced
`);
  y(`aspects/${DET}/check.mjs`, `import { appendFileSync } from 'node:fs';
export function check(ctx) {
  void ctx;
  appendFileSync(${JSON.stringify(marker)}, 'check\\n');
  return [];
}
`);
  y(`aspects/${LLM}/yg-aspect.yaml`, `name: MarkerReviewer
description: A reviewer rule whose companion.mjs records every run.
reviewer:
  type: llm
status: enforced
`);
  y(`aspects/${LLM}/content.md`, `# Anything passes\n\nThe file must exist.\n`);
  y(`aspects/${LLM_PLAIN}/yg-aspect.yaml`, `name: PlainReviewer
description: A reviewer rule with no companion, for yg drill.
reviewer:
  type: llm
status: enforced
`);
  y(`aspects/${LLM_PLAIN}/content.md`, `# Anything passes\n\nThe file must exist.\n`);
  y(`aspects/${LLM}/companion.mjs`, `import { appendFileSync } from 'node:fs';
export function companion(ctx) {
  void ctx;
  appendFileSync(${JSON.stringify(marker)}, 'companion\\n');
  return [];
}
`);
  w(root, FILE, 'export const app = 1;\n');
}

interface Project {
  root: string;
  marker: string;
  mock: MockReviewer;
}

async function makeProject(label: string, opts: { extraConfig?: string; asProposal?: boolean } = {}): Promise<Project> {
  const root = mkdtempSync(path.join(tmpdir(), `yg-trust-${label}-`));
  const marker = path.join(root, 'marker.log');
  const mock = await startMockReviewer();
  writeGraph(root, opts.asProposal ? path.join(root, 'proposal') : root, marker, mock.endpoint, opts.extraConfig);
  return { root, marker, mock };
}

/**
 * Run one command to its end. With `serve`, the command is a portal server that
 * never ends by itself: once it prints its address, the page it serves is
 * rendered once (the fresh extraction a browser's first load runs), and the
 * server is stopped.
 */
function run(args: string[], cwd: string, extraEnv: Record<string, string> = {}, serve = false): Promise<{ status: number | null; all: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY']) delete env[k];
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd, env });
    let all = '';
    let served = false;
    const onData = (d: unknown): void => {
      all += String(d);
      const url = serve && !served ? /Portal running at (http:\/\/\S+?)(?:\s|$)/.exec(all)?.[1] : undefined;
      if (url === undefined) return;
      served = true;
      void fetch(`${url}/render`)
        .then((res) => res.text())
        .catch((err: unknown) => { all += `\nrender failed: ${String(err)}\n`; })
        .finally(() => child.kill('SIGTERM'));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (status) => resolve({ status, all }));
  });
}

/** What one command did, in the table's three columns. */
interface Observed {
  checkMjs: boolean;
  companionMjs: boolean;
  sourceToReviewer: boolean;
}

function observe(p: Project): Observed {
  const lines = existsSync(p.marker) ? readFileSync(p.marker, 'utf-8').split('\n') : [];
  return {
    checkMjs: lines.includes('check'),
    companionMjs: lines.includes('companion'),
    sourceToReviewer: p.mock.chatCount() > 0,
  };
}

const NOTHING: Observed = { checkMjs: false, companionMjs: false, sourceToReviewer: false };
const SCRIPT_ONLY: Observed = { checkMjs: true, companionMjs: false, sourceToReviewer: false };
const EVERYTHING: Observed = { checkMjs: true, companionMjs: true, sourceToReviewer: true };

interface Row {
  /** The command and the case it is run in, as the test reports it. */
  name: string;
  /** The table row (1-based) that answers for this case, and the command exactly as that row names it. */
  table: [number, string];
  args: string[];
  expected: Observed;
  extraConfig?: string;
  asProposal?: boolean;
  /** A rule to give one satisfies-* drill case, for the `yg drill` rows. */
  drillCase?: string;
  /** Environment the command runs with, on top of the stripped one (e.g. `CI`). */
  env?: Record<string, string>;
  /** Commit the project to a fresh git repository first — `yg simulate` replays history. */
  git?: boolean;
  /** A served portal: render its page once, then stop it (see run). */
  serve?: boolean;
}

/** Make the project one commit of a fresh git repository, isolated from any user or system git config. */
function commitProject(root: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitFixtureEnv(root, env), stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Trust Table', '-c', 'user.email=trust@example.invalid', 'add', '-A', '.yggdrasil', 'src');
  git('-c', 'user.name=Trust Table', '-c', 'user.email=trust@example.invalid', 'commit', '-q', '-m', 'project');
}

// One entry per command in the table, in the table's order.
const ROWS: Row[] = [
  // Row 1 — read-only commands.
  { name: 'yg check (no auto_approve)', table: [1, 'yg check'], args: ['check'], expected: NOTHING },
  { name: 'yg check --no-approve', table: [1, 'yg check --no-approve'], args: ['check', '--no-approve'], expected: NOTHING },
  { name: 'yg check --approve --dry-run', table: [1, 'yg check --approve --dry-run'], args: ['check', '--approve', '--dry-run'], expected: NOTHING },
  { name: 'yg context', table: [1, 'yg context'], args: ['context', '--node', NODE], expected: NOTHING },
  { name: 'yg owner', table: [1, 'yg owner'], args: ['owner', '--file', FILE], expected: NOTHING },
  { name: 'yg tree', table: [1, 'yg tree'], args: ['tree'], expected: NOTHING },
  { name: 'yg impact', table: [1, 'yg impact'], args: ['impact', '--file', FILE], expected: NOTHING },
  { name: 'yg aspects', table: [1, 'yg aspects'], args: ['aspects'], expected: NOTHING },
  { name: 'yg portal --static', table: [1, 'yg portal --static'], args: ['portal', '--static', '--out', 'portal.html'], expected: NOTHING },
  { name: 'yg portal --no-write', table: [1, 'yg portal --no-write'], args: ['portal', '--no-write', '--port', '0'], expected: NOTHING, serve: true },
  // Row 2 — the free CI step: every check.mjs, nothing else.
  { name: 'yg check --approve --only-deterministic', table: [2, 'yg check --approve --only-deterministic'], args: ['check', '--approve', '--only-deterministic'], expected: SCRIPT_ONLY },
  // Row 3 — the full fill.
  { name: 'yg check --approve', table: [3, 'yg check --approve'], args: ['check', '--approve'], expected: EVERYTHING },
  // Row 2 also — adopt baselines the free verdicts only.
  { name: 'yg adopt', table: [2, 'yg adopt'], args: ['adopt', 'proposal'], expected: SCRIPT_ONLY, asProposal: true },
  // Row 4 — the served portal runs nothing by itself (its Approve button is row 3's fill).
  { name: 'yg portal (served)', table: [4, 'yg portal'], args: ['portal', '--port', '0'], expected: NOTHING, serve: true },
  // Row 5 — the rule under test.
  { name: 'yg aspect-test (script rule)', table: [5, 'yg aspect-test'], args: ['aspect-test', '--aspect', DET, '--node', NODE], expected: SCRIPT_ONLY },
  { name: 'yg aspect-test (reviewer rule)', table: [5, 'yg aspect-test'], args: ['aspect-test', '--aspect', LLM, '--node', NODE], expected: { checkMjs: false, companionMjs: true, sourceToReviewer: true } },
  { name: 'yg drill (script rule)', table: [5, 'yg drill'], args: ['drill', '--aspect', DET], expected: SCRIPT_ONLY, drillCase: DET },
  { name: 'yg drill (reviewer rule)', table: [5, 'yg drill'], args: ['drill', '--aspect', LLM_PLAIN], expected: { checkMjs: false, companionMjs: false, sourceToReviewer: true }, drillCase: LLM_PLAIN },
  // A reviewer rule that ships companion.mjs is recorded unsupported by drill: nothing of it runs.
  { name: 'yg drill (reviewer rule with companion.mjs)', table: [5, 'yg drill'], args: ['drill', '--aspect', LLM], expected: NOTHING, drillCase: LLM },
  // yg simulate replays the candidate script rule in a throwaway clone: it writes nothing here, but runs check.mjs.
  { name: 'yg simulate', table: [5, 'yg simulate'], args: ['simulate', DET, '--node', NODE], expected: SCRIPT_ONLY, git: true },
  // Row 6 — auto_approve turns a bare check into the matching --approve form (outside CI).
  { name: 'bare yg check, auto_approve: deterministic', table: [6, 'yg check'], args: ['check'], expected: SCRIPT_ONLY, extraConfig: 'auto_approve: deterministic\n' },
  { name: 'bare yg check, auto_approve: full', table: [6, 'yg check'], args: ['check'], expected: EVERYTHING, extraConfig: 'auto_approve: full\n' },
  // Under CI a committed `full` is held back — nothing runs; `deterministic` is not held back.
  { name: 'bare yg check under CI, auto_approve: full', table: [6, 'yg check'], args: ['check'], expected: NOTHING, extraConfig: 'auto_approve: full\n', env: { CI: 'true' } },
  { name: 'bare yg check under CI, auto_approve: deterministic', table: [6, 'yg check'], args: ['check'], expected: SCRIPT_ONLY, extraConfig: 'auto_approve: deterministic\n', env: { CI: 'true' } },
  // A triage view never fills, whatever auto_approve says.
  { name: 'yg check --summary, auto_approve: full', table: [6, 'yg check'], args: ['check', '--summary'], expected: NOTHING, extraConfig: 'auto_approve: full\n' },
];

// The read-only rows are also run over a project whose reviewer verdict is on
// record and then went stale: that is the case in which a read used to import
// companion.mjs to measure the prompt.
const STALE_READS = ROWS.filter((r) => r.expected === NOTHING && ['check', 'context', 'impact', 'aspects', 'portal'].includes(r.args[0]));

const THE_LOCK = path.join(__dirname, '..', '..', '..', '..', 'docs', 'the-lock.md');

/** The trust table as docs/the-lock.md prints it: per row, the `yg` commands it names and whether it says they run repository code. */
function tableFromDocs(): Array<{ commands: string[]; runsCode: boolean }> {
  const text = readFileSync(THE_LOCK, 'utf-8');
  const start = text.indexOf('| Command | Executes repository code? |');
  expect(start, 'the trust table heading in docs/the-lock.md').toBeGreaterThanOrEqual(0);
  const rows: Array<{ commands: string[]; runsCode: boolean }> = [];
  for (const line of text.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const [, command, answer] = line.split('|');
    const commands = [...command.matchAll(/`(yg [^`]+)`/g)].map((m) => m[1]);
    const verdict = /^\s*\*\*(Yes|No)\b/.exec(answer)?.[1];
    expect(verdict, `a table row that opens with neither **Yes** nor **No**: ${line}`).toBeDefined();
    rows.push({ commands: [...new Set(commands)], runsCode: verdict === 'Yes' });
  }
  return rows;
}

// The table and the rows above must name the same commands, row for row: a
// command added to the docs without a case here, or a case whose command the
// table no longer lists, fails before anyone reads the table as a promise.
describe('the-lock.md trust table and this suite name the same commands', () => {
  it('every command of every table row has a case here, and every case belongs to a row that names its command', () => {
    const table = tableFromDocs();
    const fromDocs = table.map((r) => r.commands.slice().sort());
    const fromCases = table.map((_, i) => [...new Set(ROWS.filter((r) => r.table[0] === i + 1).map((r) => r.table[1]))].sort());
    expect(fromCases).toEqual(fromDocs);
    expect(ROWS.every((r) => r.table[0] >= 1 && r.table[0] <= table.length)).toBe(true);
  });

  it('a row the table answers "No" runs nothing in any case; a row it answers "Yes" runs something in at least one', () => {
    const table = tableFromDocs();
    table.forEach((row, i) => {
      const cases = ROWS.filter((r) => r.table[0] === i + 1);
      const ranSomething = (r: Row) => r.expected.checkMjs || r.expected.companionMjs || r.expected.sourceToReviewer;
      if (row.runsCode) expect(cases.some(ranSomething), `table row ${i + 1}`).toBe(true);
      else expect(cases.filter(ranSomething).map((r) => r.name), `table row ${i + 1}`).toEqual([]);
    });
  });
});

describe.skipIf(!distExists)('the-lock.md trust table — every row, as the CLI really behaves', () => {
  it.each(ROWS)('$name', async (row) => {
    const p = await makeProject(row.name.replace(/\W+/g, '-').slice(0, 40), { extraConfig: row.extraConfig, asProposal: row.asProposal });
    try {
      if (row.drillCase) w(p.root, `.yggdrasil/aspects/${row.drillCase}/drills/satisfies-plain/ok.ts`, 'export const ok = 1;\n');
      if (row.git) commitProject(p.root);
      const r = await run(row.args, p.root, row.env, row.serve);
      expect(r.all).not.toContain('Unknown command');
      expect(observe(p), `${row.name}\n${r.all}`).toEqual(row.expected);
    } finally {
      await p.mock.close();
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it.each(STALE_READS)('$name, over a stale reviewer verdict', async (row) => {
    const p = await makeProject(`stale-${row.name.replace(/\W+/g, '-').slice(0, 30)}`, { extraConfig: row.extraConfig });
    try {
      expect((await run(['check', '--approve'], p.root)).status).toBe(0);
      writeFileSync(path.join(p.root, FILE), 'export const app = 2;\n', 'utf-8');
      rmSync(p.marker, { force: true });
      const before = p.mock.chatCount();
      const r = await run(row.args, p.root, row.env, row.serve);
      const seen = observe(p);
      expect({ ...seen, sourceToReviewer: p.mock.chatCount() > before }, `${row.name}\n${r.all}`).toEqual(NOTHING);
    } finally {
      await p.mock.close();
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it('yg check --approve --only-deterministic over a stale reviewer verdict runs check.mjs and no companion.mjs', async () => {
    const p = await makeProject('stale-free-ci');
    try {
      expect((await run(['check', '--approve'], p.root)).status).toBe(0);
      writeFileSync(path.join(p.root, FILE), 'export const app = 2;\n', 'utf-8');
      rmSync(p.marker, { force: true });
      const before = p.mock.chatCount();
      const r = await run(['check', '--approve', '--only-deterministic'], p.root);
      expect({ ...observe(p), sourceToReviewer: p.mock.chatCount() > before }, r.all).toEqual(SCRIPT_ONLY);
    } finally {
      await p.mock.close();
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
