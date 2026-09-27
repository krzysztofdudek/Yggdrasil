// =============================================================================
// Finds the assertions in a test file that pin a sentence of CLI prose.
//
// A test that asserts `toContain('the file is not covered by any node')` breaks
// every time that sentence is reworded, even though the behaviour it meant to
// check (an `unmapped-files` issue was raised) did not change. Such assertions
// are what made each wording change of the output touch tests across the whole
// tree. The golden corpus (tests/fixtures/golden-corpus/) is the one place the
// CLI's exact words are recorded; a behaviour test asserts on the issue code, the
// label, or a JSON field instead (see tests/support/assert-output.ts).
//
// WHAT COUNTS
//   The first argument of an assertion matcher (`toContain`, `toMatch`, `toBe`,
//   `toEqual`, `toStrictEqual`, `toThrow`, `toThrowError`, `stringContaining`,
//   `stringMatching`), when that argument is a string, template or regular
//   expression literal of FIVE or more words. A "word" is a whitespace-separated
//   token carrying at least one letter and not starting with `-` (a command-line
//   flag is part of a command, not of a sentence), after a regular expression's
//   escapes and operators are read as separators. Five words is a rough line
//   between a command or a token (`yg check --approve --only-deterministic` is
//   two words) and a sentence.
//
// WHAT IT IS NOT
//   A parser. It scans text, so an assertion built from a variable, or a literal
//   split across a concatenation, is not seen; it errs towards missing an
//   assertion, never towards flagging a token as prose.
//
// Imports only Node builtins — nothing from src/** — so any tier may use it.
// =============================================================================

/** The matchers whose first argument is inspected. */
const MATCHERS = [
  'toContain',
  'toMatch',
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toThrow',
  'toThrowError',
  'stringContaining',
  'stringMatching',
] as const;

/** Minimum word count for a literal to count as prose. */
export const PROSE_MIN_WORDS = 5;

/** One prose assertion found in a file. */
export interface ProseAssertion {
  /** 1-based line of the matcher call. */
  line: number;
  /** The matcher name, e.g. `toContain`. */
  matcher: string;
  /** The literal's body, without its delimiters. */
  literal: string;
  /** Its word count (always >= PROSE_MIN_WORDS). */
  words: number;
}

const MATCHER_RE = new RegExp(`\\.(${MATCHERS.join('|')})\\(\\s*`, 'g');

/** Read a quoted or template literal starting at `start` (the opening delimiter). */
function readQuoted(src: string, start: number): string | undefined {
  const quote = src[start];
  let out = '';
  let i = start + 1;
  let depth = 0; // `${ … }` nesting inside a template literal
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote === '`' && depth === 0 && ch === '$' && src[i + 1] === '{') {
      depth = 1;
      out += ' ';
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
      continue;
    }
    if (ch === quote) return out;
    if (ch === '\n' && quote !== '`') return undefined;
    out += ch;
    i += 1;
  }
  return undefined;
}

/** Read a regular expression literal starting at `start` (the opening slash). */
function readRegex(src: string, start: number): string | undefined {
  let out = '';
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') return undefined;
    if (ch === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return out;
    out += ch;
    i += 1;
  }
  return undefined;
}

/** Word count of a string literal body (escapes read as the character they stand for). */
function countStringWords(body: string): number {
  const text = body.replace(/\\n|\\t/g, ' ').replace(/\\(.)/g, '$1');
  return countWords(text);
}

/** Tokens that carry a letter and are not a command-line flag. */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !w.startsWith('-')).length;
}

/** Word count of a regular expression body: escapes and operators are separators. */
function countRegexWords(body: string): number {
  const text = body
    .replace(/\\[sSdDwWbBnt]/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[\^$()|?*+{}[\]]/g, ' ');
  return countWords(text);
}

/** Every prose assertion in one test file's source text, in file order. */
export function findProseAssertions(source: string): ProseAssertion[] {
  const found: ProseAssertion[] = [];
  MATCHER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATCHER_RE.exec(source)) !== null) {
    const at = m.index + m[0].length;
    const open = source[at];
    let literal: string | undefined;
    let words = 0;
    if (open === "'" || open === '"' || open === '`') {
      literal = readQuoted(source, at);
      if (literal !== undefined) words = countStringWords(literal);
    } else if (open === '/') {
      literal = readRegex(source, at);
      if (literal !== undefined) words = countRegexWords(literal);
    }
    if (literal === undefined || words < PROSE_MIN_WORDS) continue;
    const line = source.slice(0, m.index).split('\n').length;
    found.push({ line, matcher: m[1], literal, words });
  }
  return found;
}
