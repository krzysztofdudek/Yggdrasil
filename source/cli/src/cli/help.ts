/**
 * `yg --help`, `yg <command> --help`, and every usage error the argument
 * parser raises — the one place the CLI describes itself.
 *
 * The root help groups the commands by what a reader is doing (daily work,
 * exploring the graph, working on rules, setting up) with one line each;
 * each command's own help opens with the same one line, lists its options in
 * one style (capitalised, no closing full stop, numeric defaults unquoted),
 * shows two or three examples, and keeps the long description as an "About"
 * paragraph after them. A usage error the parser raises (an unknown option, a
 * missing argument) is reported in the same error grammar as every other
 * command error — `error[usage]: …` and a `next:` naming the command's help —
 * and, for a command run with --json, as a yg-error/1 document on stdout.
 *
 * Registered last, after every command, because it describes the commands the
 * others registered.
 */
import type { Command, Help, Option } from 'commander';
import { fail } from './output.js';

/** One command's place in the root help: its group, its one line, its examples. */
interface CommandHelp {
  group: 'Daily' | 'Explore' | 'Rules' | 'Setup';
  summary: string;
  examples: Array<[string, string]>;
}

const COMMANDS: Record<string, CommandHelp> = {
  check: {
    group: 'Daily',
    summary: 'Run the gate: rules, coverage, relations',
    examples: [
      ['yg check', 'read-only gate'],
      ['yg check --approve --only-deterministic', 'record every free verdict'],
      ['yg check --summary', 'one line per finding label'],
    ],
  },
  context: {
    group: 'Daily',
    summary: 'Everything an agent needs before editing one node or file',
    examples: [
      ['yg context --file src/a.ts', 'before editing a file'],
      ['yg context --node app/orders', 'before editing a node'],
    ],
  },
  log: {
    group: 'Daily',
    summary: "Record and read why a node's code changed",
    examples: [
      ["yg log add --node app/orders --reason '<why this change was made>'", 'record why'],
      ['yg log read --node app/orders', 'the newest entries'],
    ],
  },
  prime: {
    group: 'Daily',
    summary: 'Print the agent protocol',
    examples: [['yg prime', 'the operating manual, fresh from this CLI']],
  },
  find: {
    group: 'Explore',
    summary: 'Find nodes and rules by keyword',
    examples: [['yg find "order checkout"', 'ranked nodes, rules and files']],
  },
  owner: {
    group: 'Explore',
    summary: 'Which node owns a file',
    examples: [['yg owner --file src/a.ts', 'the owning node, or why there is none']],
  },
  node: {
    group: 'Explore',
    summary: 'One node: what it owns, depends on, publishes',
    examples: [['yg node app/orders', 'the component'], ['yg node app/orders --json', 'as a yg-node/1 document']],
  },
  impact: {
    group: 'Explore',
    summary: 'What depends on a node, rule, flow or type',
    examples: [['yg impact --node app/orders', 'dependents and consumers'], ['yg impact --aspect no-todo', 'what a rule change re-reviews']],
  },
  tree: {
    group: 'Explore',
    summary: 'All nodes, one line each',
    examples: [['yg tree', 'every node'], ['yg tree --root app --depth 1', 'one level under app']],
  },
  structure: {
    group: 'Explore',
    summary: 'Dependencies that cross distant parts of the tree',
    examples: [['yg structure', 'the structural dashboard']],
  },
  flows: {
    group: 'Explore',
    summary: 'The flows and the nodes they name',
    examples: [['yg flows', 'every flow']],
  },
  aspects: {
    group: 'Rules',
    summary: 'List rules and where they apply',
    examples: [['yg aspects', 'every rule and its reach'], ['yg aspects --health', 'how each rule is doing']],
  },
  'aspect-test': {
    group: 'Rules',
    summary: 'Run one rule without touching the lock',
    examples: [['yg aspect-test --aspect no-todo --node app/orders', 'one rule on one node'], ['yg aspect-test --aspect no-todo --files src/a.ts', 'on ad-hoc files']],
  },
  drill: {
    group: 'Rules',
    summary: 'Re-run a rule over its own test cases',
    examples: [['yg drill --aspect no-todo', 'the rule over its cases'], ['yg drill --aspect no-todo --json', 'as a yg-drill/1 document']],
  },
  simulate: {
    group: 'Rules',
    summary: 'Replay history against a rule change',
    examples: [['yg simulate .yggdrasil/aspects/no-todo', 'what the rule would have caught']],
  },
  suppressions: {
    group: 'Rules',
    summary: 'Every yg-suppress marker and what it waives',
    examples: [['yg suppressions', 'the waiver inventory']],
  },
  advise: {
    group: 'Rules',
    summary: 'What needs attention, and proposed rule changes',
    examples: [['yg advise', 'the attention feed']],
  },
  incident: {
    group: 'Rules',
    summary: 'Record a rule that missed, or blocked wrongly',
    examples: [['yg incident list', 'the ledger']],
  },
  'type-suggest': {
    group: 'Rules',
    summary: 'Design an architecture type for a file',
    examples: [['yg type-suggest --file src/a.ts', 'which type it fits']],
  },
  init: {
    group: 'Setup',
    summary: 'Create or upgrade the graph in this repository',
    examples: [['yg init', 'start a graph'], ['yg init --upgrade', 'refresh the agent rules']],
  },
  adopt: {
    group: 'Setup',
    summary: 'Accept a proposed graph and baseline it',
    examples: [['yg adopt ../proposal', 'install a proposed graph']],
  },
  pack: {
    group: 'Setup',
    summary: 'Install and update rule packages',
    examples: [['yg pack list', 'what is installed']],
  },
  marketplace: {
    group: 'Setup',
    summary: 'Publish and check a rule marketplace',
    examples: [['yg marketplace check', 'before anyone installs from it']],
  },
  portal: {
    group: 'Setup',
    summary: 'Browse the graph and its verdicts in a browser',
    examples: [['yg portal', 'open it locally']],
  },
  knowledge: {
    group: 'Setup',
    summary: 'Read the built-in guides',
    examples: [['yg knowledge list', 'the topics'], ['yg knowledge read cli-reference', 'one topic']],
  },
  schemas: {
    group: 'Setup',
    summary: 'Print the graph file schemas',
    examples: [['yg schemas list', 'the schemas']],
  },
};

const GROUP_ORDER: Array<CommandHelp['group']> = ['Daily', 'Explore', 'Rules', 'Setup'];

/** Examples as the help prints them: the command, then what it is for, aligned. */
function examplesBlock(examples: Array<[string, string]>): string {
  const width = Math.max(...examples.map(([c]) => c.length));
  return ['Examples', ...examples.map(([c, why]) => `  ${c.padEnd(width)}   ${why}`)].join('\n');
}

/** The root help: grouped commands, one line each, three examples, and where options live. */
function rootHelp(program: Command, description: string): string {
  const visible = program.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden && COMMANDS[c.name()] !== undefined);
  const width = Math.max(...visible.map((c) => c.name().length));
  const lines = [`yg — ${description}`, ''];
  for (const group of GROUP_ORDER) {
    const inGroup = visible.filter((c) => COMMANDS[c.name()].group === group);
    if (inGroup.length === 0) continue;
    lines.push(group);
    if (group === 'Setup') {
      lines.push(`  ${inGroup.map((c) => c.name()).join(' · ')}`);
    } else {
      for (const c of inGroup) lines.push(`  ${c.name().padEnd(width)}  ${COMMANDS[c.name()].summary}`);
    }
    lines.push('');
  }
  lines.push(
    examplesBlock([
      ['yg check', 'read-only gate'],
      ['yg check --approve --only-deterministic', 'record every free verdict'],
      ['yg context --file src/a.ts', 'before editing a file'],
    ]),
    '',
    'Run yg <command> --help for its options. yg --version prints the version.',
    '',
  );
  return lines.join('\n');
}

/** An option's description in the one style: capitalised, no closing full stop, a numeric default unquoted. */
function optionDescription(option: Option): string {
  let text = option.description.trim().replace(/\.$/, '');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const extras: string[] = [];
  if (option.argChoices !== undefined) extras.push(`choices: ${option.argChoices.join(', ')}`);
  if (option.defaultValue !== undefined && !option.negate) {
    const value = option.defaultValueDescription ?? (typeof option.defaultValue === 'string' && !/^\d+$/.test(option.defaultValue) ? JSON.stringify(option.defaultValue) : String(option.defaultValue));
    extras.push(`default: ${value}`);
  }
  return extras.length > 0 ? `${text} (${extras.join(', ')})` : text;
}

/** The path of a command from the root, `check` or `log add`. */
function pathOf(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c !== null && c.parent !== null; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/**
 * Route one command's parser errors through the error grammar: the parser's
 * own sentence as `what`, `usage` as the code, and the command's help as the
 * next step.
 */
function routeParserErrors(cmd: Command): void {
  cmd.configureOutput({
    outputError: (str) => {
      const at = pathOf(cmd);
      fail(parserError(str, `yg ${at === '' ? '' : `${at} `}--help`, at), 'usage');
    },
  });
}

/**
 * A parser error in the one grammar, on one line: the parser's suggestion
 * (`(Did you mean --reason?)` on a line of its own) joins the sentence, and
 * the step stays the command's help, runnable as given. A suggestion for
 * `--json` on a command that does not answer in JSON is dropped: the nearest
 * spelling is never what was meant, and that is said instead.
 */
export function parserError(raw: string, help: string, at: string): { what: string; why: string; next: string } {
  const text = raw.replace(/^error:\s*/i, '').trim();
  const suggestion = /\s*\(Did you mean ([^?)]+)\?\)\s*$/.exec(text);
  const what = suggestion !== null ? text.slice(0, suggestion.index).trim() : text;
  if (/^unknown option '--json'/.test(what)) {
    return { what: `${what} — yg ${at} does not answer in JSON`, why: 'Only a command that lists --json in its help writes a machine document.', next: help };
  }
  return { what: suggestion !== null ? `${what} — did you mean ${suggestion[1]}?` : what, why: '', next: help };
}

/** Everything under a command, itself included. */
function walk(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap(walk)];
}

/**
 * Describe the CLI: the root help, every command's summary, option style,
 * examples and usage errors. Call once, after every command is registered.
 */
export function registerHelpCommand(program: Command): void {
  const description = 'architecture rules for AI agents, checked on every change';
  for (const cmd of walk(program)) {
    routeParserErrors(cmd);
    const own = cmd.parent === program ? COMMANDS[cmd.name()] : undefined;
    const long = cmd.description();
    if (own !== undefined) {
      cmd.summary(own.summary);
      cmd.addHelpText('after', `\n${examplesBlock(own.examples)}${long !== '' && long !== own.summary ? `\n\nAbout\n  ${long}` : ''}\n`);
    }
    cmd.configureHelp({
      optionDescription,
      // A command's help opens with its one line; the long text is its About.
      commandDescription: (c: Command) => (c.parent === program && COMMANDS[c.name()] !== undefined ? COMMANDS[c.name()].summary : c.description()),
      // The root help is grouped by task, not a flat list.
      formatHelp: (c: Command, helper: Help) => (c === program ? rootHelp(program, description) : defaultFormat(c, helper)),
    });
  }
}

/** Commander's own layout for a command's help, with this module's option and description style. */
function defaultFormat(cmd: Command, helper: Help): string {
  const proto = Object.getPrototypeOf(helper) as { formatHelp: (c: Command, h: Help) => string };
  return proto.formatHelp.call(helper, cmd, helper);
}

/**
 * The command line without its colour flags — `--color`, `--color=<when>`
 * (auto, always, never, true, false) and `--no-color` — which work on every
 * command. The colour library reads them straight off the command line when it
 * loads, before any command runs, so all that is left is to keep the argument
 * parser from refusing them as unknown options. Anything after `--` is kept.
 */
export function withoutColourFlags(argv: readonly string[]): string[] {
  const at = argv.indexOf('--');
  const head = at < 0 ? argv : argv.slice(0, at);
  const tail = at < 0 ? [] : argv.slice(at);
  return [...head.filter((a) => !/^--(?:no-colou?rs?|colou?rs?(?:=(?:auto|always|never|true|false))?)$/.test(a)), ...tail];
}
