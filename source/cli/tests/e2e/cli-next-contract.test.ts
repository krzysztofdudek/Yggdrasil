// =============================================================================
// CLI E2E — what the release-readiness run found in the Next contract and the
// diagnostics around it (issue 228), on the built binary:
//
//   - `yg context` refuses only over errors that affect that node's context; a
//     repository-wide error it does not depend on (a key in the committed
//     config, no reviewer configured, a rule no node here uses) is named on
//     stderr and the context is given.
//   - config-committed-api-key says the truth per case: a key only typed into
//     the working copy has leaked nowhere; one in HEAD must be revoked.
//   - a symlinked rule directory is refused as a link, never reported as a
//     rule nobody defined.
//   - a run prints one `next:`: the fill's stderr never carries its own.
//   - colour flags work on every command; `--json` on a command without it is
//     never answered with "(Did you mean --reason?)".
//   - `--json --compact`, and a dry-run document whose exit says what the
//     process does.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, symlinkSync, appendFileSync } from 'node:fs';
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
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
};

const REVIEWER = `reviewer:
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: test
        endpoint: http://127.0.0.1:1
`;

/** Two services under one module; a script rule, and optionally a reviewer rule and a reviewer. */
function project(opts: { reviewer?: boolean; judgmentRule?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-contract-'));
  try {
    build(dir, opts);
  } catch (err) {
    // A project that could not be built is removed before the error surfaces.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

function build(dir: string, opts: { reviewer?: boolean; judgmentRule?: boolean }): void {
  runGitFixture(dir, ['init', '-q', '-b', 'main']);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('.yggdrasil/yg-config.yaml', `version: "6.0.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n${opts.reviewer === true ? REVIEWER : ''}`);
  const aspects = ['      - no-todo', ...(opts.judgmentRule === true ? ['      - readable-names'] : [])];
  w('.yggdrasil/yg-architecture.yaml', `node_types:\n  module:\n    description: 'A module.'\n  service:\n    description: 'A service.'\n    when:\n      path: "src/svc-*/**"\n    parents: [module]\n    aspects:\n${aspects.join('\n')}\n`);
  w('.yggdrasil/aspects/no-todo/yg-aspect.yaml', 'name: NoTodo\ndescription: No TODO in shipped code.\nreviewer:\n  type: deterministic\n');
  w('.yggdrasil/aspects/no-todo/check.mjs', 'export function check(ctx) { return ctx.files.length < 0 ? [] : []; }\n');
  if (opts.judgmentRule === true) {
    w('.yggdrasil/aspects/readable-names/yg-aspect.yaml', 'name: ReadableNames\ndescription: Names say what a thing is for.\nreviewer:\n  type: llm\n');
    w('.yggdrasil/aspects/readable-names/content.md', 'Every exported name says what it is for.\n');
  }
  w('.yggdrasil/model/app/yg-node.yaml', 'name: App\ntype: module\ndescription: "The app."\n');
  for (const id of ['svc-01', 'svc-02']) {
    w(`.yggdrasil/model/app/${id}/yg-node.yaml`, `name: ${id}\ntype: service\ndescription: "Service ${id}."\nmapping:\n  - src/${id}/\n`);
    w(`src/${id}/index.ts`, `export const value = 1;\n`);
  }
  const init = run(dir, ['init', '--upgrade']);
  if (init.status !== 0) throw new Error(`init --upgrade failed: ${init.all}`);
}

function commitAll(dir: string): void {
  runGitFixture(dir, ['add', '-A']);
  runGitFixture(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
}

const KEY = '        api_key: sk-ant-FAKE0000000000000000\n';

describe.skipIf(!distExists)('CLI E2E — the Next contract and the diagnostics around it', () => {
  it('context is given over repository-wide errors it does not depend on, and named on stderr', () => {
    const dir = project({ judgmentRule: true });
    try {
      // No reviewer configured for an enforced judgment rule (the keyless mode init --no-reviewer documents).
      const keyless = run(dir, ['context', '--node', 'app/svc-01']);
      expect(keyless.status).toBe(0);
      expect(keyless.stdout).toContain('app/svc-01');
      expect(keyless.stderr).toContain('warning: 1 repository-wide error blocks yg check but not this context: config-reviewer-missing');
      expect(keyless.stderr).not.toContain('next:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a key only typed into the working copy is not called leaked; one in HEAD is — and neither blocks context', () => {
    const dir = project({ reviewer: true });
    try {
      commitAll(dir);
      appendFileSync(path.join(dir, '.yggdrasil/yg-config.yaml'), KEY);
      const local = run(dir, ['check']);
      expect(local.stdout).toContain('in your working copy — not committed yet');
      expect(local.stdout).toContain('before you commit');
      expect(local.stdout).not.toContain('already been exposed');
      expect(run(dir, ['context', '--node', 'app/svc-01']).status).toBe(0);
      commitAll(dir);
      const committed = run(dir, ['check']);
      expect(committed.stdout).toContain('The committed .yggdrasil/yg-config.yaml sets reviewer.tiers.standard.config.api_key');
      expect(committed.stdout).toContain('it has already been exposed to everyone who can read this history');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a symlinked rule directory is refused as a link, never reported as undefined', () => {
    const dir = project();
    try {
      mkdirSync(path.join(dir, 'shared'));
      renameSync(path.join(dir, '.yggdrasil/aspects/no-todo'), path.join(dir, 'shared/no-todo'));
      symlinkSync('../../shared/no-todo', path.join(dir, '.yggdrasil/aspects/no-todo'));
      const out = run(dir, ['check']);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain("error[aspect-source-symlink] Aspect 'no-todo' is built from a symbolic link: .yggdrasil/aspects/no-todo");
      expect(out.stdout).not.toContain('aspect-undefined');
      expect(out.stdout).not.toContain('Create the aspects/no-todo directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a recording run prints one next: — the report\'s, last; the fill says none of its own', () => {
    const dir = project({ judgmentRule: true });
    try {
      const out = run(dir, ['check', '--approve', '--only-deterministic']);
      expect(out.stderr).not.toMatch(/^next: /m);
      expect((out.stdout.match(/^next: /gm) ?? []).length).toBe(1);
      expect(out.stdout).toContain('next: ask the user first: yg init --provider <name> [--model <m>] configures a reviewer, or set the reviewer rules to status: draft');
      expect(out.stdout).not.toContain('need a code or graph fix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a keyless dry run ends on its caveat and names the command that fills, never one that aborts', () => {
    const dir = project({ judgmentRule: true });
    try {
      const out = run(dir, ['check', '--approve', '--dry-run']);
      expect(out.status).toBe(0);
      expect(out.stdout).not.toMatch(/^next: /m);
      expect(out.stdout).toContain('run yg check --approve --only-deterministic to fill the script pairs');
      expect(out.stdout).toContain('a fill would record the script rules');
      const lines = out.stdout.trimEnd().split('\n');
      expect(lines.slice(-1)[0]).toMatch(/^ {2}fix: {2}Ask the user first: yg init --provider <name> \[--model <m>\]/);
      const json = run(dir, ['check', '--approve', '--dry-run', '--json']);
      expect(json.status).toBe(0);
      const doc = JSON.parse(json.stdout);
      expect(doc.exit).toMatchObject({ code: 0, status: 'preview' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('colour flags are accepted on every command, and --json is never "did you mean --reason"', () => {
    const dir = project();
    try {
      expect(run(dir, ['check', '--no-color']).stderr).not.toContain('unknown option');
      expect(run(dir, ['check', '--color=never']).stderr).not.toContain('unknown option');
      expect(run(dir, ['tree', '--color']).status).toBe(0);
      const logJson = run(dir, ['log', 'add', '--node', 'app/svc-01', '--json']);
      expect(logJson.status).toBe(1);
      expect(logJson.stderr).toContain("error[usage]: unknown option '--json' — yg log add does not answer in JSON");
      expect(logJson.all).not.toContain('--reason?');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('--json --compact is the same document without what a reader can recompute; --compact alone is refused', () => {
    const dir = project();
    try {
      run(dir, ['check', '--approve', '--only-deterministic']);
      const full = run(dir, ['check', '--json']);
      const compact = run(dir, ['check', '--json', '--compact']);
      expect(compact.status).toBe(full.status);
      const a = JSON.parse(full.stdout);
      const b = JSON.parse(compact.stdout);
      expect(b.compact).toBe(true);
      expect(b.schema).toBe(a.schema);
      expect(b.totals).toEqual(a.totals);
      expect(b.exit).toEqual(a.exit);
      expect(b.pairs.every((p: { verdict: string }) => p.verdict !== 'approved')).toBe(true);
      expect(a.pairs.some((p: { verdict: string }) => p.verdict === 'approved')).toBe(true);
      expect(compact.stdout.length).toBeLessThan(full.stdout.length);
      const alone = run(dir, ['check', '--compact']);
      expect(alone.status).toBe(1);
      expect(alone.stderr).toContain('error[usage]: --compact requires --json.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('the command tree has one three-word group, the one next: keeps whole (THREE_WORD_GROUPS in check-render-views.ts)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-tree-'));
    try {
      const help = (args: string[]): string => run(dir, [...args, '--help']).stdout;
      const subcommands = (text: string): string[] => {
        const at = text.indexOf('\nCommands:\n');
        if (at < 0) return [];
        return text.slice(at + 11).split('\n\n')[0].split('\n')
          .map((l) => /^ {2}([a-z][a-z-]*)(?: |$)/.exec(l)?.[1])
          .filter((n): n is string => n !== undefined && n !== 'help');
      };
      const root = help([]).split('\nExamples')[0];
      const top = [...root.matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)].map((m) => m[1])
        .concat(/^Setup\n {2}(.+)$/m.exec(root)?.[1].split(' · ') ?? []);
      expect(top).toContain('aspects');
      const groups: string[] = [];
      for (const t of top) {
        for (const sub of subcommands(help([t]))) if (subcommands(help([t, sub])).length > 0) groups.push(`${t} ${sub}`);
      }
      expect(groups).toEqual(['aspects log']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
