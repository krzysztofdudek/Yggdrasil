// =============================================================================
// The CLI's command tree as its own help prints it, and the flag tables the docs
// render from it.
//
// Commander holds one tree of commands, options and examples, and `--help` is
// the one place the built CLI prints all of it. This module walks that tree
// through the built binary — `yg --help` names the commands, each command's help
// names its options, its subcommands and its examples — so the reference pages
// can be checked against, and their flag tables generated from, what the CLI
// actually accepts rather than what someone remembered it accepts.
//
// It reads only what the binary prints (never anything under src/**), so an e2e
// suite may use it, and the docs update step renders from the same walk the
// guard compares against.
// =============================================================================

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
export const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
export const DOCS_CLI_REFERENCE = path.join(REPO_ROOT, 'docs', 'cli-reference.md');

/** One option as the help lists it. */
export interface HelpOption {
  /** The option column as printed: `-q, --quiet`, `--top [n]`. */
  term: string;
  /** The long flag: `--quiet`. */
  long: string;
  /** The description with its notes: `(required)`, `(default: 20)`. */
  description: string;
}

/** One command of the tree. */
export interface HelpCommand {
  /** The words after `yg`: `['log', 'add']`. */
  path: string[];
  options: HelpOption[];
  subcommands: string[];
  /** The examples block: the command line and what it is for. */
  examples: Array<{ command: string; purpose: string }>;
}

/** Flags every command accepts, which no command's option list names. */
export const GLOBAL_FLAGS = new Set(['--help', '--version', '--color', '--no-color', '--colors', '--no-colors', '--colour', '--no-colour']);

/**
 * Options the CLI accepts but leaves out of its help on purpose, with why: the
 * one list a reference page may name a flag from without the help showing it.
 */
export const HIDDEN_FLAGS: Record<string, Array<{ flag: string; why: string }>> = {
  'yg check': [{ flag: '--attention-dump', why: 'a calibration aid that prints the raw structural measurements; not part of the daily surface' }],
};

/** The environment the help is read in: no colour, a fixed width. */
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  delete e.COLUMNS;
  return e;
}

async function helpText(words: string[]): Promise<string> {
  const { stdout } = await run('node', [BIN_PATH, ...words, '--help'], { env: env(), maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * The sections of a help text: a line at column 0 opens a section named by it
 * (`Options:`, `Commands:`, `Examples`), and its entries are the indented lines
 * up to the next blank line.
 */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      current = null;
      continue;
    }
    if (!line.startsWith(' ')) {
      current = [];
      out.set(line.replace(/:$/, '').trim(), current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

/**
 * The entries of a two-column section: a line indented by two spaces opens an
 * entry (the term, then two or more spaces, then the description); a line
 * indented further continues the description of the entry before it.
 */
function entries(lines: string[]): Array<{ term: string; description: string }> {
  const out: Array<{ term: string; description: string }> = [];
  for (const line of lines) {
    const opening = /^ {2}(\S(?:.*?\S)?)(?: {2,}(\S.*))?$/.exec(line);
    if (opening !== null && !line.startsWith('   ')) {
      out.push({ term: opening[1], description: (opening[2] ?? '').trim() });
    } else if (out.length > 0) {
      const last = out[out.length - 1];
      last.description = `${last.description} ${line.trim()}`.trim();
    }
  }
  return out;
}

/** The command names the root help groups (Daily, Explore, Rules, and the Setup line). */
function rootCommands(text: string): string[] {
  const names: string[] = [];
  for (const [title, lines] of sections(text)) {
    if (title === 'Examples' || title.startsWith('yg ') || title.startsWith('Run ')) continue;
    for (const line of lines) {
      if (line.includes(' · ') || /^ {2}[a-z][\w-]*$/.test(line)) names.push(...line.trim().split(' · '));
      else names.push(line.trim().split(/\s+/)[0]);
    }
  }
  return names;
}

/** One command's help, read into its options, subcommands and examples. */
function parseCommand(words: string[], text: string): HelpCommand {
  const s = sections(text);
  const options = entries(s.get('Options') ?? [])
    .map(({ term, description }) => ({ term, long: /--[\w-]+/.exec(term)?.[0] ?? term, description }))
    .filter((o) => o.long !== '--help');
  const subcommands = entries(s.get('Commands') ?? [])
    .map(({ term }) => term.split(/\s+/)[0])
    .filter((name) => name !== 'help');
  const examples = (s.get('Examples') ?? []).map((line) => {
    const [command, ...rest] = line.trim().split(/ {3,}/);
    return { command: command.trim(), purpose: rest.join(' ').trim() };
  });
  return { path: words, options, subcommands, examples };
}

/**
 * Every command the CLI shows, walked from `yg --help` down through each
 * command's own subcommands, in the order the helps list them. The root itself
 * comes first, with its examples.
 */
export async function readHelpTree(): Promise<HelpCommand[]> {
  if (!existsSync(BIN_PATH)) throw new Error(`${BIN_PATH} does not exist — run npm run build in source/cli first`);
  const rootText = await helpText([]);
  const root: HelpCommand = { ...parseCommand([], rootText), options: [], subcommands: rootCommands(rootText) };
  const out: HelpCommand[] = [root];
  let level: string[][] = root.subcommands.map((name) => [name]);
  while (level.length > 0) {
    const read = await Promise.all(level.map(async (words) => parseCommand(words, await helpText(words))));
    out.push(...read);
    level = read.flatMap((c) => c.subcommands.map((name) => [...c.path, name]));
  }
  return out;
}

/** `yg log add` for `['log', 'add']`. */
export function commandLine(cmd: Pick<HelpCommand, 'path'>): string {
  return ['yg', ...cmd.path].join(' ');
}

// -----------------------------------------------------------------------------
// The flag tables on docs/cli-reference.md.
// -----------------------------------------------------------------------------

/** The opening marker of one command's generated flag table. */
export function flagsStart(cmd: Pick<HelpCommand, 'path'>): string {
  return `<!-- flags: ${commandLine(cmd)} -->`;
}

export const FLAGS_END = '<!-- /flags -->';

/** Every generated flag block on a page: which command it names, and its text from marker to marker. */
export function flagBlocks(page: string): Array<{ command: string; text: string }> {
  const out: Array<{ command: string; text: string }> = [];
  const re = /<!-- flags: (yg[^>]*?) -->[\s\S]*?<!-- \/flags -->/g;
  for (let m = re.exec(page); m !== null; m = re.exec(page)) out.push({ command: m[1], text: m[0] });
  return out;
}

/**
 * Text for a table cell on a VitePress page: a pipe would end the cell, and an
 * angle-bracketed placeholder or a double brace outside code would be read as
 * markup by the page's template compiler.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{\{/g, '&#123;&#123;');
}

/** The commands whose flags the docs page tabulates: every command with an option of its own. */
export function commandsWithFlags(tree: HelpCommand[]): HelpCommand[] {
  return tree.filter((c) => c.path.length > 0 && c.options.length > 0);
}

/** One command's generated flag table, markers included. */
export function renderFlagBlock(cmd: HelpCommand): string {
  const rows = cmd.options.map((o) => `| \`${o.term}\` | ${cell(o.description)} |`);
  return [
    flagsStart(cmd),
    '',
    `Flags of \`${commandLine(cmd)}\`, generated from its \`--help\` (\`npm run cli-reference:update\` in source/cli):`,
    '',
    '| Flag | Description |',
    '|------|-------------|',
    ...rows,
    '',
    FLAGS_END,
  ].join('\n');
}

/** The page with every flag block it carries re-rendered from the tree; a block naming no command is left as it is. */
export function renderFlagBlocks(page: string, tree: HelpCommand[]): string {
  const byLine = new Map(commandsWithFlags(tree).map((c) => [commandLine(c), c]));
  return page.replace(/<!-- flags: (yg[^>]*?) -->[\s\S]*?<!-- \/flags -->/g, (whole, command: string) => {
    const cmd = byLine.get(command);
    return cmd === undefined ? whole : renderFlagBlock(cmd);
  });
}
