/**
 * Yggdrasil marker-block detection — the SINGLE parser shared by the installer
 * that WRITES the block (`templates/platform.ts`) and the committed-digest
 * staleness gate that JUDGES it (`core/checks/digest-gate.ts`).
 *
 * WHY it lives here rather than beside either consumer: the two node types that
 * need it cannot import each other (`engine` may not call `template`), but both
 * may call `utility`. Keeping ONE implementation is the point — when the writer
 * and the reader disagreed about what counts as a block, a correctly-installed
 * repo could be reported as drifted by a gate the installer could not satisfy.
 *
 * Pure string logic only: no fs, no side effects on import.
 */

/** Opening marker of an installed yggdrasil block. Must be a line of its own. */
export const YGGDRASIL_START = '<!-- yggdrasil:start -->';
/** Closing marker of an installed yggdrasil block. Must be a line of its own. */
export const YGGDRASIL_END = '<!-- yggdrasil:end -->';

/** One genuine start..end marker pair. */
export interface MarkerBlockRange {
  /** Offset of the start marker's first character. */
  from: number;
  /** Offset just past the end marker's last character (half-open `[from, to)`). */
  to: number;
  /**
   * Offset of the block's inner content — just past the start marker's own
   * line terminator, so `text.slice(innerFrom, innerTo)` is exactly what the
   * installer wrote between the markers (anchor line first, body after).
   */
  innerFrom: number;
  /** Offset just past the inner content — where the end marker begins. */
  innerTo: number;
}

/**
 * Visit every line of `text` that lies OUTSIDE a fenced (```) code block,
 * handing the callback the raw line, its index in the `\n`-split array, and its
 * char offset in `text`. The ONE fence tracker behind every line-shaped
 * decision this module answers — block boundaries and standalone-line lookups
 * alike — so a fenced example can never be read as the real thing by one
 * caller and skipped by another.
 */
function forEachUnfencedLine(
  text: string,
  visit: (raw: string, index: number, offset: number) => void,
): void {
  let inFence = false;
  let pos = 0;
  let index = 0;
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
    } else if (!inFence) {
      visit(rawLine, index, pos);
    }
    pos += rawLine.length + 1;
    index += 1;
  }
}

/**
 * Char-offsets in `text` where `marker` opens/closes a QUALIFYING line: the
 * marker (only whitespace tolerated around it) is the line's entire content,
 * AND the line is not inside a fenced (```) code block. Two real repros
 * needed this: a marker embedded mid-sentence in prose (e.g. "writes between
 * <!--...--> and <!--...--> here") is not a block boundary at all, and a
 * fenced illustration of the block in documentation is a quoted example, not
 * an installed one — treating every raw substring occurrence as pairable
 * destroyed user bytes in the installer, and reported a phantom duplicate
 * block in the gate.
 */
function qualifyingMarkerOffsets(text: string, marker: string): number[] {
  const offsets: number[] = [];
  forEachUnfencedLine(text, (rawLine, _index, pos) => {
    if (rawLine.trim() === marker) offsets.push(pos + rawLine.indexOf(marker));
  });
  return offsets;
}

/**
 * Indices (into `text.split('\n')`) of the lines that are OUTSIDE any fenced
 * (```) code block and whose TRIMMED content satisfies `isMatch`.
 *
 * The standalone-line counterpart of the marker scan above, and shared for the
 * same reason: an install line (`@AGENTS.md`, the retired
 * `@.yggdrasil/agent-rules.md`) is a directive only when it is the whole line
 * and stands outside a fenced example. A repo that documents its own agent
 * setup routinely shows that exact line inside a ``` block; counting it made
 * the installer report an import it never wrote — leaving the repo LOOKING
 * installed while the agent got no rules — and made the same example a
 * deletable "user line" during the legacy sweep.
 */
export function unfencedLineIndices(text: string, isMatch: (trimmedLine: string) => boolean): number[] {
  const indices: number[] = [];
  forEachUnfencedLine(text, (rawLine, index) => {
    if (isMatch(rawLine.trim())) indices.push(index);
  });
  return indices;
}

/** Smallest offset in a monotonically increasing array that is `>= cursor`, or -1. */
function firstAtOrAfter(offsets: number[], cursor: number): number {
  for (const o of offsets) { if (o >= cursor) return o; }
  return -1;
}

/**
 * Offset of the inner content that follows a start marker at `markerEnd`:
 * skip the horizontal whitespace a qualifying marker line tolerates after the
 * marker, then the single line terminator (LF or CRLF — the installer runs
 * this over RAW bytes for legacy files, so CRLF must be handled here rather
 * than assumed away).
 */
function innerStartAfter(text: string, markerEnd: number): number {
  let i = markerEnd;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text[i] === '\r' && text[i + 1] === '\n') return i + 2;
  if (text[i] === '\n') return i + 1;
  return markerEnd;
}

/**
 * Locate the genuine marker PAIRS in `text`, considering only QUALIFYING
 * marker lines (see `qualifyingMarkerOffsets`) — a marker line-mate of prose
 * or fenced-example text never opens or closes a range.
 *
 * WHY not a `START[\s\S]*?END` regex: that anchors on the FIRST start marker
 * in the file, so a prose mention of the marker (it is documented text) or a
 * fenced example of the block would make the match span — and the installer's
 * surgery destroy — every user byte between it and the first end marker, while
 * the gate would count the example as a second installed block and hash the
 * example's body instead of the real one. Here an unpaired start marker is
 * simply never paired: when two start markers precede one end marker, the
 * LATER one opens the block (a block never contains a start marker), and any
 * start marker with no end marker after it is inert.
 */
export function findMarkerBlockRanges(text: string): MarkerBlockRange[] {
  const starts = qualifyingMarkerOffsets(text, YGGDRASIL_START);
  const ends = qualifyingMarkerOffsets(text, YGGDRASIL_END);
  const ranges: MarkerBlockRange[] = [];
  let cursor = 0;
  let openAt = -1;
  for (;;) {
    const s = firstAtOrAfter(starts, cursor);
    const e = firstAtOrAfter(ends, cursor);
    if (s === -1 && e === -1) break;
    if (s !== -1 && (e === -1 || s < e)) {
      openAt = s; // a nearer start wins; the older unpaired one stays inert
      cursor = s + YGGDRASIL_START.length;
      continue;
    }
    if (openAt !== -1) {
      const innerFrom = innerStartAfter(text, openAt + YGGDRASIL_START.length);
      ranges.push({
        from: openAt,
        to: e + YGGDRASIL_END.length,
        innerFrom,
        // An end marker immediately after the start marker leaves no inner
        // content; never let the slice run backwards.
        innerTo: e < innerFrom ? innerFrom : e,
      });
      openAt = -1;
    }
    cursor = e + YGGDRASIL_END.length;
  }
  return ranges;
}
