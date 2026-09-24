import { walk, report } from '@chrisdudek/yg/ast';

/**
 * Output through the layer.
 *
 * Every byte the CLI prints goes through its output layer (cli/output.ts and
 * cli/output-diagnostic.ts), which owns the words, the layout, the counts, the
 * colour and the streams. This rule keeps the four ways around it shut, over
 * the whole shipped source tree — every .ts file under source/cli/src/, so a
 * module written tomorrow is covered the day it is written:
 *
 *   1. a hand-rolled plural: `(s)` after a word in a string (`pair(s)`);
 *   2. a hand-built count: a substitution followed by a counted noun,
 *      `${n} pairs`, `${n} nodes`, `${n} files` (one word may sit between:
 *      `${n} source files`), a noun whose plural is spliced on
 *      (`file${n === 1 ? '' : 's'}`), or the same built by concatenation
 *      (`n + ' files'`) — count() and plural() make the noun agree instead;
 *   3. a direct stream write or console call: `process.stdout.write`,
 *      `process.stderr.write` (called or merely referenced — a reference is
 *      how a write escapes into a callback), and any `console.*`;
 *   4. an import of chalk: colour comes from the layer's `paint`, so what is
 *      decorated, and when, is decided in one place.
 *
 * The browser code of the portal (.js under templates/portal/) is outside the
 * scope: it never writes to the CLI's streams.
 */

const GUARDED_PREFIX = 'source/cli/src/';

/** The output layer itself: the one place allowed every form above. */
const OUTPUT_LAYER = new Set([
  'source/cli/src/cli/output.ts',
  'source/cli/src/cli/output-diagnostic.ts',
  // count() and plural() themselves, kept in utils so the engine and the
  // formatters (which may not import the command layer) count the same way.
  'source/cli/src/utils/count.ts',
]);

/**
 * The sanctioned sinks outside the layer, each allowed ONLY the stream write it
 * names — never console, chalk, or a plural or count of its own.
 *
 *   bin.ts — the entry point's last-resort handlers (an unhandled rejection, a
 *     throw out of the argument parser). They run when anything, the output
 *     layer included, may be what failed, and the architecture lets the entry
 *     point depend on command modules only, not on the layer.
 *   utils/debug-log.ts — the --debug tee. It wraps both streams' write to copy
 *     every byte the CLI prints into the debug log, so it must reach the write
 *     functions themselves; it adds no bytes of its own to either stream.
 *   cli/exit-after-flush.ts — the drain before exit. It writes an empty chunk
 *     to stdout only to be called back once everything before it has left the
 *     process; no byte of output goes through it.
 */
const SANCTIONED_SINKS = new Map([
  ['source/cli/src/bin.ts', new Set(['process.stderr.write'])],
  ['source/cli/src/utils/debug-log.ts', new Set(['process.stdout.write', 'process.stderr.write'])],
  ['source/cli/src/cli/exit-after-flush.ts', new Set(['process.stdout.write'])],
]);

const STREAM_WRITES = new Set(['process.stdout.write', 'process.stderr.write']);

// `pair(s)`: a word with `(s)` glued on, not followed by more of a word.
const PLURAL_HACK = /[A-Za-z]\(s\)(?![A-Za-z0-9_])/;

// A counted noun right after a substitution — optionally one word between —
// written plural by hand (`${n} files`, `${n} source files`) or with its
// plural spliced on (`${n} file${…}`). `node-owned` is not a noun: a hyphen
// after the plural rules it out.
const NOUN_AFTER = String.raw`[ \t]+(?:[A-Za-z][\w-]*[ \t]+)?(?:(?:pairs|nodes|files)(?![\w-])|(?:pair|node|file)\$\{)`;
// Matched against a template's literal text with every substitution replaced
// by an empty `${}` (see literalText), so code inside a substitution — a
// `.map((s) => …)`, a nested template — is never read as words.
const COUNT_TEMPLATE = new RegExp(String.raw`\$\{\}` + NOUN_AFTER);
// `n + ' files'`: the same count built by concatenation.
const COUNT_CONCAT = /^[ \t]+(?:[A-Za-z][\w-]*[ \t]+)?(?:pairs|nodes|files)(?![\w-])/;

/**
 * What a string literal or template string says: its text without the quotes,
 * each `${…}` substitution reduced to an empty `${}`. A nested template is a
 * node of its own and is read on its own visit.
 */
function literalText(node) {
  if (node.type === 'string') return node.text.slice(1, -1);
  let out = '';
  let pos = node.startIndex + 1;
  for (const child of node.namedChildren) {
    if (child.type !== 'template_substitution') continue;
    out += node.text.slice(pos - node.startIndex, child.startIndex - node.startIndex) + '${}';
    pos = child.endIndex;
  }
  return out + node.text.slice(pos - node.startIndex, node.text.length - 1);
}

function flat(text) {
  return text.replace(/\s+/g, '');
}

function isChalkSource(text) {
  const v = text.replace(/^['"`]|['"`]$/g, '');
  return v === 'chalk' || v.startsWith('chalk/');
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!file.path.startsWith(GUARDED_PREFIX) || !file.path.endsWith('.ts')) continue;
    if (OUTPUT_LAYER.has(file.path)) continue;
    const allowedWrites = SANCTIONED_SINKS.get(file.path) ?? new Set();

    walk(file.ast.rootNode, (node) => {
      // 1 + 2 — plurals and counts, in what a string says.
      if (node.type === 'string' || node.type === 'template_string') {
        const text = literalText(node);
        if (PLURAL_HACK.test(text)) {
          violations.push(report(file, node, 'a hand-rolled plural (`word(s)`) — write the count with count() or the noun with plural() from the output layer, so the noun agrees with the number'));
        } else if (node.type === 'template_string' && COUNT_TEMPLATE.test(text)) {
          violations.push(report(file, node, 'a hand-built count (`${n} files`, `${n} pair${…}`) — use count(n, noun) from the output layer, so 1 reads "1 file" and 2 reads "2 files"'));
        }
        return;
      }
      if (node.type === 'binary_expression') {
        const op = node.childForFieldName('operator');
        const right = node.childForFieldName('right');
        const left = node.childForFieldName('left');
        if (op?.text === '+' && right !== null && left !== null && right.type === 'string' && left.type !== 'string' && COUNT_CONCAT.test(right.text.slice(1, -1))) {
          violations.push(report(file, node, "a count built by concatenation (`n + ' files'`) — use count(n, noun) from the output layer"));
        }
        return;
      }

      // 3 — streams and console.
      if (node.type === 'member_expression') {
        const text = flat(node.text);
        if (STREAM_WRITES.has(text)) {
          if (!allowedWrites.has(text)) {
            violations.push(report(file, node, `${text} outside the output layer — write through writeOut / writeErr (or fail / notice / warn for a diagnostic) from cli/output.ts, or hand the text to the command that does`));
          }
          return;
        }
        const obj = node.childForFieldName('object');
        if (obj !== null && obj.type === 'identifier' && obj.text === 'console') {
          violations.push(report(file, node, `${text} — the CLI never prints through console; output goes through the output layer (writeOut / writeErr), debug output through debugWrite`));
        }
        return;
      }

      // 4 — chalk.
      if (node.type === 'import_statement') {
        const src = node.childForFieldName('source');
        if (src !== null && isChalkSource(src.text)) {
          violations.push(report(file, node, 'chalk imported outside the output layer — take colour from `paint` (and `decorated`) in cli/output.ts'));
        }
        return;
      }
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        if (fn !== null && args !== null && (fn.text === 'require' || fn.type === 'import')) {
          const first = args.namedChildren[0];
          if (first !== undefined && first.type === 'string' && isChalkSource(first.text)) {
            violations.push(report(file, node, 'chalk loaded outside the output layer — take colour from `paint` (and `decorated`) in cli/output.ts'));
          }
        }
      }
    });
  }
  return violations;
}
