import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DetectedDep, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Shared include-extraction for C and C++.
 *
 * v1 scope = EXISTENCE, not relation type. C and C++ have no module system; the ONLY
 * parse-time reference that names a concrete in-repo file is a QUOTED preprocessor
 * include (`#include "header.h"`). That is the single edge this layer emits. Everything
 * else a parser sees in these languages — function calls, class inheritance
 * (`base_class_clause`), namespace-qualified references, `using` declarations — is a
 * usage-site or definition-index concern that depends on a symbol/definition index this
 * v1 layer deliberately does NOT build. So `uses()` = preproc includes only, and
 * both grammars route through this one helper (the `preproc_include` node and its `path`
 * field are identical across tree-sitter-c and tree-sitter-cpp — probe-confirmed).
 *
 * Both `.c`/`.h` (C grammar) and the C++ extensions (cpp grammar; a `.h` whose directory is
 * C++ is routed to it too, see language-registry `languageForPath`) use the same `#include`
 * syntax, so the extraction is grammar-independent.
 */

/**
 * Read the header name from a `preproc_include` node, or undefined when this include does
 * NOT name an in-repo candidate file.
 *
 * The `path` field (childForFieldName('path')) is one of:
 *   - `string_literal`   → a QUOTED include `#include "db/foo.h"`. Returned as
 *                          `{ name, angle: false }`.
 *   - `system_lib_string`→ an ANGLE include `#include <util/log.hpp>`. Returned as
 *                          `{ name, angle: true }`: the resolver looks it up ONLY under
 *                          the `-I` roots of a compilation database, and silences it
 *                          otherwise, so a system header (`<vector>`) can never bind.
 *   - `identifier`/other → a MACRO include `#include HDR` (computed path). Unknowable
 *                          without preprocessing → SKIP (undefined).
 *
 * The name is the RAW text between the delimiters, not the grammar's `string_content`
 * pieces: a header-name is not a string literal ([lex.header]), so `\` is never an escape.
 * The grammar splits `"..\..\hdr\h.hpp"` into `string_content` and `escape_sequence`
 * children; reading only the first piece used to yield `..`. Backslashes are normalised
 * to `/` later by the resolver (MSVC accepts both separators).
 */
function includeHeaderName(include: Node): { name: string; angle: boolean } | undefined {
  const pathNode = include.childForFieldName('path');
  if (pathNode === null) return undefined;
  if (pathNode.type !== 'string_literal' && pathNode.type !== 'system_lib_string') return undefined; // macro include
  const text = pathNode.text;
  if (text.length < 2) return undefined;
  return { name: text.slice(1, -1).trim(), angle: pathNode.type === 'system_lib_string' };
}

/**
 * Evaluate a preprocessor controlling expression built from LITERALS ONLY. Returns the
 * integer value, or undefined when the value depends on anything a source-only tool cannot
 * know (a macro identifier, `defined(...)`, `__has_include(...)`, a function-like call, a
 * character literal, a division by zero, malformed text).
 *
 * Accepted: integer literals (decimal, hex, octal, binary, digit separators, u/l suffixes),
 * `true`/`false` (C++ [cpp.cond] keeps their boolean values; C23 keywords; `<stdbool.h>`
 * macros in older C), parentheses, unary `! ~ - +`, binary `* / % + - << >> < > <= >= ==
 * != & ^ | && ||` and `?:`. `&&`/`||` short-circuit, so `0 && FOO` is 0 and `1 || FOO` is
 * 1 even though `FOO` is unknown: the result does not depend on the macro.
 *
 * Soundness is one-sided by design: the caller treats a branch as dead only on a KNOWN
 * zero (or on a known non-zero earlier branch), so an unknown value always keeps the
 * include LIVE. Under-emission for a live conditional include cannot happen through this.
 */
export function evalPreprocessorCondition(expr: string): number | undefined {
  const tokens = tokenizeCondition(expr);
  if (tokens === undefined) return undefined;
  let pos = 0;
  let malformed = false;
  const eat = (t: string): boolean => {
    if (tokens[pos] !== t) return false;
    pos++;
    return true;
  };

  // `undefined` stands for an unknown value throughout.
  const primary = (): number | undefined => {
    const t = tokens[pos++];
    if (t === undefined) {
      malformed = true;
      return undefined;
    }
    if (t === '(') {
      const v = ternary();
      if (!eat(')')) malformed = true;
      return v;
    }
    const unary = UNARY.get(t);
    if (unary !== undefined) {
      const v = primary();
      return v === undefined ? undefined : unary(v);
    }
    if (/^[0-9]/.test(t)) return parseIntegerLiteral(t);
    if (t === 'true') return 1;
    if (t === 'false') return 0;
    if (!/^[A-Za-z_]/.test(t)) {
      malformed = true;
      return undefined;
    }
    // A macro, `defined X` / `defined(X)`, or a function-like probe (`__has_include(...)`):
    // unknown. Skip its operand or balanced argument list so parsing can continue.
    if (t === 'defined' && tokens[pos] !== '(') pos++;
    if (tokens[pos] === '(') {
      let depth = 0;
      do {
        const u = tokens[pos++];
        depth += u === '(' ? 1 : u === ')' ? -1 : 0;
        if (u === undefined) malformed = true;
      } while (depth > 0 && !malformed);
    }
    return undefined;
  };

  const binary = (level: number): number | undefined => {
    if (level >= BINARY_LEVELS.length) return primary();
    let left = binary(level + 1);
    while (tokens[pos] !== undefined && BINARY_LEVELS[level].includes(tokens[pos])) {
      const op = tokens[pos++];
      left = applyBinary(op, left, binary(level + 1));
    }
    return left;
  };

  const ternary = (): number | undefined => {
    const cond = binary(0);
    if (!eat('?')) return cond;
    const whenTrue = ternary();
    if (!eat(':')) malformed = true;
    const whenFalse = ternary();
    if (cond === undefined) return whenTrue === whenFalse ? whenTrue : undefined;
    return cond !== 0 ? whenTrue : whenFalse;
  };

  const value = ternary();
  if (malformed || pos !== tokens.length) return undefined;
  return value;
}

const UNARY = new Map<string, (v: number) => number>([
  ['!', (v) => Number(v === 0)],
  ['~', (v) => ~v],
  ['-', (v) => -v],
  ['+', (v) => v],
]);

const BINARY_LEVELS: string[][] = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
];

const ARITHMETIC = new Map<string, (a: number, b: number) => number>([
  ['|', (a, b) => a | b],
  ['^', (a, b) => a ^ b],
  ['&', (a, b) => a & b],
  ['==', (a, b) => Number(a === b)],
  ['!=', (a, b) => Number(a !== b)],
  ['<', (a, b) => Number(a < b)],
  ['>', (a, b) => Number(a > b)],
  ['<=', (a, b) => Number(a <= b)],
  ['>=', (a, b) => Number(a >= b)],
  ['<<', (a, b) => a << b],
  ['>>', (a, b) => a >> b],
  ['+', (a, b) => a + b],
  ['-', (a, b) => a - b],
  ['*', (a, b) => a * b],
  ['/', (a, b) => Math.trunc(a / b)],
  ['%', (a, b) => a % b],
]);

/** Apply a binary operator with `undefined` as "unknown". `&&`/`||` short-circuit on a known
 *  operand; division by zero is unknown. */
function applyBinary(op: string, a: number | undefined, b: number | undefined): number | undefined {
  if (op === '&&') {
    if (a === 0 || b === 0) return 0;
    return a === undefined || b === undefined ? undefined : 1;
  }
  if (op === '||') {
    if ((a ?? 0) !== 0 || (b ?? 0) !== 0) return 1;
    return a === undefined || b === undefined ? undefined : 0;
  }
  if (a === undefined || b === undefined) return undefined;
  const fn = ARITHMETIC.get(op);
  if (fn === undefined || ((op === '/' || op === '%') && b === 0)) return undefined;
  return fn(a, b);
}

/** Split a controlling expression into tokens, or undefined on a character the evaluator
 *  does not model (a string or character literal is left to the caller to blank). */
function tokenizeCondition(expr: string): string[] | undefined {
  const out: string[] = [];
  const re = /\s*(?:0[xX][0-9a-fA-F']+[uUlL]*|0[bB][01']+[uUlL]*|[0-9][0-9']*[uUlL]*|[A-Za-z_][A-Za-z0-9_]*|\|\||&&|==|!=|<=|>=|<<|>>|[()!~+\-*/%<>&^|?:,])\s*/y;
  while (re.lastIndex < expr.length) {
    const m = re.exec(expr);
    if (m === null) return undefined;
    out.push(m[0].trim());
  }
  return out;
}

/** An integer literal's value (suffixes and digit separators dropped), or undefined. */
function parseIntegerLiteral(text: string): number | undefined {
  const t = text.replace(/'/g, '').replace(/[uUlL]+$/, '');
  const n = /^0[0-7]+$/.test(t) ? parseInt(t, 8) : Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The constant value of a `preproc_if`/`preproc_elif` node's `condition`, or undefined. */
function conditionValue(node: Node): number | undefined {
  const condition = node.childForFieldName('condition');
  if (condition === null) return undefined; // `#ifdef`/`#elifdef` carry no condition → unknown
  return evalPreprocessorCondition(condition.text);
}

/**
 * Does `include` sit in a branch the compiler statically discards?
 *
 * Walk the ancestor chain from the include upward. At every conditional
 * (`preproc_if`/`preproc_elif`, and the `#ifdef` family, which is always unknown):
 *   - entered through its BODY (not its `alternative`) and its condition is a KNOWN ZERO
 *     (`#if 0`, `#if (0)`, `#if false`, `#elif 0 && X`) → dead;
 *   - entered through its `alternative` (the `#else`/`#elif`/`#elifdef` chain) and its
 *     condition is a KNOWN NON-ZERO (`#if 1`) → dead: once a group is taken every later
 *     group of the chain is skipped.
 * A nested conditional inside a dead outer one is still dead, because the climb continues
 * to the outer node. An unknown condition never condemns anything.
 */
function isInDeadBranch(include: Node): boolean {
  let child: Node = include;
  let parent: Node | null = include.parent;
  while (parent !== null) {
    if (parent.type === 'preproc_if' || parent.type === 'preproc_elif') {
      const alternative = parent.childForFieldName('alternative');
      const enteredViaAlternative = alternative !== null && alternative.id === child.id;
      const value = conditionValue(parent);
      if (value !== undefined) {
        if (!enteredViaAlternative && value === 0) return true;
        if (enteredViaAlternative && value !== 0) return true;
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * The 1-based line numbers that sit in a statically dead preprocessor group, computed from
 * the TEXT, not the tree. Used only when the tree contains an ERROR node: tree-sitter-c and
 * tree-sitter-cpp both turn `#if __has_include("x.h")` into an ERROR and flatten the rest of
 * the chain into plain siblings, so the ancestor walk above can no longer see that an
 * include sits under a following `#elif 0`.
 *
 * Comments, string literals and character literals are blanked first (newlines kept), and
 * backslash-continued directive lines are joined. The scanner tracks
 * `#if/#ifdef/#ifndef/#elif/#elifdef/#elifndef/#else/#endif` nesting with the same rules as
 * the tree walk: a known-zero group is dead, every group after a known-non-zero group is
 * dead, and an unknown condition is live. An unbalanced directive structure yields an empty
 * set (nothing is dropped), so a scan that cannot be trusted never costs an edge.
 */
export function deadPreprocessorLines(source: string): Set<number> {
  const lines = blankCommentsAndStrings(source).split('\n');
  const dead = new Set<number>();
  interface Frame { outerDead: boolean; taken: boolean; groupDead: boolean }
  const stack: Frame[] = [];
  const currentlyDead = (): boolean => {
    const top = stack[stack.length - 1];
    return top !== undefined && (top.outerDead || top.groupDead);
  };
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    const first = i;
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      text = text.replace(/\\\s*$/, ' ') + lines[++i];
    }
    const m = /^\s*#\s*([A-Za-z_]+)\b(.*)$/.exec(text);
    const directive = m?.[1];
    const rest = m?.[2] ?? '';
    const markRange = (isDead: boolean): void => {
      if (!isDead) return;
      for (let k = first; k <= i; k++) dead.add(k + 1);
    };
    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      const outerDead = currentlyDead();
      markRange(outerDead);
      const value = directive === 'if' ? evalPreprocessorCondition(rest) : undefined;
      stack.push({ outerDead, taken: value !== undefined && value !== 0, groupDead: value === 0 });
      continue;
    }
    if (directive === 'elif' || directive === 'elifdef' || directive === 'elifndef' || directive === 'else') {
      const top = stack[stack.length - 1];
      if (top === undefined) return new Set();
      markRange(top.outerDead);
      if (top.taken) {
        top.groupDead = true;
      } else if (directive === 'elif') {
        const value = evalPreprocessorCondition(rest);
        top.groupDead = value === 0;
        if (value !== undefined && value !== 0) top.taken = true;
      } else {
        top.groupDead = false;
      }
      continue;
    }
    if (directive === 'endif') {
      const top = stack.pop();
      if (top === undefined) return new Set();
      markRange(top.outerDead);
      continue;
    }
    markRange(currentlyDead());
  }
  if (stack.length !== 0) return new Set();
  return dead;
}

/** Replace comments and string/character literals with spaces, keeping every newline, so
 *  directive text inside them is never read as a directive. The quoted header name of an
 *  `#include` line is blanked too; the scanner reads only conditional directives. */
function blankCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '/' && next === '/') {
      let stop = src.indexOf('\n', i);
      if (stop === -1) stop = n;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(n, j + 1);
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Emit one path hint per QUOTED `#include`, and per ANGLE `#include` (as `<name>`, which the
 * resolver looks up only under a compilation database's `-I` roots). The specifier is the
 * header name exactly as written; the resolver (`include-resolve.ts`) tries the includer's
 * directory first, then the include roots, and silences anything that is not exactly one
 * existing file. Macro includes are skipped here, so they never reach the resolver.
 *
 * An include in a statically dead preprocessor group is SKIPPED: a group whose condition is
 * a known zero (`#if 0`, `#if (0)`, `#if false`, `#elif 0`), or any later group of a chain
 * whose earlier condition is a known non-zero (`#else` of `#if 1`). When the tree has an
 * ERROR node, the text scan {@link deadPreprocessorLines} is consulted as well, because the
 * grammar can flatten a conditional chain (`#if __has_include(...)`). Every unknown condition
 * (`#ifdef`, `#if FOO`, `#if defined(...)`) is kept — those are legitimate conditional
 * dependencies.
 */
export function includeUses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();
  let textDead: Set<number> | undefined;
  const deadByText = (line: number): boolean => {
    if (!file.tree.rootNode.hasError) return false;
    textDead ??= deadPreprocessorLines(file.content);
    return textDead.has(line);
  };

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'preproc_include') return undefined;
    const line = node.startPosition.row + 1;
    if (isInDeadBranch(node) || deadByText(line)) return undefined; // statically dead group → no real dependency
    const header = includeHeaderName(node);
    if (header === undefined || header.name === '') return undefined;
    const specifier = header.angle ? `<${header.name}>` : header.name;
    const dedupKey = `${specifier} ${line}`;
    if (seen.has(dedupKey)) return undefined;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier }, 'import', line));
    return undefined;
  });

  return out;
}
