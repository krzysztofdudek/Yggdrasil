import { describe, it, expect } from 'vitest';
import { escapeControls, neutralizeControls } from '../../../src/utils/terminal-safe.js';

// Repository- and model-derived text reached the terminal raw: an OSC 52
// sequence in a file name wrote the clipboard, `ESC[2J` in a node description
// cleared the screen. It is now shown in caret notation, never obeyed.

const ESC = '\u001b';
const BEL = '\u0007';

describe('escapeControls — one piece of foreign text', () => {
  it('shows an OSC 52 clipboard write and a screen clear instead of passing them through', () => {
    expect(escapeControls(`evil${ESC}]52;c;SGVsbG8=${BEL}.txt`)).toBe('evil^[]52;c;SGVsbG8=^G.txt');
    expect(escapeControls(`app${ESC}[2Jspoof`)).toBe('app^[[2Jspoof');
  });

  it('shows a carriage return and even colour, which could overwrite or disguise a verdict line', () => {
    expect(escapeControls(`x\r${ESC}[32mPASS`)).toBe('x^M^[[32mPASS');
  });

  it('shows DEL and the C1 controls (a single-byte CSI is U+009B)', () => {
    expect(escapeControls('a\u007fb\u009b2Jc')).toBe('a^?b<U+009B>2Jc');
  });

  it('leaves newline, tab and ordinary text — including non-ASCII — alone', () => {
    expect(escapeControls('zażółć\tgęślą\njaźń — ✓')).toBe('zażółć\tgęślą\njaźń — ✓');
  });
});

describe('neutralizeControls — a whole output stream', () => {
  it('lets yg\'s own colour, erase-line and carriage-return redraw through unchanged', () => {
    const own = `${ESC}[31mFAIL${ESC}[39m ${ESC}[1;33mwarn${ESC}[22m\r${ESC}[2K... 3/5 filled\r`;
    expect(neutralizeControls(own)).toBe(own);
  });

  it('shows every other sequence: OSC, a screen clear, cursor moves, BEL', () => {
    expect(neutralizeControls(`a${ESC}]0;title${BEL}b`)).toBe('a^[]0;title^Gb');
    expect(neutralizeControls(`${ESC}[2J${ESC}[H`)).toBe('^[[2J^[[H');
    expect(neutralizeControls(`x${ESC}Py${ESC}\\`)).toBe('x^[Py^[\\');
  });

  it('is idempotent and returns plain text untouched', () => {
    const once = neutralizeControls(`evil${ESC}]52;c;SGVsbG8=${BEL}`);
    expect(neutralizeControls(once)).toBe(once);
    expect(neutralizeControls('plain\ttext\n')).toBe('plain\ttext\n');
  });
});
