import { Parser, type Node, type Tree } from 'web-tree-sitter';

/**
 * Kotlin parse recovery for the relation extractor.
 *
 * WHY: the shipped tree-sitter-kotlin grammar predates Kotlin 2.2. Three stable forms of
 * newer Kotlin — a `when` guard (`is String if s.isNotEmpty() ->`), a multi-dollar string
 * (`$$"price: $$amount"`) and a context-parameter clause (`context(log: Logger)`) — make it
 * give up: everything from the construct to the end of the file becomes ONE `ERROR` node with
 * no usable children. Every declaration after the construct then vanished from the symbol
 * table, silently. That is a missed dependency for an import of any of them, and — worse —
 * when one of those declarations was a duplicate of a key another file also declares, the
 * other file became the unique definer and an ambiguity flipped into a WRONG edge.
 *
 * WHAT: `kotlinView` turns a parsed file into the set of trustworthy parse nodes to walk, plus
 * what could only be read lexically:
 *   1. A file whose tree holds no ERROR node is used as-is (the common case, no extra work;
 *      zero-width MISSING tokens alone do not count, see `damaged`).
 *   2. Otherwise the three known forms are BLANKED — replaced by spaces, same length, so every
 *      row and column stays put — and the file is re-parsed. A clean re-parse is used as-is.
 *   3. Whatever is still damaged is split into top-level declarations by a small lexer (a
 *      declaration starts on a column-0 line at bracket depth 0) and each one is re-parsed on
 *      its own, padded so its rows and columns match the file. A clean declaration is walked
 *      like any other; a declaration that still fails contributes only the name read from its
 *      leading tokens (`class X`, `fun f`, `val v`), never the nodes of a broken parse.
 *   4. What cannot be read at all is reported as INCOMPLETE: the whole package (a declaration
 *      whose name is unreadable, or a lexer that lost track of the brackets) or one type's
 *      members (a class whose body did not parse). The extractor turns these into marker
 *      declarations the resolver uses to fail closed — see resolver.ts `incompletenessMarkers`.
 *
 * The blanking runs ONLY on a file that already failed to parse, so a wrong guess can never
 * disturb a file the grammar reads correctly; the worst it can do is leave a damaged file
 * damaged, which step 3 and 4 then handle.
 *
 * THE GRAMMAR SITUATION (why this is recovery, not a grammar fix): the shipped
 * `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0 (2025-01) is a fork that stopped moving (its
 * when-guard PR is still open). The upstream it forked from, fwcd/tree-sitter-kotlin, parses
 * when-guards and multi-dollar strings on main but has no npm release (npm `tree-sitter-kotlin`
 * is an old 0.3.x), uses different node types (37 of the Kotlin matrix and AST tests fail on
 * it), and still errors on context parameters. Choosing a fork and building it from a pinned
 * commit is a grammar-packaging decision; until then this module keeps the extractor honest on
 * the shipped grammar. When a grammar that reads these forms lands, a file it parses cleanly
 * takes the first branch below and none of this runs.
 */

/** A declaration read from a damaged declaration's leading tokens. */
export interface LexicalDecl {
  name: string;
  /** `type`: class / interface / object (may own nested members); `callable`: fun / val /
   *  var / typealias (a top-level callable owns no importable members). */
  kind: 'type' | 'callable';
  line: number;
}

export interface KotlinView {
  /** Parse nodes whose subtrees parsed without error (walkers still skip any `ERROR`). */
  roots: Node[];
  /** Top-level declarations recovered only lexically. */
  lexical: LexicalDecl[];
  /** True when some part of the file could not be read at all: the file may declare anything
   *  in its package. */
  packageIncomplete: boolean;
  /** Simple names of top-level types whose members could not all be read. */
  incompleteTypes: Set<string>;
  /** Release the WASM trees created for the recovery. Idempotent. */
  dispose(): void;
}

// ── lexer ──────────────────────────────────────────────────────────────────────

type TokKind = 'id' | 'p' | 'str' | 'nl';
interface Tok { kind: TokKind; start: number; end: number; text: string; line: number; col: number; dollars?: number }

const IDENT_START = /[A-Za-z_À-￿]/;
const IDENT_PART = /[A-Za-z0-9_À-￿]/;

/**
 * Tokenize Kotlin source into identifiers, punctuation, opaque string literals and newlines.
 * Comments are dropped. A string literal (plain, raw `"""`, or multi-dollar `$$"…"`) is one
 * token; its `${…}` templates are skipped with their brackets balanced, honoring the literal's
 * dollar count (in `$$"…"` only `$${` opens a template). `unbalanced` reports a literal or
 * comment that runs off the end of the text.
 */
function tokenize(text: string): { toks: Tok[]; unbalanced: boolean } {
  const toks: Tok[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  let unbalanced = false;
  const n = text.length;

  const push = (kind: TokKind, start: number, end: number, extra?: Partial<Tok>): void => {
    toks.push({ kind, start, end, text: text.slice(start, end), line, col: start - lineStart, ...extra });
  };
  const newlineAt = (pos: number): void => { line++; lineStart = pos + 1; };

  /** Skip a string body starting right after its opening quote(s); returns the index after the
   *  closing quote(s). Tracks newlines. */
  const skipString = (from: number, raw: boolean, dollars: number): number => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\n') { newlineAt(j); j++; continue; }
      if (!raw && c === '\\') { j += 2; continue; }
      if (c === '"') {
        if (!raw) return j + 1;
        if (text.startsWith('"""', j)) {
          let k = j + 3;
          while (k < n && text[k] === '"') k++; // `""""` closes on the LAST three quotes
          return k;
        }
        j++;
        continue;
      }
      if (c === '$') {
        let k = j;
        while (k < n && text[k] === '$') k++;
        if (k - j >= dollars && text[k] === '{') { j = skipTemplate(k + 1); continue; }
        j = k;
        continue;
      }
      j++;
    }
    unbalanced = true;
    return n;
  };

  /** Skip a `${ … }` template body (code) up to its matching `}`. */
  const skipTemplate = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\n') { newlineAt(j); j++; continue; }
      if (c === '"') {
        const raw = text.startsWith('"""', j);
        j = skipString(j + (raw ? 3 : 1), raw, 1);
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    unbalanced = true;
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') { push('nl', i, i + 1); newlineAt(i); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '\n') newlineAt(i);
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) unbalanced = true;
      continue;
    }
    if (c === '$') {
      // In code a `$` run is only ever the prefix of a multi-dollar string literal.
      let k = i;
      while (k < n && text[k] === '$') k++;
      if (text[k] === '"') {
        const startLine = line;
        const startCol = i - lineStart;
        const raw = text.startsWith('"""', k);
        const end = skipString(k + (raw ? 3 : 1), raw, k - i);
        toks.push({ kind: 'str', start: i, end, text: text.slice(i, end), line: startLine, col: startCol, dollars: k - i });
        i = end;
        continue;
      }
      push('p', i, k);
      i = k;
      continue;
    }
    if (c === '"') {
      const startLine = line;
      const startCol = i - lineStart;
      const raw = text.startsWith('"""', i);
      const end = skipString(i + (raw ? 3 : 1), raw, 1);
      toks.push({ kind: 'str', start: i, end, text: text.slice(i, end), line: startLine, col: startCol, dollars: 1 });
      i = end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      push('str', i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`' && text[j] !== '\n') j++;
      push('id', i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (IDENT_START.test(c) || /[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(text[j])) j++;
      push('id', i, j);
      i = j;
      continue;
    }
    if (c === '-' && text[i + 1] === '>') { push('p', i, i + 2); i += 2; continue; }
    push('p', i, i + 1);
    i++;
  }
  return { toks, unbalanced };
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'open', 'final', 'abstract', 'sealed', 'data',
  'enum', 'annotation', 'inner', 'value', 'inline', 'noinline', 'crossinline', 'override',
  'lateinit', 'const', 'suspend', 'tailrec', 'operator', 'infix', 'external', 'expect',
  'actual', 'companion', 'vararg', 'reified', 'out', 'in',
]);

const DECL_KEYWORDS = new Set(['class', 'interface', 'object', 'fun', 'val', 'var', 'typealias', 'constructor', 'init', 'import', 'package']);

// ── blanking the three known forms ────────────────────────────────────────────

/** Index of the token closing the bracket opened at `open`, or -1. */
function matching(toks: Tok[], open: number): number {
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'p') continue;
    if (OPEN.has(t.text)) depth++;
    else if (CLOSE.has(t.text)) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** The index of the next non-newline token at or after `from`, or -1. */
function nextReal(toks: Tok[], from: number): number {
  for (let j = from; j < toks.length; j++) if (toks[j].kind !== 'nl') return j;
  return -1;
}

/** True when token `idx` is the first token on its line, or follows only modifiers there. */
function startsDeclarationLine(toks: Tok[], idx: number): boolean {
  for (let j = idx - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.kind === 'nl') return true;
    if (t.kind === 'id' && MODIFIERS.has(t.text)) continue;
    return false;
  }
  return true;
}

/** Character ranges `[start, end)` to blank: multi-dollar prefixes, context clauses, and
 *  `when` guards. */
function blankRanges(toks: Tok[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // (a) `$$"…"` → blank the dollar run; the literal reads as a plain string.
    if (t.kind === 'str' && (t.dollars ?? 1) >= 2) out.push([t.start, t.start + (t.dollars ?? 0)]);
    // (b) `context(…)` heading a declaration, followed by the declaration itself.
    if (t.kind === 'id' && t.text === 'context' && startsDeclarationLine(toks, i)) {
      const open = i + 1;
      if (toks[open]?.kind === 'p' && toks[open].text === '(') {
        const close = matching(toks, open);
        const after = close === -1 ? -1 : nextReal(toks, close + 1);
        if (after !== -1 && (toks[after].kind === 'id' || toks[after].text === '@')) {
          out.push([t.start, toks[close].end]);
        }
      }
    }
  }

  // (c) `when` guards: inside a `when { … }` body, an `if` in an entry's CONDITION (before the
  // entry's `->`, at the entry's own bracket depth, with no `else` after it) starts a guard;
  // blank from `if` up to the `->`.
  interface Frame { brace: string; when: boolean; inCond: boolean; guardAt: number; sawElseAfterIf: boolean }
  const stack: Frame[] = [];
  let pendingWhen = false; // saw `when`, its body `{` not reached yet
  let whenParenDepth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const top = stack[stack.length - 1];
    if (t.kind === 'id' && t.text === 'when') { pendingWhen = true; whenParenDepth = 0; continue; }
    if (t.kind === 'p' && OPEN.has(t.text)) {
      if (pendingWhen && t.text === '(') whenParenDepth++;
      const isWhenBody = pendingWhen && t.text === '{' && whenParenDepth === 0;
      if (isWhenBody) pendingWhen = false;
      stack.push({ brace: t.text, when: isWhenBody, inCond: isWhenBody, guardAt: -1, sawElseAfterIf: false });
      continue;
    }
    if (t.kind === 'p' && CLOSE.has(t.text)) {
      if (pendingWhen && t.text === ')' && whenParenDepth > 0) whenParenDepth--;
      stack.pop();
      continue;
    }
    if (pendingWhen && whenParenDepth === 0 && t.kind !== 'nl') {
      // anything but the subject's `(…)` before the `{` means this `when` is not a statement head
      if (!(t.kind === 'p' && t.text === '(')) pendingWhen = false;
    }
    if (top === undefined || !top.when) continue;
    // Direct child token of a when body.
    if (top.inCond) {
      if (t.kind === 'id' && t.text === 'if' && top.guardAt === -1) { top.guardAt = i; top.sawElseAfterIf = false; continue; }
      if (t.kind === 'id' && t.text === 'else' && top.guardAt !== -1) { top.sawElseAfterIf = true; continue; }
      if (t.kind === 'p' && t.text === '->') {
        if (top.guardAt !== -1 && !top.sawElseAfterIf) out.push([toks[top.guardAt].start, t.start]);
        top.inCond = false;
        top.guardAt = -1;
        continue;
      }
      // A guard's `if` and its `->` share one line; a condition line without `->` (a
      // multi-line condition, or a statement body read as a condition) drops any `if` seen.
      if (t.kind === 'nl') top.guardAt = -1;
    } else if (t.kind === 'nl' || (t.kind === 'p' && t.text === ';')) {
      top.inCond = true; // the entry's body ended; the next entry's condition begins
      top.guardAt = -1;
    }
  }
  return out;
}

function applyBlanks(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const [s, e] of ranges) for (let k = s; k < e; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

// ── chunking and header reading ───────────────────────────────────────────────

interface Chunk { start: number; end: number; toks: Tok[] }

/**
 * Split the tokens of a damaged span into top-level declarations. A new declaration starts at a
 * token that begins a column-0 line at bracket depth 0 — unless everything the current chunk
 * holds so far is an annotation / modifier prefix (`@Foo(…)` on the line above a `class`).
 * `balanced` is false when the span ends inside brackets: the lexer lost track, so the split
 * cannot be trusted to have found every declaration.
 */
function chunkSpan(toks: Tok[], spanStart: number, spanEnd: number): { chunks: Chunk[]; balanced: boolean } {
  const chunks: Chunk[] = [];
  let depth = 0;
  let cur: Chunk | undefined;
  let prefixOnly = true;
  let lineHasTok = false;
  for (const t of toks) {
    if (t.start < spanStart || t.start >= spanEnd) continue;
    if (t.kind === 'nl') { lineHasTok = false; continue; }
    const firstOnLine = !lineHasTok;
    lineHasTok = true;
    if (depth === 0 && firstOnLine && t.col === 0 && !(t.kind === 'p' && CLOSE.has(t.text)) && (cur === undefined || !prefixOnly)) {
      if (cur !== undefined) chunks.push(cur);
      cur = { start: t.start, end: t.end, toks: [] };
      prefixOnly = true;
    }
    if (cur === undefined) { cur = { start: t.start, end: t.end, toks: [] }; prefixOnly = true; }
    cur.toks.push(t);
    cur.end = t.end;
    if (depth === 0 && prefixOnly) {
      const isPrefixTok = (t.kind === 'p' && (t.text === '@' || t.text === '.' || t.text === ':' || OPEN.has(t.text)))
        || (t.kind === 'id' && !DECL_KEYWORDS.has(t.text));
      if (!isPrefixTok) prefixOnly = false;
    }
    if (t.kind === 'p' && OPEN.has(t.text)) depth++;
    else if (t.kind === 'p' && CLOSE.has(t.text)) depth = Math.max(0, depth - 1);
  }
  if (cur !== undefined) chunks.push(cur);
  return { chunks, balanced: depth === 0 };
}

/** Skip a balanced `<…>` starting at `i` (which must be `<`); returns the index after it. */
function skipAngles(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind === 'p' && t.text === '<') depth++;
    else if (t.kind === 'p' && t.text === '>') { depth--; if (depth === 0) return j + 1; }
    else if (t.kind === 'p' && (t.text === '{' || t.text === '=')) return j;
  }
  return toks.length;
}

/**
 * Read the declaration a chunk's leading tokens name: annotations and modifiers, then
 * `class|interface|object|fun interface` + name (a TYPE), `typealias` + name, `fun` [`<…>`]
 * [receiver `.`] name `(` or `val|var` [`<…>`] [receiver `.`] name (a CALLABLE). Returns
 * `null` for a destructuring `val (a, b)` (declares no key), `undefined` when the header is not
 * readable.
 */
function readHeader(chunk: Chunk): LexicalDecl | null | undefined {
  const toks = chunk.toks.filter((t) => t.kind !== 'nl');
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'p' && t.text === '@') {
      i++;
      if (toks[i]?.kind === 'p' && toks[i].text === '[') { const m = matching(toks, i); if (m === -1) return undefined; i = m + 1; continue; }
      // `@file:Name`, `@get:Name`, `@a.b.Name`, then an optional `(…)` argument list
      while (toks[i]?.kind === 'id') {
        i++;
        if (toks[i]?.kind === 'p' && (toks[i].text === '.' || toks[i].text === ':')) { i++; continue; }
        break;
      }
      if (toks[i]?.kind === 'p' && toks[i].text === '<') i = skipAngles(toks, i);
      if (toks[i]?.kind === 'p' && toks[i].text === '(') { const m = matching(toks, i); if (m === -1) return undefined; i = m + 1; }
      continue;
    }
    if (t.kind === 'id' && MODIFIERS.has(t.text)) { i++; continue; }
    break;
  }
  const kw = toks[i];
  if (kw === undefined || kw.kind !== 'id') return undefined;
  const line = kw.line + 1;
  const nameAt = (j: number): string | undefined => (toks[j]?.kind === 'id' ? toks[j].text.replace(/`/g, '') : undefined);

  if (kw.text === 'class' || kw.text === 'interface' || kw.text === 'object') {
    const name = nameAt(i + 1);
    return name === undefined ? undefined : { name, kind: 'type', line };
  }
  if (kw.text === 'typealias') {
    const name = nameAt(i + 1);
    return name === undefined ? undefined : { name, kind: 'callable', line };
  }
  if (kw.text === 'fun' && toks[i + 1]?.kind === 'id' && toks[i + 1].text === 'interface') {
    const name = nameAt(i + 2);
    return name === undefined ? undefined : { name, kind: 'type', line };
  }
  if (kw.text === 'fun' || kw.text === 'val' || kw.text === 'var') {
    let j = i + 1;
    if (toks[j]?.kind === 'p' && toks[j].text === '<') j = skipAngles(toks, j);
    if (kw.text !== 'fun' && toks[j]?.kind === 'p' && toks[j].text === '(') return null; // destructuring
    // The name is the last identifier before the terminator at angle depth 0: `(` for a fun;
    // `:` / `=` / `by` / `{` / end of line for a property. A receiver `List<T>.` comes first.
    const terminators = kw.text === 'fun' ? new Set(['(']) : new Set([':', '=', '{', ';']);
    let angle = 0;
    let last: string | undefined;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.line !== kw.line && kw.text !== 'fun') break; // a property's name sits on its own line
      if (t.kind === 'p' && t.text === '<') { angle++; continue; }
      if (t.kind === 'p' && t.text === '>') { angle--; continue; }
      if (angle > 0) continue;
      if (t.kind === 'p' && terminators.has(t.text)) break;
      if (t.kind === 'id' && kw.text !== 'fun' && t.text === 'by') break;
      if (t.kind === 'p' && t.text === '(' ) return undefined; // a receiver of function type — not read
      if (t.kind === 'id') last = t.text.replace(/`/g, '');
      else if (!(t.kind === 'p' && (t.text === '.' || t.text === '?' || t.text === ','))) return undefined;
    }
    return last === undefined ? undefined : { name: last, kind: 'callable', line };
  }
  return undefined;
}

/** The clean top-level nodes that together hold every token of `chunk`, or undefined when some
 *  token lies outside all of them (the chunk touches damage). */
function coveringNodes(chunk: Chunk, clean: Node[]): Node[] | undefined {
  const used: Node[] = [];
  for (const t of chunk.toks) {
    if (t.kind === 'nl') continue;
    // `clean` is in source order: find the last node starting at or before the token.
    let lo = 0;
    let hi = clean.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (clean[mid].startIndex <= t.start) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const c = at === -1 ? undefined : clean[at];
    if (c === undefined || t.end > c.endIndex) return undefined;
    if (!used.includes(c)) used.push(c);
  }
  return used;
}

// ── the view ──────────────────────────────────────────────────────────────────

/**
 * True when `node` holds an `ERROR` node. A tree whose only defects are zero-width MISSING
 * tokens is structurally whole — the shipped grammar inserts a MISSING member separator after
 * every one-line class body (`class A { val x = 1 }`) — so it is read as it stands.
 */
function damaged(node: Node): boolean {
  if (!node.hasError) return false;
  if (node.type === 'ERROR') return true;
  return node.descendantsOfType('ERROR').length > 0;
}

/** Parse the text of `[start, end)` of `text`, padded with newlines and spaces so its rows and
 *  columns match the file. */
function parseAt(parser: Parser, text: string, start: number, end: number): Tree | null {
  const before = text.slice(0, start);
  const rows = (before.match(/\n/g) ?? []).length;
  const col = start - (before.lastIndexOf('\n') + 1);
  // The trailing newline ends the last statement: without it the grammar reports a missing
  // member separator after a one-line class body at end of input.
  return parser.parse('\n'.repeat(rows) + ' '.repeat(col) + text.slice(start, end) + '\n');
}

/**
 * The trustworthy view of a Kotlin file for relation extraction. See the file doc comment. The
 * caller MUST call `dispose()` when done (the recovery may create WASM trees).
 */
export function kotlinView(tree: Tree, content: string): KotlinView {
  const root = tree.rootNode;
  if (!damaged(root)) {
    return { roots: [root], lexical: [], packageIncomplete: false, incompleteTypes: new Set(), dispose: () => {} };
  }

  const owned: Tree[] = [];
  const parser = new Parser();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const t of owned) t.delete();
    parser.delete();
  };

  try {
    parser.setLanguage(tree.language);
    const { toks, unbalanced: lexUnbalanced } = tokenize(content);
    const text = applyBlanks(content, blankRanges(toks));
    let base = tree;
    if (text !== content) {
      const reparsed = parser.parse(text);
      if (reparsed !== null) { owned.push(reparsed); base = reparsed; }
    }
    const view: KotlinView = { roots: [], lexical: [], packageIncomplete: false, incompleteTypes: new Set(), dispose };
    if (!damaged(base.rootNode)) { view.roots.push(base.rootNode); return view; }
    // From here on the split into declarations rests on the lexer; a literal or comment it saw
    // run off the end means it cannot be trusted to have found every declaration.
    if (lexUnbalanced) view.packageIncomplete = true;

    // Split the WHOLE file into top-level declarations lexically, then trust tree-sitter one
    // declaration at a time. The error-recovered tree cannot be trusted about where its damage
    // ends: a clean-looking `class Box` node may have lost its body, and text after an ERROR
    // may belong to no node at all. So a declaration is taken from the file's tree only when
    // every one of its tokens lies inside a clean top-level node; any other declaration is
    // re-parsed on its own.
    const baseToks = base === tree ? toks : tokenize(text).toks;
    const clean: Node[] = [];
    for (let i = 0; i < base.rootNode.childCount; i++) {
      const c = base.rootNode.child(i);
      if (c !== null && !damaged(c)) clean.push(c);
    }
    const { chunks, balanced } = chunkSpan(baseToks, 0, text.length);
    if (!balanced) view.packageIncomplete = true;
    const taken = new Set<number>();
    for (const chunk of chunks) {
      const covering = coveringNodes(chunk, clean);
      if (covering !== undefined) {
        for (const c of covering) if (!taken.has(c.id)) { taken.add(c.id); view.roots.push(c); }
        continue;
      }
      const t = parseAt(parser, text, chunk.start, chunk.end);
      if (t !== null) owned.push(t);
      if (t !== null && !damaged(t.rootNode)) {
        view.roots.push(t.rootNode);
        continue;
      }
      const header = readHeader(chunk);
      if (header === undefined) { view.packageIncomplete = true; continue; }
      if (header === null) continue;
      view.lexical.push(header);
      if (header.kind === 'type') view.incompleteTypes.add(header.name);
    }
    return view;
  } catch (err) {
    dispose();
    throw err;
  }
}
