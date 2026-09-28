// =============================================================================
// Command lines quoted in prose, and whether the CLI accepts them.
//
// The reference surfaces (the docs site, the READMEs, the CHANGELOG, the
// knowledge topics, the operating manual, the schema references and the help
// itself) quote `yg <command> --flag` lines everywhere, by hand. This module
// finds each quoted command line — in an inline code span, or on a line of a
// fenced block — and reads it against the command tree the built CLI's help
// prints (cli-help-tree.ts): the command words name a command, and every long
// flag after them must be one that command accepts.
//
// Three shorthands the pages use are read as they are meant:
//   - `yg log add|read --aspect` names two commands; the flag must be on both;
//   - `yg log --aspect` names the family: a command with subcommands and no
//     options of its own accepts a flag one of its subcommands takes;
//   - a sentence that documents a removal or a refusal ("removed", "is
//     refused", "no longer", …) names a flag the command does not take on
//     purpose (for a fenced block, the line).
//
// Imports only Node builtins and its sibling, never anything under src/**.
// =============================================================================

import { GLOBAL_FLAGS, HIDDEN_FLAGS, commandLine, type HelpCommand } from './cli-help-tree.js';

/** One quoted command line that names a flag its command does not accept. */
export interface BadMention {
  where: string;
  line: number;
  quoted: string;
  problem: string;
}

/**
 * The sentence of a prose line an inline code span stands in: from the end of
 * the sentence before it to the end of its own, read with every code span
 * masked so a full stop inside code does not end a sentence.
 */
function sentenceAround(raw: string, start: number, end: number): string {
  const masked = raw.replace(/(`+)([^`]+?)\1(?!`)/g, (m) => '`'.repeat(m.length));
  const before = masked.slice(0, start);
  let from = 0;
  for (const m of before.matchAll(/[.!?]\s+/g)) from = m.index! + m[0].length;
  const after = /[.!?](?:\s|$)/.exec(masked.slice(end));
  return raw.slice(from, after === null ? raw.length : end + after.index + 1);
}

/**
 * The code a text quotes, with the line each piece is on: the lines of every
 * fenced block (a shell comment cut off), and the inline code spans of every
 * other line. `text` is what a removal marker is looked for in: the whole
 * line of a fenced block, and the sentence an inline span stands in — so a
 * paragraph that mentions one removed flag does not exempt every other
 * command it quotes.
 */
export function codeRegions(text: string): Array<{ line: number; code: string; text: string }> {
  const out: Array<{ line: number; code: string; text: string }> = [];
  let fence: string | null = null;
  text.split('\n').forEach((raw, i) => {
    const opener = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (opener !== null && opener[1][0] === fence[0] && opener[1].length >= fence.length && raw.trim() === opener[1]) fence = null;
      else out.push({ line: i + 1, code: raw.replace(/(^|\s)#(\s.*|$)/, ''), text: raw });
      return;
    }
    if (opener !== null) {
      fence = opener[1];
      return;
    }
    for (const m of raw.matchAll(/(`+)([^`]+?)\1(?!`)/g)) out.push({ line: i + 1, code: m[2], text: sentenceAround(raw, m.index!, m.index! + m[0].length) });
  });
  return out;
}

/** Words that mark a line as one talking ABOUT a flag the command does not take. */
const REMOVAL_MARKERS = /\b(?:removed|retired|no longer|is refused|are refused|refused as|refuses|was renamed|renamed to|replaced by|replaces|gone|does not exist|takes no|has no)\b/i;

/** A token that ends one command line: a pipe, a separator, a redirect, prose after it. */
const ENDS_COMMAND = /^(?:\||\|\||&&|;|>|>>|2>&1|→|—|or|and|then|\/)$/;

/** Whether a command (or, for a group with no options of its own, one of its subcommands) takes a flag. */
function takes(cmd: HelpCommand, flag: string, byPath: Map<string, HelpCommand>): boolean {
  if (cmd.options.some((o) => o.long === flag)) return true;
  if ((HIDDEN_FLAGS[commandLine(cmd)] ?? []).some((h) => h.flag === flag)) return true;
  if (cmd.options.length === 0 && cmd.subcommands.length > 0) {
    return cmd.subcommands.some((s) => takes(byPath.get([...cmd.path, s].join(' '))!, flag, byPath));
  }
  return false;
}

/** A command word as quoted: trailing punctuation off, `add|read` read as its alternatives. */
function words(token: string): string[] {
  return token.replace(/[`'",.:;)]+$/, '').split('|');
}

/**
 * Read every `yg …` command line in one piece of code against the tree: the
 * command words it names, then each long flag after them. Returns the
 * problems found (an empty list when every flag is one the command accepts).
 */
export function checkCode(code: string, tree: HelpCommand[]): string[] {
  const byPath = new Map(tree.map((c) => [c.path.join(' '), c]));
  const root = byPath.get('')!;
  const problems: string[] = [];
  for (const m of code.matchAll(/(?:^|[\s(`'"$])yg((?:\s+\S+)+)/g)) {
    const tokens = m[1].trim().split(/\s+/);
    let cmds = [root];
    let i = 0;
    for (; i < tokens.length; i++) {
      const alternatives = words(tokens[i]);
      const next = cmds.flatMap((c) => alternatives.filter((w) => c.subcommands.includes(w)).map((w) => byPath.get([...c.path, w].join(' '))!));
      if (next.length === 0 || next.length < alternatives.length * cmds.length) break;
      cmds = next;
    }
    if (cmds[0] === root) continue; // not a command line: `yg` alone, a placeholder, prose
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === 'yg' || ENDS_COMMAND.test(t)) break;
      const flag = /^(--[a-z][\w-]*)/.exec(t)?.[1];
      if (flag === undefined || GLOBAL_FLAGS.has(flag)) continue;
      for (const cmd of cmds) if (!takes(cmd, flag, byPath)) problems.push(`${commandLine(cmd)} has no ${flag}`);
    }
  }
  return problems;
}

/** Every quoted command line in a text that names a flag its command does not accept. */
export function badMentions(where: string, text: string, tree: HelpCommand[]): BadMention[] {
  const out: BadMention[] = [];
  for (const { line, code, text: raw } of codeRegions(text)) {
    if (REMOVAL_MARKERS.test(raw)) continue;
    for (const problem of checkCode(code, tree)) out.push({ where, line, quoted: code.trim(), problem });
  }
  return out;
}
