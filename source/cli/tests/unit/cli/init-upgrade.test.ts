import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { runVersionUpgrade, ensureGitattributes, ensureYggdrasilGitignore, registerInitCommand } from '../../../src/cli/init.js';

const LOCK_LINE = '/.yggdrasil/yg-lock.*.json linguist-generated=true';
const ADVISE_LINE = '/.yggdrasil/advise-decisions.jsonl merge=union';
const EVENTS_LINE = '/.yggdrasil/yg-events.llm.jsonl merge=union';
const GITIGNORE_LINES = ['yg-secrets.yaml', '.symbols-cache/', '.ast-cache/', '.type-class-cache/', '.debug.log', '.yg-lock.deterministic.json', '.yg-events.jsonl', '.yg-fill-divergence.log*', '.feature-field.json'];

async function scaffoldExistingYgg(projectRoot: string, version: string): Promise<string> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    `version: ${version}\n`,
    'utf-8',
  );
  return yggRoot;
}

/**
 * Drive the ACTUAL registered `yg init` command action for the given args
 * against a real on-disk project root — as opposed to calling an exported
 * helper (e.g. runVersionUpgrade) directly, which bypasses the flag-parsing
 * and dispatch logic inside the command's .action() callback entirely. The
 * action reads process.cwd() internally, so this chdirs for the duration of
 * the call and restores it afterward even on failure.
 */
async function runInitCommand(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  let stdout = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    const program = new Command();
    registerInitCommand(program);
    await program.parseAsync(['node', 'yg', 'init', ...args]);
  } catch (err) {
    // Only swallow the exit shim's own throw; any other error is a real failure.
    if (exitCode === undefined) throw err;
  } finally {
    process.chdir(originalCwd);
    outSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, exitCode };
}

describe('registerInitCommand action — non-interactive dispatch', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('--upgrade alone succeeds and prints the artifact summary', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-cli-upgrade-'));
    dirsToCleanup.push(projectRoot);
    await scaffoldExistingYgg(projectRoot, '5.1.0');

    const { stdout, exitCode } = await runInitCommand(projectRoot, ['--upgrade']);

    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('Agent rules installed/updated');
    // Plain completeness check only — NOT a finding-1 regression guard: this
    // run never passes --provider, so the model/endpoint-required resolver
    // (where finding 1 lived) is never invoked here, and that resolver
    // writes to stderr anyway, which runInitCommand does not capture. The
    // real finding-1 guards live in the resolveReviewerConfigFromFlags tests
    // in init.test.ts.
    expect(stdout).not.toContain('--platform');
    const agentsMd = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- yggdrasil:start -->');
  });

  it('--upgrade --platform codex prints the deprecation notice and still succeeds', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-cli-upgrade-platform-'));
    dirsToCleanup.push(projectRoot);
    await scaffoldExistingYgg(projectRoot, '5.1.0');

    const { stdout, exitCode } = await runInitCommand(projectRoot, ['--upgrade', '--platform', 'codex']);

    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('--platform codex is deprecated and was ignored');
    expect(stdout).toContain('Agent rules installed/updated');
    const agentsMd = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- yggdrasil:start -->');
  });

  it('bare non-interactive fresh init (no flags, no TTY) performs the keyless universal bootstrap', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-cli-fresh-keyless-'));
    dirsToCleanup.push(projectRoot);

    // Force non-TTY deterministically — a locally-run vitest process can have
    // a real TTY on stdout/stdin, which would silently route this into the
    // interactive wizard instead of the path under test.
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    let result: { stdout: string; exitCode: number | undefined };
    try {
      result = await runInitCommand(projectRoot, []);
    } finally {
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('initialized keyless');
    const cfg = await readFile(path.join(projectRoot, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    // Keyless bootstrap writes no reviewer section — the graph works with
    // script rules and dependency control, no judge configured.
    expect(cfg).not.toContain('reviewer:');
    const agentsMd = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- yggdrasil:start -->');
  });

  it('existing repo + deprecated --platform + no TTY refreshes the artifacts without needing --upgrade', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-cli-existing-platform-'));
    dirsToCleanup.push(projectRoot);
    await scaffoldExistingYgg(projectRoot, '5.1.0');

    // Force non-TTY deterministically, same technique as the keyless-fresh-init
    // test above — a locally-run vitest process can have a real TTY on
    // stdout/stdin, which would silently route this into the interactive menu
    // instead of the non-interactive dispatch branch under test.
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    let result: { stdout: string; exitCode: number | undefined };
    try {
      result = await runInitCommand(projectRoot, ['--platform', 'codex']);
    } finally {
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    // No --upgrade and no --provider given, no TTY to open the menu: the
    // deprecated --platform flag alone must still refresh the universal agent
    // rules. Without this dispatch branch the run falls through to the
    // "nothing to do" message instead.
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('--platform codex is deprecated and was ignored');
    expect(result.stdout).toContain('Agent rules installed/updated');
    const agentsMd = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- yggdrasil:start -->');
  });
});

describe('runVersionUpgrade', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('removes schemas/, bumps version, installs the universal agent rules', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    const result = await runVersionUpgrade(projectRoot, yggRoot);

    // installRules writes AGENTS.md (digest block) and CLAUDE.md (@AGENTS.md
    // import) at the project root, and reports both as written this run.
    expect(result.rulesPaths).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
    await expect(stat(path.join(projectRoot, 'AGENTS.md'))).resolves.toBeTruthy();

    const agentsMd = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- yggdrasil:start -->');
    const claudeMd = await readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('@AGENTS.md');

    // The to-5.1.0 migration applies to the 4.0.0 seed: it removes the
    // schemas/ directory. No migration exists between 5.1.0 and the
    // CLI-supported 5.2.0, so the runner's version-lift fallback carries the
    // rest of the way and the runner lands the version at 5.2.0.
    const cfg = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('5.2.0');
    expect(result.migrationActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('schemas'),
      ]),
    );

    // The schemas/ directory is removed by the migration — it is no longer a
    // per-project artifact (schema references live in `yg schemas`).
    await expect(stat(path.join(yggRoot, 'schemas'))).rejects.toThrow();

    // yg-architecture.yaml created if missing
    await expect(stat(path.join(yggRoot, 'yg-architecture.yaml'))).resolves.toBeTruthy();
  });

  it('is a clean no-op when config is already at the supported schema version', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '5.2.0');

    const result = await runVersionUpgrade(projectRoot, yggRoot);

    // Version must stay at 5.2.0 — no write, no false 'Migrated' action.
    const cfg = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('5.2.0');
    expect(result.migrationActions).toHaveLength(0);
    expect(result.migrationWarnings).toHaveLength(0);
    expect(result.withheld).toBe(false);
  });

  it('lifts a 5.1.0 project straight to 5.2.0 with a version-only config diff (no migration exists for this gap)', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-lift-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    const configPath = path.join(yggRoot, 'yg-config.yaml');
    const before = 'version: "5.1.0"\n\nquality:\n  max_direct_relations: 10\n\ncoverage:\n  required: []\n  excluded: []\n';
    await writeFile(configPath, before, 'utf-8');

    const result = await runVersionUpgrade(projectRoot, yggRoot);

    const after = await readFile(configPath, 'utf-8');
    // The registered migration targets 5.1.0 (not strictly greater than the
    // 5.1.0 seed), so no migration applies — the version-lift fallback is the
    // only path that can advance a 5.1.0 project to 5.2.0, and it must touch
    // nothing but the version line.
    expect(after).not.toContain('5.1.0');
    expect(after).toContain('5.2.0');
    expect(after.replace(/^version:.*$/m, 'version: PLACEHOLDER')).toBe(
      before.replace(/^version:.*$/m, 'version: PLACEHOLDER'),
    );
    expect(result.migrationActions.some((a) => a.includes('version updated to 5.2.0'))).toBe(true);
  });

  it('is idempotent: re-running after the artifacts already exist reports nothing written', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    await runVersionUpgrade(projectRoot, yggRoot);
    const second = await runVersionUpgrade(projectRoot, yggRoot);

    expect(second.rulesPaths).toEqual([]);
  });

  it('writes the .gitattributes lock line during upgrade', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    await runVersionUpgrade(projectRoot, yggRoot);

    const ga = await readFile(path.join(projectRoot, '.gitattributes'), 'utf-8');
    expect(ga).toContain(LOCK_LINE);
    expect(ga).toContain(ADVISE_LINE);
  });
});

describe('ensureGitattributes', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('creates .gitattributes with all managed lines when absent', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`${LOCK_LINE}\n${ADVISE_LINE}\n${EVENTS_LINE}\n`);
  });

  it('leaves the file unchanged when all managed lines are already present', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    const original = `* text=auto\n${LOCK_LINE}\n${ADVISE_LINE}\n${EVENTS_LINE}\n`;
    await writeFile(path.join(repoRoot, '.gitattributes'), original, 'utf-8');

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(original);
  });

  it('appends ONLY the missing lines when the file already carries one of them', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    // Existing adopter: has the lock line but not yet the advise / events lines.
    await writeFile(path.join(repoRoot, '.gitattributes'), `* text=auto\n${LOCK_LINE}\n`, 'utf-8');

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`* text=auto\n${LOCK_LINE}\n${ADVISE_LINE}\n${EVENTS_LINE}\n`);
    // The lock line is not duplicated.
    expect(ga.split('\n').filter((l) => l.trim() === LOCK_LINE)).toHaveLength(1);
  });

  it('appends all managed lines exactly once when other content exists (idempotent)', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitattributes'), '* text=auto\n', 'utf-8');

    await ensureGitattributes(repoRoot);
    // Second call must NOT append duplicates.
    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`* text=auto\n${LOCK_LINE}\n${ADVISE_LINE}\n${EVENTS_LINE}\n`);
    expect(ga.split('\n').filter((l) => l.trim() === LOCK_LINE)).toHaveLength(1);
    expect(ga.split('\n').filter((l) => l.trim() === ADVISE_LINE)).toHaveLength(1);
    expect(ga.split('\n').filter((l) => l.trim() === EVENTS_LINE)).toHaveLength(1);
  });

  it('inserts a separating newline when the existing file lacks a trailing one', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitattributes'), '* text=auto', 'utf-8');

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`* text=auto\n${LOCK_LINE}\n${ADVISE_LINE}\n${EVENTS_LINE}\n`);
  });
});

describe('ensureYggdrasilGitignore', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('creates .gitignore with all required lines when absent', async () => {
    const yggRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(yggRoot);

    await ensureYggdrasilGitignore(yggRoot);

    const gi = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(`${GITIGNORE_LINES.join('\n')}\n`);
  });

  it('leaves the file unchanged when every required line is already present', async () => {
    const yggRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(yggRoot);
    const original = `node_modules/\n${GITIGNORE_LINES.join('\n')}\n`;
    await writeFile(path.join(yggRoot, '.gitignore'), original, 'utf-8');

    await ensureYggdrasilGitignore(yggRoot);

    const gi = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(original);
  });

  it('appends only the missing line, preserving other content (idempotent)', async () => {
    const yggRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(yggRoot);
    // File already has a subset (the secrets + cache lines) plus unrelated content.
    await writeFile(
      path.join(yggRoot, '.gitignore'),
      'custom-local-state\nyg-secrets.yaml\n.symbols-cache/\n',
      'utf-8',
    );

    await ensureYggdrasilGitignore(yggRoot);
    // Second call must NOT append a duplicate of anything.
    await ensureYggdrasilGitignore(yggRoot);

    const gi = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    // The missing lines (.ast-cache/, .type-class-cache/, .debug.log, .yg-lock.deterministic.json, .yg-events.jsonl, .yg-fill-divergence.log*, .feature-field.json) were appended once; existing content preserved.
    expect(gi).toBe('custom-local-state\nyg-secrets.yaml\n.symbols-cache/\n.ast-cache/\n.type-class-cache/\n.debug.log\n.yg-lock.deterministic.json\n.yg-events.jsonl\n.yg-fill-divergence.log*\n.feature-field.json\n');
    for (const line of GITIGNORE_LINES) {
      const occurrences = gi.split('\n').filter((l) => l.trim() === line).length;
      expect(occurrences).toBe(1);
    }
  });

  it('is a no-op when all required lines are already present', async () => {
    const yggRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(yggRoot);
    const original = `${GITIGNORE_LINES.join('\n')}\n`;
    await writeFile(path.join(yggRoot, '.gitignore'), original, 'utf-8');

    await ensureYggdrasilGitignore(yggRoot);

    const gi = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(original);
  });

  it('inserts a separating newline when the existing file lacks a trailing one', async () => {
    const yggRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(yggRoot);
    await writeFile(path.join(yggRoot, '.gitignore'), 'node_modules/', 'utf-8');

    await ensureYggdrasilGitignore(yggRoot);

    const gi = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(`node_modules/\n${GITIGNORE_LINES.join('\n')}\n`);
  });
});
