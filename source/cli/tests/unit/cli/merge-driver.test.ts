import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { registerMergeDriverCommand } from '../../../src/cli/merge-driver.js';
import { ensureMergeDrivers } from '../../../src/cli/init-scaffold.js';
import { serializeLock } from '../../../src/io/lock-store.js';
import { runGitFixture, gitFixtureEnv, FIXTURE_RM_OPTIONS } from '../../support/git-fixture.js';

/** A process.exit the test intercepted, carrying the code the driver exited with. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run `yg merge-driver` through its registered command, as git does, and return the exit
 * code it ends with: the one it sets, or the one it exits with (a refusal raises its
 * diagnostic through failAndExit).
 */
function runMergeDriver(kind: string, base: string, ours: string, theirs: string, shown: string): number | undefined {
  const program = new Command();
  program.exitOverride();
  registerMergeDriverCommand(program);
  const saved = process.exitCode;
  process.exitCode = undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  try {
    program.parse(['merge-driver', kind, base, ours, theirs, shown], { from: 'user' });
    return typeof process.exitCode === 'number' ? process.exitCode : undefined;
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    throw e;
  } finally {
    exit.mockRestore();
    process.exitCode = saved;
  }
}

const entry = (datetime: string, body: string): string => `## [${datetime}]\n${body}\n`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

describe('yg merge-driver', () => {
  let dir: string;
  let stderrText = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'yg-merge-driver-'));
    stderrText = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrText += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, FIXTURE_RM_OPTIONS);
  });

  function sides(base: string, ours: string, theirs: string): [string, string, string] {
    const files: [string, string, string] = [path.join(dir, 'O'), path.join(dir, 'A'), path.join(dir, 'B')];
    [base, ours, theirs].forEach((text, i) => writeFileSync(files[i], text, 'utf-8'));
    return files;
  }

  it('log: writes the union over ours and exits 0', () => {
    const base = entry(T0, 'shared');
    const [o, a, b] = sides(base, base + entry(T2, 'ours'), base + entry(T1, 'theirs'));
    expect(runMergeDriver('log', o, a, b, 'x/log.md')).toBe(0);
    expect(readFileSync(a, 'utf-8')).toBe(base + entry(T1, 'theirs') + entry(T2, 'ours'));
  });

  it('log: a refusal writes markers over ours, says why, and exits 1', () => {
    const base = entry(T0, 'shared');
    const [o, a, b] = sides(base, entry(T0, 'rewritten'), base + entry(T1, 'theirs'));
    expect(runMergeDriver('log', o, a, b, 'x/log.md')).toBe(1);
    expect(readFileSync(a, 'utf-8')).toMatch(/^<<<<<<< ours$/m);
    expect(stderrText).toContain('merge-driver-refused');
  });

  it('lock: writes the key-wise merge over ours and exits 0', () => {
    const lock = (hash: string): string => serializeLock({ version: 1, verdicts: { a: { 'file:x': { verdict: 'approved', hash } } }, nodes: {} });
    const [o, a, b] = sides(lock('h0'), lock('h0'), lock('h1'));
    expect(runMergeDriver('lock', o, a, b, '.yggdrasil/yg-lock.nondeterministic.json')).toBe(0);
    expect(readFileSync(a, 'utf-8')).toBe(lock('h1'));
  });

  it('lock: a side that does not parse gets git\'s text merge with markers, exit 1', () => {
    const [o, a, b] = sides('{"version":1}\n', 'not json\n', 'other\n');
    expect(runMergeDriver('lock', o, a, b, '.yggdrasil/yg-lock.logs.json')).toBe(1);
    expect(readFileSync(a, 'utf-8')).toMatch(/^<<<<<<< ours$/m);
  });

  it('an unknown kind or an unreadable side falls back to git\'s markers — never ours left alone with exit 0', () => {
    const [o, a, b] = sides('base\n', 'ours\n', 'theirs\n');
    expect(runMergeDriver('what', o, a, b, 'f')).toBe(1);
    expect(readFileSync(a, 'utf-8')).toContain('theirs');
    writeFileSync(a, 'ours\n', 'utf-8');
    // An unreadable side is unexpected: the run tries git's own text merge, then aborts with exit 1 and says why.
    expect(runMergeDriver('log', path.join(dir, 'missing'), a, b, 'f')).toBe(1);
    expect(stderrText).toContain('merge-driver log on f');
  });
});

/**
 * Run `fn` with process.env pinned to one fixture repository (GIT_DIR set to
 * it, every inherited discovery variable scrubbed): ensureMergeDrivers spawns
 * git with the process environment, and a GIT_DIR a pre-commit hook leaked
 * would otherwise point its `git config --local` at the real repository.
 */
async function pinnedTo<T>(fixture: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = gitFixtureEnv(fixture);
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

/**
 * What yg init configures in a fresh clone for the CLI at `cli`: the yg-log
 * driver command from its local git configuration and the post-merge hook.
 */
async function configuredFor(cli: string): Promise<{ logDriver: string; hook: string }> {
  const repo = mkdtempSync(path.join(tmpdir(), 'yg-merge-configured-'));
  try {
    runGitFixture(repo, ['init', '-q']);
    await pinnedTo(repo, () => ensureMergeDrivers(repo, cli));
    const logDriver = runGitFixture(repo, ['config', '--local', 'merge.yg-log.driver']).stdout.trim();
    const hook = readFileSync(path.join(repo, '.git', 'hooks', 'post-merge'), 'utf-8');
    return { logDriver, hook };
  } finally {
    rmSync(repo, FIXTURE_RM_OPTIONS);
  }
}

describe('the merge driver configuration yg init writes', () => {
  it('names the CLI by path and falls back to git merge-file when it is gone', async () => {
    const { logDriver: cmd, hook } = await configuredFor('/opt/yg/dist/bin.js');
    expect(cmd).toContain('[ -f "/opt/yg/dist/bin.js" ]');
    expect(cmd).toContain('node "/opt/yg/dist/bin.js" merge-driver log %O %A %B %P');
    expect(cmd).toContain('else git merge-file -L ours -L base -L theirs %A %O %B; fi');
    expect(hook).toContain('node "/opt/yg/dist/bin.js" log merge-resolve');
  });

  it('gives git\'s text merge with markers when the CLI is there but fails without writing, and keeps a refusal\'s own markers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-merge-command-'));
    try {
      // The command configured for a CLI whose file each run below replaces.
      const cli = path.join(dir, 'a dir with spaces', 'cli.mjs');
      const { logDriver } = await configuredFor(cli.replace(/\\/g, '/'));
      const run = (script: string): { status: number; ours: string } => {
        mkdirSync(path.dirname(cli), { recursive: true });
        writeFileSync(cli, script, 'utf-8');
        const [b, o, t] = ['b', 'o', 't'].map((n) => path.join(dir, n));
        writeFileSync(b, 'line\n', 'utf-8');
        writeFileSync(o, 'ours\n', 'utf-8');
        writeFileSync(t, 'theirs\n', 'utf-8');
        const sq = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;
        // What git does with the configured command: %O %A %B shell-quoted, run by sh.
        const cmd = logDriver.replace(/%O/g, sq(b)).replace(/%A/g, sq(o)).replace(/%B/g, sq(t)).replace(/%P/g, sq('x/log.md'));
        const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf-8' });
        return { status: r.status ?? -1, ours: readFileSync(o, 'utf-8') };
      };
      const crashed = run('process.exit(1);\n');
      expect(crashed.status).toBe(1);
      expect(crashed.ours).toMatch(/^<<<<<<< ours$/m);
      expect(crashed.ours).toContain('theirs');
      const refused = run(`import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[5], '<<<<<<< ours\\nA\\n=======\\nB\\n>>>>>>> theirs\\n');\nprocess.exit(1);\n`);
      expect(refused.status).toBe(1);
      expect(refused.ours).toBe('<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n');
      const clean = run(`import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[5], 'merged\\n');\n`);
      expect(clean).toEqual({ status: 0, ours: 'merged\n' });
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('configures both drivers and the hook, is idempotent, and leaves a foreign hook alone', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'yg-merge-config-'));
    try {
      runGitFixture(repo, ['init', '-q']);
      const cli = path.join(repo, 'bin.js');
      writeFileSync(cli, '', 'utf-8');
      const first = await pinnedTo(repo, () => ensureMergeDrivers(repo, cli));
      expect(first.configured).toEqual(['merge.yg-log.name', 'merge.yg-log.driver', 'merge.yg-lock.name', 'merge.yg-lock.driver', 'hooks/post-merge']);
      expect((await pinnedTo(repo, () => ensureMergeDrivers(repo, cli))).configured).toEqual([]);
      writeFileSync(path.join(repo, '.git', 'hooks', 'post-merge'), '#!/bin/sh\necho mine\n', 'utf-8');
      const foreign = await pinnedTo(repo, () => ensureMergeDrivers(repo, cli));
      expect(foreign.notes.join('\n')).toContain('is not Yggdrasil');
      expect(readFileSync(path.join(repo, '.git', 'hooks', 'post-merge'), 'utf-8')).toContain('echo mine');
    } finally {
      rmSync(repo, FIXTURE_RM_OPTIONS);
    }
  });

  it('does nothing outside a git repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'yg-merge-plain-'));
    try {
      mkdirSync(path.join(plain, 'x'));
      // GIT_DIR pinned to a path with no repository: git finds none, as outside any clone.
      expect(await pinnedTo(plain, () => ensureMergeDrivers(path.join(plain, 'x'), '/opt/bin.js'))).toEqual({ configured: [], notes: [] });
      expect(existsSync(path.join(plain, '.git'))).toBe(false);
    } finally {
      rmSync(plain, FIXTURE_RM_OPTIONS);
    }
  });
});
