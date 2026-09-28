// =============================================================================
// CLI E2E — the CLI reference says what the CLI accepts.
//
// The command tree lives in one place, the CLI's own argument parser, and the
// built binary prints it through `--help` (tests/support/cli-help-tree.ts reads
// it back). Every other surface describes that tree by hand. This suite holds
// them to it:
//
//   - docs/cli-reference.md carries, for every command with an option of its
//     own, a flag table rendered from that command's help (between
//     `<!-- flags: yg <command> -->` and `<!-- /flags -->`), and no table for a
//     command the CLI does not have; `npm run cli-reference:update` rewrites
//     the tables, this suite only reads;
//   - every `yg <command> --flag` line quoted on a reference surface — the
//     docs site, the READMEs, the CHANGELOG's unreleased section, every
//     knowledge topic, the operating manual, every schema reference and the
//     help's own option descriptions — names a command the CLI has and a flag
//     that command takes (tests/support/cli-mentions.ts);
//   - every example the help prints runs: each is executed in a project it can
//     run in (tests/fixtures/help-examples, which has exactly the node, file,
//     rule and flow the examples name) and must exit 0 — never refused as a
//     usage error or a command error.
//
// Hermetic: the fixture is copied into temp directories, git is local, no
// reviewer is called (every rule of the fixture is a script rule).
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyFixtureTree } from '../support/fixture-copy.js';
import { FIXTURE_RM_OPTIONS, runGitFixture } from '../support/git-fixture.js';
import {
  BIN_PATH,
  CLI_ROOT,
  DOCS_CLI_REFERENCE,
  HIDDEN_FLAGS,
  REPO_ROOT,
  commandLine,
  commandsWithFlags,
  flagBlocks,
  readHelpTree,
  renderFlagBlock,
  type HelpCommand,
} from '../support/cli-help-tree.js';
import { badMentions, checkCode, type BadMention } from '../support/cli-mentions.js';

const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'help-examples');
const distExists = existsSync(BIN_PATH);

/** The environment a person's shell gives the CLI: no colour, no CI, no leaked git plumbing. */
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS']) delete e[k];
  return e;
}

interface Run { status: number | null; stderr: string; all: string }

function yg(cwd: string, args: string[]): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 90_000, env: env() });
  return { status: r.status, stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** An example's command line as a shell splits it: words, a quoted string as one word. */
function argv(command: string): string[] {
  return (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/, '$2')).slice(1);
}

/** The files and directories a reference surface is, relative to the repository root. */
function markdownSurfaces(): string[] {
  const docs = readdirSync(path.join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
  const examples = readdirSync(path.join(REPO_ROOT, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(REPO_ROOT, 'examples', d.name, 'README.md')))
    .map((d) => `examples/${d.name}/README.md`);
  return [...docs, 'README.md', 'source/cli/README.md', ...examples];
}

/** The CHANGELOG's unreleased section: a released section may name a flag a later release removed. */
function unreleasedChangelog(): string {
  const text = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
  const start = text.indexOf('## [Unreleased]');
  if (start < 0) return '';
  const end = text.indexOf('\n## [', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The names a `yg knowledge list` / `yg schemas list` prints, one per indented line. */
function listed(out: string): string[] {
  return out.split('\n').map((l) => /^ {2}([a-z][\w-]*)\s{2,}/.exec(l)?.[1]).filter((n): n is string => n !== undefined);
}

function report(bad: BadMention[]): string {
  return bad.map((b) => `  ${b.where}:${b.line}  ${b.problem}  —  ${b.quoted.slice(0, 160)}`).join('\n');
}

describe.skipIf(!distExists)('CLI E2E — the CLI reference matches the CLI', () => {
  let tree: HelpCommand[];
  beforeAll(async () => {
    tree = await readHelpTree();
  }, 60_000);

  it('walks the whole tree: every command the root help groups, and their subcommands', () => {
    const paths = tree.map((c) => c.path.join(' '));
    for (const p of ['check', 'context', 'log add', 'log read', 'pack update', 'drill add', 'marketplace check']) expect(paths).toContain(p);
    expect(tree.find((c) => c.path.join(' ') === 'check')!.options.map((o) => o.long)).toContain('--only-deterministic');
  });

  it('docs/cli-reference.md carries, for every command with a flag, its flag table rendered from its help', () => {
    const page = readFileSync(DOCS_CLI_REFERENCE, 'utf-8');
    const blocks = new Map(flagBlocks(page).map((b) => [b.command, b.text]));
    const missing: string[] = [];
    const stale: string[] = [];
    for (const cmd of commandsWithFlags(tree)) {
      const block = blocks.get(commandLine(cmd));
      if (block === undefined) missing.push(commandLine(cmd));
      else if (block !== renderFlagBlock(cmd)) stale.push(commandLine(cmd));
    }
    expect(missing, 'a command with flags has no flag table on docs/cli-reference.md — add `<!-- flags: yg <command> -->` and `<!-- /flags -->` where its section should show it, then run npm run cli-reference:update in source/cli').toEqual([]);
    expect(stale, 'a flag table differs from the help it is rendered from — run npm run cli-reference:update in source/cli').toEqual([]);
  });

  it('no flag table names a command the CLI does not have, or one twice', () => {
    const known = new Set(commandsWithFlags(tree).map(commandLine));
    const tables = flagBlocks(readFileSync(DOCS_CLI_REFERENCE, 'utf-8')).map((b) => b.command);
    expect(tables.filter((c) => !known.has(c)), 'a flag table for a command with no flags, or no such command').toEqual([]);
    expect(tables.filter((c, i) => tables.indexOf(c) !== i), 'a command with two flag tables').toEqual([]);
  });

  it('every `yg <command> --flag` quoted on a reference surface names a flag that command takes', () => {
    const bad: BadMention[] = [];
    for (const rel of markdownSurfaces()) bad.push(...badMentions(rel, readFileSync(path.join(REPO_ROOT, rel), 'utf-8'), tree));
    bad.push(...badMentions('CHANGELOG.md [Unreleased]', unreleasedChangelog(), tree));
    const cwd = mkdtempSync(path.join(tmpdir(), 'yg-reference-truth-'));
    try {
      const topics = listed(yg(cwd, ['knowledge', 'list']).all);
      expect(topics).toContain('cli-reference');
      for (const t of topics) bad.push(...badMentions(`yg knowledge read ${t}`, yg(cwd, ['knowledge', 'read', t]).all, tree));
      bad.push(...badMentions('yg prime', yg(cwd, ['prime']).all, tree));
      const schemas = listed(yg(cwd, ['schemas', 'list']).all);
      expect(schemas).toContain('config');
      for (const s of schemas) bad.push(...badMentions(`yg schemas read ${s}`, yg(cwd, ['schemas', 'read', s]).all, tree));
    } finally {
      rmSync(cwd, FIXTURE_RM_OPTIONS);
    }
    for (const cmd of tree) {
      for (const o of cmd.options) {
        for (const problem of checkCode(o.description, tree)) bad.push({ where: `${commandLine(cmd)} --help`, line: 0, quoted: `${o.term}  ${o.description}`, problem });
      }
    }
    expect(bad, `a quoted command line names a flag its command does not take:\n${report(bad)}`).toEqual([]);
  }, 120_000);

  it('the mention reader catches a wrong flag and reads the pages\' shorthands as meant', () => {
    expect(checkCode('yg check --approve --only-deterministic', tree)).toEqual([]);
    expect(checkCode('yg check --aprove', tree)).toEqual(['yg check has no --aprove']);
    expect(checkCode('yg log read --aspect no-todo --json', tree)).toEqual([]);
    expect(checkCode('yg log add|read --aspect', tree)).toEqual([]);
    expect(checkCode('yg log add|merge-resolve --aspect', tree)).toEqual(['yg log merge-resolve has no --aspect']);
    expect(checkCode('yg log --aspect <id>', tree)).toEqual([]);
    expect(checkCode('yg check --json | jq .totals --raw-output', tree)).toEqual([]);
    expect(badMentions('x.md', 'The flag `yg impact --simulate` was removed.', tree)).toEqual([]);
    // The removal marker exempts its own sentence, not every command the paragraph quotes.
    expect(badMentions('x.md', 'The flag `yg impact --simulate` was removed. Run `yg check --aprove` next.', tree).map((b) => b.problem)).toEqual(['yg check has no --aprove']);
  });

  it('every hidden flag a page may name is one its command accepts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-reference-hidden-'));
    try {
      copyFixtureTree(FIXTURE, dir);
      for (const [command, flags] of Object.entries(HIDDEN_FLAGS)) {
        for (const { flag } of flags) {
          const out = yg(dir, [...argv(command), flag]);
          expect(out.all, `${command} ${flag}`).not.toMatch(/error\[usage\]|unknown option/);
          expect(out.status, `${command} ${flag}\n${out.all}`).toBe(0);
        }
      }
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('every example the help prints runs, in a project that has what it names', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'yg-help-examples-'));
    try {
      // The project the examples name: node app/orders owning src/a.ts, rule no-todo, flow checkout.
      const repo = path.join(work, 'repo');
      copyFixtureTree(FIXTURE, repo);
      runGitFixture(repo, ['init', '-q']);
      expect(yg(repo, ['init', '--upgrade']).status).toBe(0);
      runGitFixture(repo, ['add', '-A']);
      runGitFixture(repo, ['commit', '-q', '-m', 'the project the help examples name']);
      expect(yg(repo, ['check', '--approve', '--only-deterministic']).status).toBe(0);

      // `yg init` starts a graph where there is none.
      const fresh = path.join(work, 'fresh');
      mkdirSync(fresh);
      runGitFixture(fresh, ['init', '-q']);

      // `yg adopt ../proposal`: the same graph, proposed to the same code without one.
      const adoptInto = path.join(work, 'adopt');
      copyFixtureTree(path.join(FIXTURE, 'src'), path.join(adoptInto, 'src'));
      copyFixtureTree(path.join(FIXTURE, '.yggdrasil'), path.join(work, 'proposal', '.yggdrasil'));
      runGitFixture(adoptInto, ['init', '-q']);
      runGitFixture(adoptInto, ['add', '-A']);
      runGitFixture(adoptInto, ['commit', '-q', '-m', 'code without a graph']);

      // `yg marketplace check` runs in a marketplace repository.
      const market = path.join(work, 'market');
      copyFixtureTree(path.join(CLI_ROOT, 'tests', 'fixtures', 'marketplace-demo'), market);
      runGitFixture(market, ['init', '-q']);
      runGitFixture(market, ['add', '-A']);
      runGitFixture(market, ['commit', '-q', '-m', 'a marketplace']);

      // `yg merge-driver log %O %A %B %P`: git's three versions of one log, each side adding an entry.
      const log = path.join(repo, '.yggdrasil', 'model', 'app', 'orders', 'log.md');
      const sides = path.join(work, 'sides');
      mkdirSync(sides);
      expect(yg(repo, ['log', 'add', '--node', 'app/orders', '--reason', 'The base entry.']).status).toBe(0);
      copyFileSync(log, path.join(sides, 'base.md'));
      expect(yg(repo, ['log', 'add', '--node', 'app/orders', '--reason', 'Ours.']).status).toBe(0);
      copyFileSync(log, path.join(sides, 'ours.md'));
      copyFileSync(path.join(sides, 'base.md'), log);
      expect(yg(repo, ['log', 'add', '--node', 'app/orders', '--reason', 'Theirs.']).status).toBe(0);
      copyFileSync(log, path.join(sides, 'theirs.md'));
      copyFileSync(path.join(sides, 'base.md'), log);

      const placeholders: Record<string, string> = {
        '%O': path.join(sides, 'base.md'),
        '%A': path.join(sides, 'ours.md'),
        '%B': path.join(sides, 'theirs.md'),
        '%P': '.yggdrasil/model/app/orders/log.md',
      };
      const where = (words: string[]): string => {
        if (words[0] === 'init' && words.length === 1) return fresh;
        if (words[0] === 'adopt') return adoptInto;
        if (words[0] === 'marketplace') return market;
        return repo;
      };

      const examples = tree.flatMap((c) => c.examples.map((e) => e.command));
      expect(examples.length).toBeGreaterThan(30);
      const failed: string[] = [];
      for (const example of [...new Set(examples)]) {
        const words = argv(example).map((w) => placeholders[w] ?? w);
        const cwd = where(words);
        const out = words[0] === 'portal' ? await serves(cwd, words) : yg(cwd, words);
        // A refusal is written to stderr; a command that prints reference text (knowledge, prime) may quote one on stdout.
        const refused = /error\[(?:usage|command-error)\]|unknown option|unknown command|missing required argument/i.test(out.stderr);
        if (out.status !== 0 || refused) failed.push(`${example}  (exit ${out.status})\n${out.all.split('\n').slice(0, 4).map((l) => `      ${l}`).join('\n')}`);
      }
      expect(failed, `a help example does not run:\n${failed.join('\n')}`).toEqual([]);
    } finally {
      rmSync(work, FIXTURE_RM_OPTIONS);
    }
  }, 240_000);
});

/**
 * Run a command that serves until stopped (`yg portal`): it ran when it says
 * where it serves; it is stopped then. A port another process holds is the
 * machine's, not the example's.
 */
function serves(cwd: string, words: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...words], { cwd, env: env() });
    let all = '';
    let stderr = '';
    const done = (status: number | null): void => {
      clearTimeout(timer);
      resolve({ status, stderr, all });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 20_000);
    const read = (chunk: Buffer): void => {
      all += chunk.toString();
      if (/running at http:\/\/|EADDRINUSE|already in use/i.test(all)) {
        child.kill();
        done(0);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      read(chunk);
    });
    child.on('exit', (code) => done(code));
  });
}
