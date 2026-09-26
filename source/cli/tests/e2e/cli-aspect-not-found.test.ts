// =============================================================================
// CLI E2E — one aspect-not-found error across every command that takes a rule
// id, on the built binary.
//
// Every command that is handed a rule id the graph does not declare answers the
// same way: exit 1, the code `aspect-not-found`, the one what line
// `rule '<id>' is not in the graph`, and `next: yg aspects` (the command that
// lists every rule id there is). A command that answers in JSON carries the same
// code, what and next in its yg-error/1 document. Only the why differs — it says
// what that command needed the rule for.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete e[k];
  return e;
}

const run = (dir: string, args: string[]) => {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', timeout: 60_000, env: env() });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** One module with one service, one script rule attached by type, all committed. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspect-not-found-'));
  try {
    runGitFixture(dir, ['init', '-q', '-b', 'main']);
    const w = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    };
    w('.yggdrasil/yg-config.yaml', 'version: "6.0.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n');
    w('.yggdrasil/yg-architecture.yaml', "node_types:\n  module:\n    description: 'A module.'\n  service:\n    description: 'A service.'\n    parents: [module]\n    aspects:\n      - no-todo\n");
    w('.yggdrasil/aspects/no-todo/yg-aspect.yaml', 'name: NoTodo\ndescription: No TODO in shipped code.\nreviewer:\n  type: deterministic\n');
    w('.yggdrasil/aspects/no-todo/check.mjs', 'export function check(ctx) { return ctx.files.length < 0 ? [] : []; }\n');
    w('.yggdrasil/model/app/yg-node.yaml', 'name: App\ntype: module\ndescription: "The app."\n');
    w('.yggdrasil/model/app/svc/yg-node.yaml', 'name: Svc\ntype: service\ndescription: "The service."\nmapping:\n  - src/svc/\n');
    w('src/svc/index.ts', 'export const value = 1;\n');
    const init = run(dir, ['init', '--upgrade']);
    if (init.status !== 0) throw new Error(`init --upgrade failed: ${init.stdout}${init.stderr}`);
    runGitFixture(dir, ['add', '-A']);
    runGitFixture(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

const WHAT = "rule 'nope' is not in the graph";

/** Every command that takes a rule id, with that id unknown. `json` marks the ones that answer in JSON. */
const COMMANDS: ReadonlyArray<{ label: string; args: string[]; json: boolean }> = [
  // check's --aspect is a text view that refuses --json, so its text is what is asserted.
  { label: 'yg check --aspect', args: ['check', '--aspect', 'nope'], json: false },
  { label: 'yg impact --aspect', args: ['impact', '--aspect', 'nope'], json: false },
  { label: 'yg aspect-test --aspect', args: ['aspect-test', '--aspect', 'nope', '--node', 'app/svc'], json: false },
  { label: 'yg simulate <id>', args: ['simulate', 'nope', '--node', 'app/svc'], json: false },
  { label: 'yg aspects log add --aspect', args: ['aspects', 'log', 'add', '--aspect', 'nope', '--reason', 'why it changed'], json: false },
  { label: 'yg aspects log read --aspect', args: ['aspects', 'log', 'read', '--aspect', 'nope', '--json'], json: true },
  { label: 'yg drill --aspect', args: ['drill', '--aspect', 'nope', '--json'], json: true },
  { label: 'yg drill add --aspect', args: ['drill', 'add', '--aspect', 'nope', '--violates', 'src/svc/index.ts@HEAD'], json: false },
  { label: 'yg incident add --aspect', args: ['incident', 'add', '--tag', 'wrong-rule', '--aspect', 'nope', '--reason', 'it slipped through'], json: false },
];

describe.skipIf(!distExists)('CLI E2E — one aspect-not-found error for every command that takes a rule id', () => {
  let dir = '';
  beforeAll(() => {
    dir = project();
  }, 90_000);
  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  for (const cmd of COMMANDS) {
    it(`${cmd.label} with an unknown id exits 1 with aspect-not-found, the one what line and next: yg aspects`, () => {
      const r = run(dir, cmd.args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`error[aspect-not-found]: ${WHAT}\n`);
      expect(r.stderr).toContain('next: yg aspects\n');
      if (cmd.json) {
        const doc = JSON.parse(r.stdout) as { schema: string; code: string; what: string; next: { text: string } };
        expect(doc.schema).toBe('yg-error/1');
        expect(doc.code).toBe('aspect-not-found');
        expect(doc.what).toBe(WHAT);
        expect(doc.next.text).toBe('yg aspects');
      }
    }, 90_000);
  }
});
