import { extname } from 'node:path';
import type { Tree } from 'web-tree-sitter';
import { findComments } from './find-comments.js';
import { getLanguageForExtension } from '../core/graph/language-registry.js';
import { toPosixPath } from '../utils/posix.js';
import type { IssueMessage } from '../model/validation.js';

export interface SuppressedRange {
  aspectIds: Set<string>;
  startLine: number;   // 1-based, inclusive
  endLine: number;     // 1-based, inclusive
  isWildcard: boolean;
}

export class SuppressMarkerError extends Error {
  public readonly code = 'SUPPRESS_MARKER_MISSING_REASON';
  /**
   * Self-describing what/why/next for the malformed marker. A reasonless marker
   * is a fault in the SOURCE file's marker — NOT in the aspect's check.mjs — so
   * the deterministic runners re-surface this as its own diagnostic instead of an
   * `aspect-check-runtime-error`. (The LLM-sizing paths build their own message
   * from `file`/`line`; only the deterministic consumers read `messageData`.)
   */
  public readonly messageData: IssueMessage;
  constructor(message: string, public file: string, public line: number) {
    super(message);
    this.name = 'SuppressMarkerError';
    const loc = `${toPosixPath(file)}:${line}`;
    this.messageData = {
      what: `Malformed yg-suppress marker at ${loc} — it is missing the required reason after the aspect id.`,
      why: `A single-line or disable marker must carry a reason after its closing parenthesis; a reasonless marker cannot be honored. This is a fault in the source file's marker, not in the aspect's check.`,
      next: `Add a reason to the marker at ${loc}, or remove it.`,
    };
  }
}

interface ParsedMarker {
  kind: 'single' | 'disable' | 'enable';
  aspectIds: string[];
  reason: string;
  line: number; // 1-based
}

// ── Anchored marker grammar (single shared matcher) ─────────────────────────
//
// A marker is recognized only when the `yg-suppress` / `yg-suppress-disable` /
// `yg-suppress-enable` token is the FIRST token of its (comment) line — preceded
// only by optional whitespace plus AT MOST ONE comment-delimiter token from the
// whitelist below — and every listed aspect id matches `*` or
// `[A-Za-z0-9_][A-Za-z0-9_./-]*`. Prose that merely mentions the syntax
// mid-sentence, a backtick-quoted `yg-suppress(...)`, a quotation-style
// `// // yg-suppress(...)`, or a marker-shaped token following code on a
// raw-scanned line is NOT a marker: it is neither honored by any reviewer nor
// listed by `yg suppressions`.
//
// Delimiter whitelist (at most ONE leading token): `//`-family line comments
// (incl. `///`, `//!`), `/*`-family block openers (incl. `/**`), `*`-family
// block-comment continuation lines, `#` (shell, Python, YAML, Ruby), `--`
// (SQL, Lua, Haskell), `;` (Lisp, INI, assembly), `<!--` (HTML, XML, Markdown),
// `{-` (Haskell block), `(*` (OCaml, Pascal), `!` (Fortran), `%` (TeX, Erlang,
// Prolog), `'` (VB), `"` (Vim).
// The delimiter alternation, shared by the optional and required leader forms so
// the whitelist is defined in exactly one place. Group 1 (the whole delimiter)
// is captured so closer-stripping can be leader-aware (see stripCloser).
const LEADER_DELIM = String.raw`\/\/[/!]*|\/\*+|\*+|#+|--+|;+|<!--|\{-|\(\*|[!%'"]`;
// Optional-delimiter leader: consumed when scanning a grammar file's COMMENT
// nodes (the text is already comment-isolated, and a block-comment interior line
// legitimately has no leading delimiter).
const RE_LEADER_OPTIONAL = new RegExp(String.raw`^\s*(${LEADER_DELIM})?\s*`);
// Mandatory-delimiter leader: required when RAW-scanning a non-grammar file
// (`.md`/`.sql`/`.sh`/…). Raw-scanned text is NOT comment-isolated, so a line
// that merely BEGINS with the token — a wrapped English sentence or a
// string-literal line — must NOT be a marker. A real `# yg-suppress(...)` /
// `-- yg-suppress(...)` / `<!-- yg-suppress(...) -->` still qualifies.
const RE_LEADER_REQUIRED = new RegExp(String.raw`^\s*(${LEADER_DELIM})\s*`);

// The marker token itself, anchored immediately after the leader. `[^)]*?`
// keeps the id list on one line; ids are validated against RE_ASPECT_ID below.
const RE_MARKER = /^yg-suppress(-disable|-enable)?\(\s*([^)]*?)\s*\)\s*(.*)$/;

// An aspect id is `*` (wildcard) or a path-ish identifier (like
// `security/input-validation`). Anything else (`...`, `<aspect-id>`) is prose,
// not a marker.
const RE_ASPECT_ID = /^(?:\*|[A-Za-z0-9_][A-Za-z0-9_./-]*)$/;

// Block-comment terminators ending the marker's own line are comment syntax, not
// reason text — but ONLY the terminator matching the leader that actually opened
// the comment (see stripCloser). `RE_ANY_CLOSER` is the permissive union, used
// only for a block-comment INTERIOR line that carries no leader of its own.
const RE_ANY_CLOSER = /\s*(?:\*+\/|-->|-\}|\*\))\s*$/;
const RE_CLOSER_CSTYLE = /\s*\*+\/\s*$/;   // `*/` after /*, /**, or a `*` continuation
const RE_CLOSER_HTML = /\s*-->\s*$/;       // `-->` after <!--
const RE_CLOSER_HASKELL = /\s*-\}\s*$/;    // `-}` after {-
const RE_CLOSER_OCAML = /\s*\*\)\s*$/;     // `*)` after (*

/**
 * Strip a trailing block-comment terminator from the reason, but ONLY when it can
 * be comment syntax for the delimiter that actually opened the marker's line.
 * Otherwise the terminator is literal reason text and must survive — e.g. a
 * `//`-family LINE comment whose reason legitimately ends in a star-slash pair
 * keeps that pair (a line comment has no closer to strip).
 *
 * `leader` is the captured delimiter (undefined for a block-comment interior line
 * with no leader, where the block's own closer may still appear with no leading
 * star — that case keeps the permissive strip).
 */
function stripCloser(reason: string, leader: string | undefined): string {
  if (leader === undefined) return reason.replace(RE_ANY_CLOSER, '');
  if (leader.startsWith('//')) return reason;                                  // //, ///, //!
  if (leader.startsWith('/*') || /^\*+$/.test(leader)) return reason.replace(RE_CLOSER_CSTYLE, '');
  if (leader === '<!--') return reason.replace(RE_CLOSER_HTML, '');
  if (leader === '{-') return reason.replace(RE_CLOSER_HASKELL, '');
  if (leader === '(*') return reason.replace(RE_CLOSER_OCAML, '');
  return reason;                                                               // #, --, ;, !, %, ', " — line comments, no closer
}

interface MarkerLineMatch {
  kind: 'single' | 'disable' | 'enable';
  aspectIds: string[];
  reason: string;
}

function splitAspectList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Match ONE line of text against the anchored marker grammar. Returns null when
 * the line carries no marker. This is the single matcher consumed by BOTH the
 * reviewer-honoring path (`parseMarker` → `collectSuppressions`) and the
 * inventory path (`scanLineInto` → `scanSuppressionMarkers` /
 * `scanSuppressionMarkersInComments`), so the two paths cannot diverge on which
 * token counts as a marker.
 *
 * `requireDelimiter` gates the leading comment delimiter by whether the caller
 * fed comment-isolated text: it is FALSE for a grammar file's comment nodes (the
 * text is already known to be a comment, and a block-comment interior line may
 * have no delimiter) and TRUE for a raw-scanned non-grammar file (the delimiter
 * is the only thing distinguishing a real comment marker from bare prose/string
 * text). The honoring path and the inventory path pass the SAME value for the
 * SAME file class, so they never diverge.
 */
function matchMarkerLine(line: string, requireDelimiter: boolean): MarkerLineMatch | null {
  // Every scan path splits on '\n', which leaves a trailing '\r' on each line of
  // a CRLF-authored file. Strip it here — the single choke point BOTH the
  // honoring and the inventory paths share — so a marker in a CRLF file is
  // honored identically to an LF file. Without this, RE_MARKER's `(.*)$` (no `m`
  // flag) would glue the '\r' onto the reason and a reasonless marker would fail
  // open while a marker WITH a reason would silently fail to match.
  if (line.endsWith('\r')) line = line.slice(0, -1);
  const leader = (requireDelimiter ? RE_LEADER_REQUIRED : RE_LEADER_OPTIONAL).exec(line);
  // Mandatory-delimiter (raw-scan) mode: no recognized comment delimiter ⇒ not a
  // marker (RE_LEADER_OPTIONAL always matches the empty prefix, so this is only
  // reachable in required mode).
  if (leader === null) return null;
  const m = RE_MARKER.exec(line.slice(leader[0].length));
  if (m === null) return null;
  const aspectIds = splitAspectList(m[2]);
  if (aspectIds.length === 0) return null;
  if (!aspectIds.every((id) => RE_ASPECT_ID.test(id))) return null;
  const kind = m[1] === '-disable' ? 'disable' : m[1] === '-enable' ? 'enable' : 'single';
  const reason = kind === 'enable' ? '' : stripCloser(m[3], leader[1]).trim();
  return { kind, aspectIds, reason };
}

function parseMarker(lineText: string, line: number, file: string, requireDelimiter: boolean): ParsedMarker | null {
  const m = matchMarkerLine(lineText, requireDelimiter);
  if (m === null) return null;
  if (m.kind !== 'enable' && m.reason === '') {
    throw new SuppressMarkerError(
      `yg-suppress${m.kind === 'disable' ? '-disable' : ''}(${m.aspectIds.join(', ')}) missing reason at ${file}:${line}`,
      file,
      line,
    );
  }
  return { kind: m.kind, aspectIds: m.aspectIds, reason: m.reason, line };
}

/**
 * Build the suppressed-line ranges for a file.
 *
 * Two collection strategies, chosen by whether the file's extension has a
 * registered tree-sitter grammar:
 *
 * - AST path (registered grammar + a parsed `tree`): markers are read from the
 *   file's comment nodes, line by line, so a `yg-suppress(...)` that merely
 *   appears inside a string literal is never mistaken for a real marker, and a
 *   marker deep inside a multi-line block comment is stamped at its own row.
 * - Text path (no registered grammar, e.g. `.sql`/`.md`/`.sh`): the parse tree
 *   cannot be produced, so markers are found by scanning the raw lines of
 *   `content`. This is what lets a content-only deterministic check suppress a
 *   violation in a non-AST-language file — but because raw-scanned text is NOT
 *   comment-isolated, the marker line MUST begin with a comment delimiter
 *   (`#`/`--`/`<!--`/…): a bare prose or string-literal line that merely starts
 *   with the token is not a marker. Requires `content` to be supplied; if it is
 *   omitted for such a file, no ranges are produced (nothing to scan).
 *
 * The range-building logic below is identical for both strategies.
 */
export function collectSuppressions(
  tree: Tree | undefined,
  file: string,
  totalLines: number,
  content?: string,
): SuppressedRange[] {
  const hasGrammar = getLanguageForExtension(extname(file)) !== null;
  const markers: ParsedMarker[] = [];
  if (hasGrammar && tree) {
    const comments = findComments({ path: file, ast: tree });
    for (const c of comments) {
      // Iterate the comment's LINES so a marker on the Nth line of a multi-line
      // block comment is stamped at its own absolute file row — the same row
      // mapping the inventory scanner uses.
      const commentLines = c.text.split('\n');
      for (let i = 0; i < commentLines.length; i++) {
        // Comment-isolated text: the delimiter is OPTIONAL (a block-comment
        // interior line may have none).
        const m = parseMarker(commentLines[i], c.startPosition.row + i + 1, file, false);
        if (m) markers.push(m);
      }
    }
  } else if (content !== undefined) {
    // No grammar (or no tree): scan raw lines. Raw text is NOT comment-isolated,
    // so the leading comment delimiter is MANDATORY — a marker written in real
    // comment syntax (`--`, `#`, `<!--` …) is recognized, but a marker-shaped
    // token following code on the same line, buried mid-sentence, or beginning a
    // bare (delimiter-less) prose/string line is not.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = parseMarker(lines[i], i + 1, file, true);
      if (m) markers.push(m);
    }
  } else {
    // A non-AST file with no content to scan — nothing is suppressible.
    return [];
  }
  markers.sort((a, b) => a.line - b.line);

  const ranges: SuppressedRange[] = [];
  const openSpecific = new Map<string, number>();
  let openWildcard: number | null = null;

  for (const m of markers) {
    if (m.kind === 'single') {
      const isWildcard = m.aspectIds.includes('*');
      ranges.push({ aspectIds: new Set(m.aspectIds), startLine: m.line + 1, endLine: m.line + 1, isWildcard });
    } else if (m.kind === 'disable') {
      for (const id of m.aspectIds) {
        if (id === '*') { if (openWildcard === null) openWildcard = m.line + 1; }
        else { if (!openSpecific.has(id)) openSpecific.set(id, m.line + 1); }
      }
    } else { // enable
      for (const id of m.aspectIds) {
        if (id === '*') {
          if (openWildcard !== null) {
            // Guard the degenerate span an enable directly after its disable
            // produces (start = disableLine+1, end = enableLine-1, so end < start):
            // an inverted range is nonsense in the LLM prompt and empty everywhere.
            if (m.line - 1 >= openWildcard) {
              ranges.push({ aspectIds: new Set(['*']), startLine: openWildcard, endLine: m.line - 1, isWildcard: true });
            }
            openWildcard = null;
          }
        } else {
          const start = openSpecific.get(id);
          if (start !== undefined) {
            if (m.line - 1 >= start) {
              ranges.push({ aspectIds: new Set([id]), startLine: start, endLine: m.line - 1, isWildcard: false });
            }
            openSpecific.delete(id);
          }
        }
      }
    }
  }

  // Unterminated opens run to EOF. Guard the degenerate case where the disable
  // sits ON the last line (start = totalLines+1 > totalLines) so no inverted span
  // is emitted.
  if (openWildcard !== null && openWildcard <= totalLines) ranges.push({ aspectIds: new Set(['*']), startLine: openWildcard, endLine: totalLines, isWildcard: true });
  for (const [id, start] of openSpecific) {
    if (start <= totalLines) ranges.push({ aspectIds: new Set([id]), startLine: start, endLine: totalLines, isWildcard: false });
  }

  return ranges;
}

export function isLineSuppressed(ranges: SuppressedRange[], aspectId: string, line: number): boolean {
  return ranges.some(r => {
    if (line < r.startLine || line > r.endLine) return false;
    return r.isWildcard || r.aspectIds.has(aspectId);
  });
}

/**
 * Project the suppressed ranges that apply to ONE aspect into a flat, sorted list
 * of `{startLine, endLine}` line spans. A range applies when it is a wildcard
 * (`yg-suppress(*)`) or its `aspectIds` set names this aspect — the exact same
 * predicate `isLineSuppressed` uses, so the lines an LLM reviewer is told to honor
 * are byte-for-byte the lines the deterministic runner already waives.
 *
 * Sorted by `startLine` then `endLine` so the injected prompt block is
 * deterministic regardless of marker discovery order. Returns `[]` when no range
 * applies (the caller renders no `<suppressed-ranges>` block, keeping the prompt
 * byte-identical to the no-suppress case).
 */
export function formatSuppressedRangesForAspect(
  ranges: SuppressedRange[],
  aspectId: string,
): Array<{ startLine: number; endLine: number }> {
  return ranges
    .filter(r => r.isWildcard || r.aspectIds.has(aspectId))
    // Never inject a degenerate (inverted) span into the reviewer prompt — the
    // construction guards above already prevent them, this is defense in depth.
    .filter(r => r.startLine <= r.endLine)
    .map(r => ({ startLine: r.startLine, endLine: r.endLine }))
    .sort((a, b) => (a.startLine - b.startLine) || (a.endLine - b.endLine));
}

// ── Line scanner (no tree-sitter) ────────────────────────────

export interface SuppressionMarkerInfo {
  line: number;       // 1-based
  aspectId: string;   // single aspect id (one entry per aspect per marker)
  kind: 'single' | 'disable' | 'enable';
  wildcard: boolean;
  reason: string;
}

/**
 * Match the anchored marker grammar against ONE line of text and append any
 * marker it carries (one entry per listed aspect id) to `out`, stamped with
 * `lineNum`. Delegates to the same `matchMarkerLine` the reviewer-honoring
 * `parseMarker` uses, so the inventory and the honoring path cannot diverge on
 * which token counts as a marker.
 */
function scanLineInto(raw: string, lineNum: number, out: SuppressionMarkerInfo[], requireDelimiter: boolean): void {
  const m = matchMarkerLine(raw, requireDelimiter);
  if (m === null) return;
  for (const id of m.aspectIds) {
    out.push({ line: lineNum, aspectId: id, kind: m.kind, wildcard: id === '*', reason: m.reason });
  }
}

/**
 * Language-agnostic raw-line scan for yg-suppress markers.
 * Reuses the shared anchored matcher — no tree-sitter required.
 * Emits one SuppressionMarkerInfo entry per (line × aspectId) combination.
 * Skips lines that carry no anchored marker.
 *
 * This scans EVERY line, so it is the right tool ONLY for files with no
 * registered grammar (`.sql`, `.sh` …) where there is no parse tree to tell
 * comment from code — mirroring the honoring path's text fallback in
 * `collectSuppressions`. Because the text is not comment-isolated, the marker
 * line must BEGIN with a comment delimiter (mandatory in raw-scan mode), so a
 * string-literal or bare-prose line that merely starts with the token is NOT
 * mistaken for a waiver. For a parseable language, use
 * `scanSuppressionMarkersInComments` so a marker inside a string literal is not
 * mistaken for a real waiver.
 */
export function scanSuppressionMarkers(text: string): SuppressionMarkerInfo[] {
  const lines = text.split('\n');
  const result: SuppressionMarkerInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Raw (non-comment-isolated) scan: the comment delimiter is MANDATORY, so a
    // bare prose/string line that merely begins with the token is not a marker.
    scanLineInto(lines[i], i + 1, result, true);
  }
  return result;
}

/**
 * Comment-only scan for yg-suppress markers, for files with a registered
 * tree-sitter grammar. Walks the parse tree's COMMENT nodes (via the same
 * `findComments` the reviewer-honoring `collectSuppressions` uses) and matches
 * the anchored marker grammar only against comment text — never string literals
 * or other code. This is what keeps the `yg suppressions` inventory aligned with what the
 * reviewer actually honors: a `yg-suppress(...)` written inside a string literal
 * (e.g. a test fixture or a template that documents the marker syntax) is NOT a
 * real waiver and must not be inventoried.
 *
 * Line numbers are mapped back to absolute, 1-based file lines using each
 * comment node's start row, so a marker on the Nth line of a multi-line block
 * comment is reported at the correct file line.
 */
export function scanSuppressionMarkersInComments(tree: Tree, file: string): SuppressionMarkerInfo[] {
  const result: SuppressionMarkerInfo[] = [];
  const comments = findComments({ path: file, ast: tree });
  for (const c of comments) {
    const startRow = c.startPosition.row; // 0-based
    const commentLines = c.text.split('\n');
    for (let i = 0; i < commentLines.length; i++) {
      // Comment-isolated text: the delimiter is OPTIONAL (a block-comment
      // interior line may carry none).
      scanLineInto(commentLines[i], startRow + i + 1, result, false);
    }
  }
  // A file may contain several comment nodes; emit markers in file order so the
  // inventory and the per-file disable/enable pairing see them top-to-bottom.
  result.sort((a, b) => a.line - b.line);
  return result;
}
