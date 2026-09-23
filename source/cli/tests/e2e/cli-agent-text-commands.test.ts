// =============================================================================
// Every command the agent-facing text names must be a command the CLI actually
// registers. `yg prime` and the knowledge topics are what an agent reads before
// it acts; a command they teach that the binary does not have sends the agent
// into an unknown-command error with no pointer onward (a removed command once
// lingered in both for a release after the command itself was gone).
//
// Black-box on purpose: the registered surface is read from the built binary's
// own `--help` output (hidden commands are left out of it, which is exactly
// right — a hidden stub for a removed command must never be taught), and the
// text is read through the same public commands an agent runs. No module under
// source/cli/src/** is imported.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', status: result.status };
}

/** Command names listed under "Commands:" in a commander help screen (minus `help`). */
function listedCommands(helpText: string): string[] {
  const lines = helpText.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Commands:');
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([a-z][a-z-]*)(?:\s|$)/.exec(line);
    if (m && m[1] !== 'help') names.push(m[1]);
  }
  return names;
}

/** The registered surface: top-level command → its subcommands (empty when it has none). */
function registeredSurface(cwd: string): Map<string, Set<string>> {
  const surface = new Map<string, Set<string>>();
  for (const name of listedCommands(run(['--help'], cwd).stdout)) {
    surface.set(name, new Set(listedCommands(run([name, '--help'], cwd).stdout)));
  }
  return surface;
}

/**
 * Every `yg <command> [<subcommand>]` the text names that the surface does not
 * register. The second word is judged only when the command has subcommands
 * AND the word is not an ordinary English word following the command in prose;
 * a flag, a placeholder, or a quoted argument never matches the word pattern.
 */
function unregisteredMentions(text: string, surface: Map<string, Set<string>>): string[] {
  const bad = new Set<string>();
  // `<yg install>` is a placeholder for the install directory, never a command.
  for (const m of text.matchAll(/(?<![\w<-])yg ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
    const [, cmd, sub] = m;
    if (PROSE_SUBJECT_WORDS.has(cmd)) continue;
    const subs = surface.get(cmd);
    if (subs === undefined) {
      bad.add(`yg ${cmd}`);
      continue;
    }
    if (sub !== undefined && subs.size > 0 && !subs.has(sub) && !PROSE_WORDS.has(sub)) {
      bad.add(`yg ${cmd} ${sub}`);
    }
  }
  return [...bad].sort();
}

/** Words that follow the tool's bare name when prose uses it as a subject ("yg never writes …"). */
const PROSE_SUBJECT_WORDS = new Set(['command', 'never', 'cannot', 'defect', 'does', 'is', 'will', 'can', 'itself']);

/** Words that follow a command in running prose ("yg log is …") rather than name a subcommand. */
const PROSE_WORDS = new Set([
  'is', 'are', 'was', 'and', 'or', 'on', 'in', 'to', 'for', 'with', 'from', 'the', 'a', 'an',
  'entries', 'entry', 'command', 'commands', 'gate', 'output', 'run', 'runs', 'itself', 'then',
  'lists', 'shows', 'prints', 'reads', 'writes', 'does', 'never', 'also', 'only', 'history',
]);

describe.skipIf(!distExists)('agent-facing text names only registered commands', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'yg-agent-text-'));
  const surface = registeredSurface(cwd);

  it('reads a non-trivial registered surface from --help', () => {
    expect(surface.has('check')).toBe(true);
    expect(surface.get('log')?.has('add')).toBe(true);
    expect(surface.get('knowledge')?.has('read')).toBe(true);
  });

  it('yg prime names no unregistered command', () => {
    const { stdout, status } = run(['prime'], cwd);
    expect(status).toBe(0);
    expect(unregisteredMentions(stdout, surface)).toEqual([]);
  });

  it('yg prime --digest names no unregistered command', () => {
    const { stdout } = run(['prime', '--digest'], cwd);
    expect(unregisteredMentions(stdout, surface)).toEqual([]);
  });

  it('the knowledge index names no unregistered command in any topic summary', () => {
    const { stdout, status } = run(['knowledge', 'list'], cwd);
    expect(status).toBe(0);
    // The cli-reference summary lists bare command names after its colon.
    const refLine = stdout.split('\n').find((l) => l.trim().startsWith('cli-reference'));
    expect(refLine).toBeDefined();
    const listed = refLine!.slice(refLine!.indexOf(':') + 1).split(',').map((s) => s.trim().split(/\s+/)[0]);
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.filter((name) => !surface.has(name))).toEqual([]);
    expect(unregisteredMentions(stdout, surface)).toEqual([]);
  });

  it('every knowledge topic names no unregistered command', () => {
    const list = run(['knowledge', 'list'], cwd).stdout;
    const topics = [...list.matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map((m) => m[1]);
    expect(topics.length).toBeGreaterThan(10);
    const offenders: Record<string, string[]> = {};
    for (const topic of topics) {
      const bad = unregisteredMentions(run(['knowledge', 'read', topic], cwd).stdout, surface);
      if (bad.length > 0) offenders[topic] = bad;
    }
    expect(offenders).toEqual({});
  });

  it('cleans up', () => {
    rmSync(cwd, { recursive: true, force: true });
  });
});
