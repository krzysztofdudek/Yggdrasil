import { walk, report, findComments } from '@chrisdudek/yg/ast';

// self-contained-references (deterministic, errs: under)
//
// A comment or test name must stand on its own: a reader with only this
// repository checked out has to be able to understand it without chasing an
// external planning artifact (a private review report, a numbered task/round
// from a design doc, a scratch file) that is not committed here. This check
// catches two concrete, previously-recurring shapes of that failure — see the
// aspect's own description for why it deliberately stops there (in short: a
// blanket "any bare reference code" scan collides with this repository's own
// large, established, pre-existing convention of citing its OWN long-lived
// invariants and decisions the same way, e.g. "(G4)", "(D7)", "(R5)" — a
// static scan with no git history cannot tell that apart from an external
// citation, so this check narrows to the one shape that never collided with
// it in practice: a trailing-letter variant inside a TEST NAME).
//
// PART A — vague, un-anchored phrases (comments AND test names). A phrase
// like "this task" or "the brief" names no number, no title, nothing a reader
// could even search for — it is categorically less resolvable than this
// repo's own "(G4)"-style codes, which always sit beside a named, described
// concept. Comments are joined across adjacent `//` lines before matching,
// because a phrase split by line-wrap is exactly what defeated a line-based
// grep before.
//
// PART B — a bare parenthetical reference code shaped like a private review
// report's finding id (a letter, 1-3 digits, a trailing lowercase letter —
// e.g. "(I1a)") with no colon-based explanation, in a test's own
// `it`/`describe`/`test` name specifically. Exempt whenever the code is
// followed by a colon introducing its own explanation in the same
// parenthetical (e.g. "(I1b: binary wins over the size guard)").

const VAGUE_PHRASES = [
  { re: /\bthis task\b/i, label: '"this task"' },
  { re: /\b(?:a|the) later task\b/i, label: '"a/the later task"' },
  { re: /\bmaster plan\b/i, label: '"master plan"' },
  { re: /\bthe brief\b/i, label: '"the brief"' },
  { re: /\bfix[- ]round\b/i, label: '"fix round"' },
];

/** First vague-phrase match in `text`, or null. */
function vagueMatch(text) {
  for (const { re, label } of VAGUE_PHRASES) {
    if (re.test(text)) return label;
  }
  return null;
}

// LETTER + 1-3 digits + 1-3 lowercase letters, e.g. I1a, K15b, Q1a.
const CODE_IN_PARENS = /\(([A-Z]\d{1,3}[a-z]{1,3})([^()]*)\)/g;

/** First bare (no colon in its own parenthetical) trailing-letter code in `text`, or null. */
function bareCodeMatch(text) {
  CODE_IN_PARENS.lastIndex = 0;
  let m;
  while ((m = CODE_IN_PARENS.exec(text))) {
    const [, code, rest] = m;
    if (!rest.includes(':')) return code;
  }
  return null;
}

/** Literal string content of a tree-sitter `string` node, or null if not a plain literal. */
function stringLiteralText(node) {
  if (!node || node.type !== 'string') return null;
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  return frag ? frag.text : ''; // an empty literal ('' / "") yields ''
}

/** Walk down a callee chain (member/call expressions) to its leftmost identifier. */
function rootIdentifier(node) {
  let cur = node;
  while (cur) {
    if (cur.type === 'identifier') return cur.text;
    if (cur.type === 'member_expression') { cur = cur.childForFieldName('object'); continue; }
    if (cur.type === 'call_expression') { cur = cur.childForFieldName('function'); continue; }
    return null;
  }
  return null;
}

const TEST_FN_NAMES = new Set(['it', 'describe', 'test']);

/** Every `it`/`describe`/`test` (incl. `.skip`, `.only`, `.skipIf(...)`, …) call's own
 *  plain string-literal name, paired with the string node to anchor a violation on. */
function collectTestNames(rootNode) {
  const found = [];
  walk(rootNode, (node) => {
    if (node.type !== 'call_expression') return;
    const root = rootIdentifier(node.childForFieldName('function'));
    if (!root || !TEST_FN_NAMES.has(root)) return;
    const args = node.childForFieldName('arguments');
    const first = args && args.namedChildren[0];
    const text = stringLiteralText(first);
    if (text !== null) found.push({ text, anchor: first });
  });
  return found;
}

/** Strip a line comment's leading `//` (+ one optional space). */
function stripLineComment(text) {
  return text.replace(/^\/\/\s?/, '');
}

/** Collapse a block comment's `/* … *\/` delimiters and per-line leading `* ` into one string. */
function joinBlockComment(text) {
  const inner = text.replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  return inner
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .trim();
}

/**
 * Every comment in `file`, grouped into paragraphs: a run of `//` line comments on
 * strictly consecutive source rows is joined into ONE string before matching (the
 * line-wrap join this check exists to do), a block comment is its own paragraph.
 */
function commentParagraphs(file) {
  const comments = findComments(file);
  const paragraphs = [];
  let i = 0;
  while (i < comments.length) {
    const node = comments[i];
    if (node.text.startsWith('//')) {
      const lines = [stripLineComment(node.text)];
      let row = node.startPosition.row;
      let j = i;
      while (
        j + 1 < comments.length &&
        comments[j + 1].text.startsWith('//') &&
        comments[j + 1].startPosition.row === row + 1
      ) {
        j += 1;
        row = comments[j].startPosition.row;
        lines.push(stripLineComment(comments[j].text));
      }
      paragraphs.push({ text: lines.join(' '), anchor: node });
      i = j + 1;
    } else {
      paragraphs.push({ text: joinBlockComment(node.text), anchor: node });
      i += 1;
    }
  }
  return paragraphs;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue; // non-parseable file — nothing to scan

    for (const { text, anchor } of commentParagraphs(file)) {
      const phrase = vagueMatch(text);
      if (phrase) {
        violations.push(
          report(
            file,
            anchor,
            `Comment cites ${phrase} — a reader cannot tell what that refers to from this ` +
              `repository alone (no number, no title, nothing to search for). Reword it to say ` +
              `what the code does and why, in its own words, with no reference to an external ` +
              `plan, task, or review round.`,
          ),
        );
      }
    }

    for (const { text, anchor } of collectTestNames(file.ast.rootNode)) {
      const phrase = vagueMatch(text);
      if (phrase) {
        violations.push(
          report(
            file,
            anchor,
            `Test name cites ${phrase} — a reader cannot tell what that refers to from this ` +
              `repository alone. Reword the name to describe the case directly.`,
          ),
        );
        continue; // one violation per test name is enough signal
      }
      const code = bareCodeMatch(text);
      if (code) {
        violations.push(
          report(
            file,
            anchor,
            `Test name cites a bare reference code '(${code})' with no explanation a reader ` +
              `can resolve from this repository. Either drop it (the name already stands on its ` +
              `own without it) or give it its own inline colon-based explanation right there, ` +
              `e.g. '(${code}: what it means)'.`,
          ),
        );
      }
    }
  }

  return violations;
}
