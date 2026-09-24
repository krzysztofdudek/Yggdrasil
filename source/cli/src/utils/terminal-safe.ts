/**
 * Terminal control sequences in text yg did not write itself.
 *
 * File names, node names and descriptions, rule text, log entries and reviewer
 * reasons all come from the repository or from a model, and reach the terminal
 * inside yg's human output. Printed raw, a control sequence in any of them is
 * obeyed by the terminal: OSC 52 writes the clipboard, `ESC[2J` clears the
 * screen, a title sequence renames the window, a carriage return overwrites the
 * line a verdict was printed on. The functions here render such characters
 * visibly instead, in caret notation (`^[` for ESC, `^G` for BEL), so the text
 * stays readable and inert.
 *
 * Two strengths:
 *   - escapeControls: for one piece of foreign text at the point it is placed
 *     in output. Everything but newline and tab is shown, never obeyed.
 *   - neutralizeControls: for a whole stream of output, applied to every write
 *     (installed by the CLI output layer, cli/output.ts). yg's own output uses
 *     colour (`ESC[…m`), the erase-line sequence (`ESC[2K`, `ESC[K`) and a
 *     carriage return to redraw its progress line, so those pass; every other
 *     control is shown, never obeyed.
 *
 * JSON output needs neither: JSON.stringify already escapes every control
 * character.
 */

/** Caret notation for one control character: ^@ … ^_ for C0, ^? for DEL, <U+0080> … <U+009F> for C1. */
function visible(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`;
  if (code === 0x7f) return '^?';
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Every C0 control but tab and newline, DEL, and every C1 control. */
// eslint-disable-next-line no-control-regex
const FOREIGN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Show every control character in `text` except newline and tab; obey none. */
export function escapeControls(text: string): string {
  return text.replace(FOREIGN_CONTROL, visible);
}

/**
 * yg's own sequences, which a whole-stream filter lets through: SGR colour and
 * the erase-in-line sequence (CSI with numeric parameters ending in `m` or `K`).
 */
// eslint-disable-next-line no-control-regex
const OWN_SEQUENCE = /\u001b\[[0-9;]*[mK]/y;

/**
 * Show every control character in a stream of output except newline, tab,
 * carriage return, and yg's own colour / erase-line sequences; obey none of
 * the rest. Idempotent, and a no-op on text with no control characters.
 */
export function neutralizeControls(text: string): string {
  // Fast path: most writes carry no control character beyond newline or tab.
  // eslint-disable-next-line no-control-regex
  if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (code === 0x1b) {
      OWN_SEQUENCE.lastIndex = i;
      const m = OWN_SEQUENCE.exec(text);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += visible(ch);
      continue;
    }
    if (ch === '\n' || ch === '\t' || ch === '\r') {
      out += ch;
      continue;
    }
    out += (code < 0x20 || (code >= 0x7f && code <= 0x9f)) ? visible(ch) : ch;
  }
  return out;
}

/** Marks a stream neutralizeStream has already wrapped. */
const GUARDED = Symbol.for('yg.terminal-safe.guarded');

/**
 * Route every string written to `stream` through neutralizeControls. Binary
 * chunks (a Buffer or other byte array) pass through untouched. Installing it
 * twice on one stream is a no-op.
 */
export function neutralizeStream(stream: NodeJS.WriteStream): void {
  const marked = stream as NodeJS.WriteStream & { [GUARDED]?: true };
  if (marked[GUARDED]) return;
  marked[GUARDED] = true;
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    original(typeof chunk === 'string' ? neutralizeControls(chunk) : chunk, ...rest)) as typeof stream.write;
}
