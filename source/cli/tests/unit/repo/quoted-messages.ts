// The words the CLI can print, read out of its source, and the messages the
// reference surfaces quote, read out of their text — shared by the guard that
// holds the second to the first (quoted-messages.test.ts). Reads files; writes
// nothing.
//
// What the CLI can print is every string it spells: each string literal and
// template in the shipped source, a template's substitutions and anything a
// `+` joins that is not itself a string standing in as one unknown word, and
// each branch of a `? :` inside a template read as its own string. The
// vocabulary is the three-word sequences those strings contain, a count()
// of a noun read as a number and the noun, each end of a string open (it may
// be joined to another where it is used), and a plural `s` dropped.
//
// A quoted message is a code span that is an output line by its shape
// (`error[code]: …`, `fill  …`, `next: …`) or that a sentence introduces as
// output — the CLI "says", "prints", "reports", "warns" it, it is a "line", a
// "header", an "error" — and that reads as words rather than code. Its variable parts, as a
// page writes them (a `<placeholder>`, a name or value in single quotes, `…`,
// a number, a single capital letter such as N), are gaps; every three words in a row between gaps must be three
// words the CLI can print, one of them allowed to stand where the source has
// a substitution. A quote of what the CLI used to print, as a change note
// gives it ("where it said `…`"), is not held to it. So `Another approval is
// already running` is caught where the
// CLI says `Another fill is already running`, while `error[unverified] 3 pairs
// whose inputs changed since the verdict` passes over the count the CLI
// renders.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** An unknown word: where a string holds a substitution. */
const ANY = '*';

/** A string as a list of lower-case words, a substitution being one ANY. */
type Words = string[];

/**
 * The words of a text, lower-cased and without a plural `s`, so that the
 * noun count() pluralises reads the same as the singular the source spells.
 */
function wordsOf(text: string): Words {
  return (text.match(/\uE000|[A-Za-z][A-Za-z'-]*/g) ?? []).map((w) => (w === '\uE000' ? ANY : w.toLowerCase().replace(/(?<=\w\w)s$/, '')));
}

/** The output layer's counted noun: `count(n, 'pair')` prints `3 pairs`, a number and the noun. */
const COUNTERS = new Set(['count', 'plural']);

/**
 * The texts one expression can print: a literal is itself, a template its
 * parts with each substitution a gap (each `? :` branch inside it read as a
 * text of its own), a `+` of such expressions the two joined.
 */
function texts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      const inner = ts.isConditionalExpression(span.expression)
        ? [...texts(span.expression.whenTrue), ...texts(span.expression.whenFalse)]
        : [];
      const fills = inner.length > 0 && inner.length <= 4 ? inner : ['\uE000'];
      out = out.flatMap((prefix) => fills.map((f) => `${prefix}${f === '' ? '\uE000' : f}${span.literal.text}`)).slice(0, 16);
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = texts(node.left);
    const right = texts(node.right);
    const l = left.length > 0 ? left : ['\uE000'];
    const r = right.length > 0 ? right : ['\uE000'];
    if (left.length === 0 && right.length === 0) return [];
    return l.flatMap((a) => r.map((b) => a + b)).slice(0, 16);
  }
  if (ts.isParenthesizedExpression(node)) return texts(node.expression);
  if (ts.isConditionalExpression(node)) return [...texts(node.whenTrue), ...texts(node.whenFalse)].slice(0, 16);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && COUNTERS.has(node.expression.text)) {
    const noun = node.arguments.find((a) => ts.isStringLiteral(a));
    return noun !== undefined && ts.isStringLiteral(noun) ? [`\uE000 ${noun.text}`] : [];
  }
  return [];
}

/** Every .ts, .mjs and .js file under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.(?:ts|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/**
 * The three-word sequences the CLI can print, from every file under `srcDir`
 * except the reference texts themselves (`skip` returns true for those): a
 * knowledge topic or the manual quoting a message is what is being checked,
 * not what the CLI prints.
 */
export function vocabulary(srcDir: string, skip: (abs: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    if (skip(file)) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node): void => {
      for (const text of texts(node)) {
        // A string may be joined to others where it is used, so each end is open.
        const w = [ANY, ...wordsOf(text), ANY];
        for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' '));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Whether three words are three the CLI can print, one of them standing where it substitutes. */
function printable(tri: Words, vocab: Set<string>): boolean {
  const [a, b, c] = tri;
  return [
    [a, b, c],
    [ANY, b, c],
    [a, ANY, c],
    [a, b, ANY],
  ].some((t) => vocab.has(t.join(' ')));
}

/** The sentence words that introduce a code span as something the CLI prints. */
const INTRODUCED_AS_OUTPUT = /\b(?:says|say|prints|print|printed|reads|reports|warns|shows|message|line|output|emits|stderr|stdout|header|notice|note|error|warning|refuses with|asks|tells|headed|heading|ends with|opens with)\b[^`.,;]{0,24}$/i;

/** Words that make a quote one of what the CLI used to print, as a change note describes it. */
const FORMERLY = /\b(?:used to|instead of|no longer|formerly|previously|where it said|it said|it read|until now|was)\b[^`]{0,40}$/i;

/** A span that reads as code, a path, a key or an expression rather than as words the CLI prints. */
const CODE_LIKE = /\$\{|ctx\.|=>|;|[{}]|\/|\.[a-z]+\(|^\w+(?:\.\w+)+|^[a-z_.]+: /;

/** The prefixes of an output line, which may look like a key but are the report's own words. */
const OUTPUT_LINE = /^(?:error|warning|nomination)\[|^(?:fill|next|then|partial|note|why|fix|at):? {1,2}\S/;

/** One quoted message and the words of it the CLI cannot print. */
export interface Misquote {
  where: string;
  line: number;
  quoted: string;
  unknown: string;
}

/** The quoted messages in a markdown text, each with its line. */
export function quotedMessages(text: string): Array<{ line: number; quoted: string }> {
  const out: Array<{ line: number; quoted: string }> = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of raw.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      const quoted = m[1];
      if (wordsOf(quoted).length < 3) continue; // nothing three words long to hold to the CLI
      if (/^\s*(?:yg|git|npm|npx|node)\b/.test(quoted)) continue; // a command, held to the CLI by cli-mentions
      if (CODE_LIKE.test(quoted) && !OUTPUT_LINE.test(quoted)) continue;
      const before = raw.slice(Math.max(0, m.index! - 80), m.index);
      // An output line (`error[code]: …`, `fill  …`) is output by its shape; other words by the sentence around them.
      if (!(OUTPUT_LINE.test(quoted) || INTRODUCED_AS_OUTPUT.test(before)) || FORMERLY.test(before)) continue;
      out.push({ line: i + 1, quoted });
    }
  });
  return out;
}

/** Every quoted message in a text with three words in a row the CLI cannot print. */
export function misquotes(where: string, text: string, vocab: Set<string>): Misquote[] {
  const out: Misquote[] = [];
  for (const { line, quoted } of quotedMessages(text)) {
    // The renderer writes a line's label (`error[code]:`, `fill`, `next:`) itself, around the message.
    const message = quoted.replace(/^(?:(?:error|warning|nomination)\[[^\]]*\]:?|(?:fill|next|then|partial|note|why|fix|at):?)\s+/, '');
    for (const stretch of message.split(/<[^>]+>|'[^']*'|…|\.\.\.|\b\d+\b|\b[A-Z]\b/)) {
      const w = wordsOf(stretch);
      for (let i = 0; i + 2 < w.length; i++) {
        if (!printable(w.slice(i, i + 3), vocab)) {
          out.push({ where, line, quoted, unknown: w.slice(i, i + 3).join(' ') });
          break;
        }
      }
    }
  }
  return out;
}
