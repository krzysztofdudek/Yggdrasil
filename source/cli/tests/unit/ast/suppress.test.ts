import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectSuppressions,
  isLineSuppressed,
  formatSuppressedRangesForAspect,
  markdownFencedLines,
  SuppressMarkerError,
  scanSuppressionMarkers,
  scanSuppressionMarkersInComments,
} from '../../../src/ast/suppress.js';
import { withParsedFile } from '../../../src/ast/parser.js';

/** Parse code and collect reviewer-honored ranges; the WASM tree lives only inside this call. */
async function collectFromSource(file: string, code: string, totalLines: number) {
  return withParsedFile(file, code, (tree) => collectSuppressions(tree, file, totalLines));
}

describe('suppress: language-aware comment resolution', () => {
  it('Rust: yg-suppress on line_comment is detected', async () => {
    const code = `fn foo() {}\n// yg-suppress(my-aspect) reason here\nfn bar() {}`;
    const ranges = await collectFromSource('a.rs', code, code.split('\n').length);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Java: yg-suppress on line_comment is detected', async () => {
    const code = `class A {}\n// yg-suppress(my-aspect) reason here\nclass B {}`;
    const ranges = await collectFromSource('A.java', code, code.split('\n').length);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Kotlin: yg-suppress on line_comment is detected', async () => {
    const code = `fun foo() {}\n// yg-suppress(my-aspect) reason here\nfun bar() {}`;
    const ranges = await collectFromSource('a.kt', code, code.split('\n').length);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('unknown extension with no content arg returns empty suppressions (no throw)', async () => {
    // An unrecognised extension has no grammar, so there are no comment nodes to
    // walk. With no `content` supplied there is nothing to scan either, so the
    // result is empty (rather than throwing).
    const code = `const x = 1;\n// yg-suppress(my-aspect) reason\nconst y = 2;`;
    // Pass a file path with an unknown extension and omit content.
    const ranges = await withParsedFile('x.ts', code, (tree) =>
      collectSuppressions(tree, 'file.unknownext', 3),
    );
    expect(ranges).toEqual([]);
  });
});

describe('suppress: non-AST languages (raw-line text scan)', () => {
  // A file whose extension has no registered grammar (.sql, .sh, …) cannot be
  // parsed, so markers are found by scanning the raw `content` lines. This is
  // what lets a content-only deterministic check waive a violation in such a file.
  it('SQL: single-line marker (-- comment) suppresses the following line', () => {
    const code = `SELECT 1;\n-- yg-suppress(no-select-star) legacy report, columns are stable\nSELECT * FROM t;`;
    const ranges = collectSuppressions(undefined, 'q.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 1)).toBe(false);
  });

  it('Shell: # comment marker is recognised regardless of comment syntax', () => {
    const code = `echo start\n# yg-suppress(no-pipe-to-shell) vendored installer, reviewed\ncurl https://x | sh`;
    const ranges = collectSuppressions(undefined, 'install.sh', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-pipe-to-shell', 3)).toBe(true);
  });

  it('SQL: disable/enable range scanned from raw lines', () => {
    const code = [
      '-- yg-suppress-disable(no-select-star) bulk migration block',
      'SELECT * FROM a;',
      'SELECT * FROM b;',
      '-- yg-suppress-enable(no-select-star)',
      'SELECT * FROM c;',
    ].join('\n');
    const ranges = collectSuppressions(undefined, 'm.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    // line 5 is past the enable marker — not suppressed.
    expect(isLineSuppressed(ranges, 'no-select-star', 5)).toBe(false);
  });

  it('multi-aspect marker in a non-AST file applies to every listed aspect', () => {
    const code = `SELECT 1;\n-- yg-suppress(rule-a, rule-b) shared waiver\nSELECT * FROM t;`;
    const ranges = collectSuppressions(undefined, 'q.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'rule-a', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-b', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-c', 3)).toBe(false);
  });

  it('a marker with no reason in a non-AST file still throws', () => {
    const code = `-- yg-suppress(no-select-star)\nSELECT * FROM t;`;
    expect(() => collectSuppressions(undefined, 'q.sql', 2, code)).toThrow(SuppressMarkerError);
  });
});

describe('suppress: single-line form', () => {
  it('yg-suppress applies to immediately following line', async () => {
    const code = `const x = 1;\n// yg-suppress(async-fs) refactor planned\nfs.readFileSync('a');\nfs.readFileSync('b');`;
    const ranges = await collectFromSource('x.ts', code, code.split('\n').length);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });

  it('rejects empty reason', async () => {
    const code = `// yg-suppress(async-fs)\nfs.readFileSync('a');`;
    await withParsedFile('x.ts', code, (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });

  it('does NOT match yg-suppress in string literal', async () => {
    const code = `const banner = "yg-suppress(async-fs) this is just a string";\nfs.readFileSync('a');`;
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(false);
  });

  it('multi-aspect: yg-suppress(a, b) applies both', async () => {
    const code = `// yg-suppress(async-fs, posix-paths) cleanup\nfs.readFileSync('x');`;
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'unrelated', 2)).toBe(false);
  });
});

describe('suppress: bracket form', () => {
  it('single disable/enable cycle', async () => {
    const code = `// yg-suppress-disable(async-fs) refactor planned\nfs.readFileSync('a');\nfs.readFileSync('b');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('c');`;
    const ranges = await collectFromSource('x.ts', code, 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('disable without enable extends to EOF', async () => {
    const code = `// yg-suppress-disable(async-fs) until ticket-X\na(); b(); c();`;
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
  });

  it('multi-aspect disable/enable independently', async () => {
    const code = [
      `// yg-suppress-disable(async-fs, posix-paths) cleanup queued`,
      `a();`,
      `// yg-suppress-enable(async-fs)`,
      `b();`,
      `// yg-suppress-enable(posix-paths)`,
      `c();`,
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 6);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
    expect(isLineSuppressed(ranges, 'posix-paths', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 6)).toBe(false);
  });

  it('empty reason on disable rejected', async () => {
    const code = `// yg-suppress-disable(async-fs)\nfs.readFileSync('a');`;
    await withParsedFile('x.ts', code, (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });

  it('block comment disable/enable', async () => {
    const code = `/* yg-suppress-disable(async-fs) refactor planned */\nfs.readFileSync('a');\n/* yg-suppress-enable(async-fs) */\nfs.readFileSync('b');`;
    const ranges = await collectFromSource('x.ts', code, 4);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });
});

describe('suppress: wildcard semantics', () => {
  it('disable(*) suppresses all aspects', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\nconsole.log('x');\n// yg-suppress-enable(*)\nconsole.log('y');`;
    const ranges = await collectFromSource('x.ts', code, 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('specific enable does NOT punch through wildcard disable', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('y');\nconsole.log('z');`;
    const ranges = await collectFromSource('x.ts', code, 5);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 5)).toBe(true);
  });

  it('enable(*) closes wildcard but leaves specific opens', async () => {
    const code = [
      `// yg-suppress-disable(async-fs) ticket-1`,
      `// yg-suppress-disable(*) ticket-2`,
      `a();`,
      `// yg-suppress-enable(*)`,
      `b();`,
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 5);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 5)).toBe(false);
  });
});

describe('suppress: anchored grammar (prose mentions are not markers)', () => {
  // The marker token must be the FIRST token of its (comment) line — preceded
  // only by whitespace plus at most ONE comment-delimiter token — and every
  // listed aspect id must be `*` or a path-ish identifier. Prose that merely
  // mentions the syntax is invisible to BOTH the reviewer-honoring path and the
  // inventory scanners (they share one matcher).

  it('a mid-sentence wildcard mention in a real comment produces NO range and NO inventoried marker (the silent-waiver hole)', async () => {
    const code = [
      'a();',
      '// Note: never use yg-suppress(*) here because wildcards mask real problems',
      'b();',
    ].join('\n');
    await withParsedFile('x.ts', code, (tree) => {
      const ranges = collectSuppressions(tree, 'x.ts', 3);
      expect(ranges).toEqual([]);
      expect(isLineSuppressed(ranges, 'any-aspect', 3)).toBe(false);
      // Inventory paths see nothing either — same matcher.
      expect(scanSuppressionMarkersInComments(tree, 'x.ts')).toHaveLength(0);
    });
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('a reasonless prose mention does NOT throw SuppressMarkerError (it is not a marker at all)', async () => {
    const code = ['// See the docs about yg-suppress(no-forbidden)', 'b();'].join('\n');
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(ranges).toEqual([]);
  });

  it('id charset: anchored tokens with junk ids — (...) and (<aspect-id>) — are prose, not markers', async () => {
    const code = [
      '// yg-suppress(...) that merely appears inside a doc sentence',
      '// yg-suppress(<aspect-id>) placeholder from documentation',
      'b();',
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    expect(ranges).toEqual([]);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('quotation-style `// // yg-suppress(x) r` is not a marker (at most ONE comment delimiter may precede the token)', async () => {
    const code = ['// // yg-suppress(x) quoted example from a code review', 'b();'].join('\n');
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(ranges).toEqual([]);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('a backtick-quoted `yg-suppress(*)` at comment start is not a marker', async () => {
    const code = ['// `yg-suppress(*)` waives every aspect on the next line', 'b();'].join('\n');
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(ranges).toEqual([]);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('raw-scan mode: a marker-shaped token after code on the same line is not a marker', () => {
    const code = 'SELECT 1; -- yg-suppress(no-select-star) inline note\nSELECT * FROM t;';
    const ranges = collectSuppressions(undefined, 'q.sql', 2, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 2)).toBe(false);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('AST path row-stamping: a marker on line k of a multi-line block comment waives line k+1, not the line after the comment start', async () => {
    const code = [
      '/* Overview:',                          // 1 — comment start row
      ' * yg-suppress(my-aspect) known debt',  // 2 — the marker's own row
      ' * end of comment */',                  // 3 — the one line the marker waives
      'const x = 1;',                          // 4
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 4);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    // The old whole-comment match stamped the marker at the COMMENT's start row,
    // waiving line 2 — that divergence from the inventory scanner is fixed.
    expect(isLineSuppressed(ranges, 'my-aspect', 2)).toBe(false);
    expect(isLineSuppressed(ranges, 'my-aspect', 4)).toBe(false);
  });

  it('mixed block comment: a prose mention and a real marker inside ONE comment node — only the marker row counts', async () => {
    const code = [
      '/* Module notes:',                                                   // 1 — comment start row
      ' * never use yg-suppress(*) here because wildcards mask problems',   // 2 — PROSE mention, not a marker
      ' * yg-suppress(my-aspect) known debt',                               // 3 — real anchored marker
      ' */',                                                                // 4 — the one line the marker waives
      'const x = 1;',                                                       // 5
    ].join('\n');
    await withParsedFile('x.ts', code, (tree) => {
      // Exactly ONE marker is collected, stamped at the marker's OWN row (3).
      const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ line: 3, aspectId: 'my-aspect', kind: 'single', wildcard: false, reason: 'known debt' });

      // Honoring path: exactly one 1-line range at marker-row + 1 (line 4).
      const ranges = collectSuppressions(tree, 'x.ts', 5);
      expect(ranges).toHaveLength(1);
      expect(isLineSuppressed(ranges, 'my-aspect', 4)).toBe(true);
      expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(false);
      expect(isLineSuppressed(ranges, 'my-aspect', 5)).toBe(false);
      // The prose wildcard mention contributed NOTHING: no other aspect is waived anywhere.
      for (let line = 1; line <= 5; line++) {
        expect(isLineSuppressed(ranges, 'other-aspect', line)).toBe(false);
      }
    });
  });
});

describe('suppress: trailing block-comment closers are comment syntax, not reason text', () => {
  // RE_TRAILING_CLOSER strips a block-comment terminator ending the marker's own
  // line (`*/`, `-->`, `-}`, `*)`) BEFORE the reason is read: the closer must
  // never leak into the reason, and a marker whose "reason" is ONLY the closer
  // has no reason at all.

  it("'/* yg-suppress(my-aspect) legacy path */' → reason is exactly 'legacy path' (no trailing '*/')", async () => {
    const code = `/* yg-suppress(my-aspect) legacy path */\nconst x = 1;`;
    await withParsedFile('x.ts', code, (tree) => {
      // The honoring path accepts the marker (reason survives closer-stripping)…
      const ranges = collectSuppressions(tree, 'x.ts', 2);
      expect(isLineSuppressed(ranges, 'my-aspect', 2)).toBe(true);
      // …and the parsed reason excludes the closer, exactly.
      const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
      expect(markers).toHaveLength(1);
      expect(markers[0].reason).toBe('legacy path');
    });
  });

  it("'<!-- yg-suppress(my-aspect) generated -->' → reason is exactly 'generated' (no trailing '-->')", () => {
    const markers = scanSuppressionMarkers('<!-- yg-suppress(my-aspect) generated -->');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('single');
    expect(markers[0].reason).toBe('generated');
  });

  it("'/* yg-suppress(my-aspect) */' → reason is EMPTY after closer-stripping → SuppressMarkerError", async () => {
    const code = `/* yg-suppress(my-aspect) */\nconst x = 1;`;
    await withParsedFile('x.ts', code, (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });

  it("disable form: '/* yg-suppress-disable(my-aspect) migration debt */' → kind disable, reason 'migration debt'", async () => {
    const code = `/* yg-suppress-disable(my-aspect) migration debt */\nconst x = 1;`;
    const markers = await withParsedFile('x.ts', code, (tree) =>
      scanSuppressionMarkersInComments(tree, 'x.ts'),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('disable');
    expect(markers[0].reason).toBe('migration debt');
  });

  it("disable form: '/* yg-suppress-disable(my-aspect) */' → reason empty after closer-stripping → SuppressMarkerError", async () => {
    const code = `/* yg-suppress-disable(my-aspect) */\nconst x = 1;`;
    await withParsedFile('x.ts', code, (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });
});

describe('suppress: anchored grammar — sanity matrix (one shared matcher)', () => {
  // Permanent guard for the delimiter whitelist and the id charset: every legit
  // documented form matches; every phantom prose form rejects. The raw-line
  // scanner exercises the shared matcher one line at a time, so this matrix
  // covers the reviewer-honoring path and the inventory path alike.
  // Each row pins the FULL parse — kind, aspect-id list, and the exact reason
  // (closers stripped) — not merely "some marker matched", so a regression in
  // kind detection, id splitting, or reason extraction fails the matrix even
  // when the line still counts as a marker.
  interface LegitRow {
    line: string;
    label: string;
    kind: 'single' | 'disable' | 'enable';
    aspectIds: string[];
    reason: string; // exact reason after closer-stripping ('' only for enable)
  }
  const LEGIT: LegitRow[] = [
    { line: '// yg-suppress(a) reason', label: 'C-family line comment', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '/// yg-suppress(a) reason', label: 'doc line comment (///)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '//! yg-suppress(a) reason', label: 'Rust inner doc comment (//!)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '/* yg-suppress(a) reason */', label: 'block comment opener', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: ' * yg-suppress(a) reason', label: 'block comment continuation line', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '# yg-suppress(a) reason', label: 'hash comment (shell/Python/YAML)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '## yg-suppress(a) reason', label: 'double-hash comment (##)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '-- yg-suppress(a) reason', label: 'SQL comment', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '--- yg-suppress(a) reason', label: 'triple-dash comment (---)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '; yg-suppress(a) reason', label: 'Lisp/INI comment', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '<!-- yg-suppress(a) reason -->', label: 'HTML/Markdown comment', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '{- yg-suppress(a) reason -}', label: 'Haskell block comment ({-)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '(* yg-suppress(a) reason *)', label: 'OCaml/Pascal block comment ((*)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '! yg-suppress(a) reason', label: 'Fortran comment (!)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '% yg-suppress(a) reason', label: 'Erlang/TeX/Prolog comment (%)', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: "' yg-suppress(a) reason", label: "VB comment (')", kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '" yg-suppress(a) reason', label: 'Vim comment (")', kind: 'single', aspectIds: ['a'], reason: 'reason' },
    { line: '  // yg-suppress(security/input-validation) hierarchical id', label: 'hierarchical aspect id', kind: 'single', aspectIds: ['security/input-validation'], reason: 'hierarchical id' },
    { line: '// yg-suppress(a, b) multi-aspect list', label: 'multi-aspect list', kind: 'single', aspectIds: ['a', 'b'], reason: 'multi-aspect list' },
    { line: '// yg-suppress(*) wildcard waiver', label: 'wildcard', kind: 'single', aspectIds: ['*'], reason: 'wildcard waiver' },
    { line: '// yg-suppress-disable(a) unterminated file-level waiver', label: 'bracket disable (file-level)', kind: 'disable', aspectIds: ['a'], reason: 'unterminated file-level waiver' },
    { line: '// yg-suppress-enable(a)', label: 'bracket enable', kind: 'enable', aspectIds: ['a'], reason: '' },
  ];
  const PHANTOM: Array<[string, string]> = [
    ['// Note: never use yg-suppress(*) here because wildcards mask real problems', 'mid-sentence wildcard mention'],
    ['// a `yg-suppress(a)` mention wrapped in backticks', 'backtick-quoted token'],
    ['// // yg-suppress(a) quoted marker', 'quotation-style double delimiter'],
    ['const x = 1; // yg-suppress(a) after code on a raw-scanned line', 'trailing after code (raw-scan)'],
    ['// yg-suppress(...) truncated prose id', 'ellipsis id'],
    ['// yg-suppress(<aspect-id>) placeholder id', 'angle-bracket placeholder id'],
    ['// See yg-suppress(a)', 'mid-sentence mention'],
    // SECURITY (F5): in raw-scan mode a bare line with NO comment delimiter — a
    // wrapped prose sentence or a string-literal line — must NOT be a marker. A
    // real delimiter (`#`/`--`/`<!--`/…) is mandatory; see the delimited rows above.
    ['yg-suppress(a) reason', 'bare token, no comment delimiter (raw-scan)'],
    ['yg-suppress(*) waive everything below with no delimiter', 'bare wildcard token, no delimiter (raw-scan)'],
  ];

  for (const row of LEGIT) {
    it(`matches: ${row.label}`, () => {
      const markers = scanSuppressionMarkers(row.line);
      // One entry per listed aspect id, in list order.
      expect(markers.map((m) => m.aspectId)).toEqual(row.aspectIds);
      for (const m of markers) {
        expect(m.kind).toBe(row.kind);
        expect(m.reason).toBe(row.reason);
        expect(m.wildcard).toBe(m.aspectId === '*');
        expect(m.line).toBe(1);
      }
    });
  }
  for (const [line, label] of PHANTOM) {
    it(`rejects: ${label}`, () => {
      expect(scanSuppressionMarkers(line)).toHaveLength(0);
    });
  }
});

describe('suppress: CRLF files (trailing \\r is stripped before matching)', () => {
  // Every scan path splits on '\n', leaving a trailing '\r' on each line of a
  // CRLF-authored file. A marker WITH a reason must be honored identically to an
  // LF file — before the fix, RE_MARKER's `(.*)$` glued the '\r' onto the reason
  // and CRLF markers were silently dropped.

  it('raw path: single-line -- marker with reason + \\r\\n suppresses the next line', () => {
    const code = 'SELECT 1;\r\n-- yg-suppress(no-select-star) legacy report, columns stable\r\nSELECT * FROM t;\r\n';
    const ranges = collectSuppressions(undefined, 'q.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 1)).toBe(false);
  });

  it('raw path: disable/enable bracket with \\r\\n honored across the range', () => {
    const code = [
      '-- yg-suppress-disable(no-select-star) bulk migration block',
      'SELECT * FROM a;',
      'SELECT * FROM b;',
      '-- yg-suppress-enable(no-select-star)',
      'SELECT * FROM c;',
    ].join('\r\n');
    const ranges = collectSuppressions(undefined, 'm.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 5)).toBe(false);
  });

  it('AST path: marker on a block-comment CONTINUATION line survives \\r\\n', async () => {
    // Block-comment interior lines keep their '\r' inside the comment node text
    // (unlike line comments, whose '\r' tree-sitter leaves outside the token) — so
    // this is the case the CRLF regression silently broke.
    const code = ['/*', ' * yg-suppress(my-aspect) known debt', ' */', 'const x = 1;'].join('\r\n');
    const ranges = await collectFromSource('x.ts', code, code.split('\n').length);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 2)).toBe(false);
  });

  it('inventory raw-scan honors a CRLF marker identically to LF', () => {
    const crlf = scanSuppressionMarkers('-- yg-suppress(a) reason\r\n');
    expect(crlf).toHaveLength(1);
    expect(crlf[0]).toMatchObject({ aspectId: 'a', kind: 'single', reason: 'reason' });
  });
});

describe('suppress: delimiter-aware closer stripping (a line comment has no closer)', () => {
  // A trailing block-comment terminator is comment syntax ONLY for the delimiter
  // that opened the line. In a `//`/`#`/`--` LINE comment no closer can exist, so
  // a reason that legitimately ends in such a token must survive intact.

  it("'// yg-suppress(a) */' → reason is exactly '*/' (line comment, closer NOT stripped)", () => {
    const markers = scanSuppressionMarkers('// yg-suppress(a) */');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ aspectId: 'a', kind: 'single', reason: '*/' });
  });

  it("'/* yg-suppress(a) legacy */' → reason 'legacy' (block closer IS stripped)", () => {
    const markers = scanSuppressionMarkers('/* yg-suppress(a) legacy */');
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe('legacy');
  });

  it("'-- yg-suppress(a) note -}' keeps the '-}' (SQL line comment, not a Haskell block)", () => {
    const markers = scanSuppressionMarkers('-- yg-suppress(a) note -}');
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe('note -}');
  });
});

describe('suppress: comment-isolated bare token still matches (F5 does not break block comments)', () => {
  it('a delimiter-less interior line of a block comment is honored via the comment path', async () => {
    const code = ['/*', 'yg-suppress(my-aspect) known debt', '*/', 'const x = 1;'].join('\n');
    await withParsedFile('x.ts', code, (tree) => {
      // Honoring path (comment-isolated → optional delimiter): the interior line
      // with NO leading delimiter is still a marker.
      const ranges = collectSuppressions(tree, 'x.ts', 4);
      expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
      // Inventory comment scan agrees.
      const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ line: 2, aspectId: 'my-aspect', reason: 'known debt' });
    });
    // But the SAME bare line raw-scanned (no comment isolation) is NOT a marker.
    expect(scanSuppressionMarkers('yg-suppress(my-aspect) known debt')).toHaveLength(0);
  });
});

describe('suppress: degenerate inverted ranges are never emitted (NOTE 6)', () => {
  it('a bare disable on the last line of the file emits no span', async () => {
    // start = totalLines + 1, end = totalLines → inverted → dropped.
    const code = ['const x = 1;', '// yg-suppress-disable(my-aspect) trailing'].join('\n');
    const ranges = await collectFromSource('x.ts', code, 2);
    expect(ranges).toEqual([]);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });

  it('an enable directly following its disable emits no span', async () => {
    const code = ['// yg-suppress-disable(my-aspect) a', '// yg-suppress-enable(my-aspect)', 'const x = 1;'].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    // disable opens at line 2, enable closes at line 1 → inverted → dropped.
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });
});

describe('formatSuppressedRangesForAspect', () => {
  it('single-line marker → one 1-line span on the line below the marker', async () => {
    const code = [`a();`, `// yg-suppress(my-aspect) reason`, `b();`].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  it('bracket marker → the full disable..enable span', async () => {
    const code = [
      `// yg-suppress-disable(my-aspect) reason`,
      `a();`,
      `b();`,
      `// yg-suppress-enable(my-aspect)`,
      `c();`,
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 5);
    // disable on line 1 opens at line 2; enable on line 4 closes at line 3.
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('lone disable (no enable) → span runs to EOF (totalLines)', async () => {
    const code = [`// yg-suppress-disable(my-aspect) reason`, `a();`, `b();`].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('wildcard marker applies to ANY aspect id', async () => {
    const code = [`a();`, `// yg-suppress(*) reason`, `b();`].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    expect(formatSuppressedRangesForAspect(ranges, 'whatever-id')).toEqual([{ startLine: 3, endLine: 3 }]);
    expect(formatSuppressedRangesForAspect(ranges, 'another-id')).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  it('returns [] when no range applies to the aspect', async () => {
    const code = [`a();`, `// yg-suppress(other-aspect) reason`, `b();`].join('\n');
    const ranges = await collectFromSource('x.ts', code, 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });

  it('spans are sorted by startLine then endLine', async () => {
    const code = [
      `a();`,
      `// yg-suppress(my-aspect) reason A`,
      `b();`,
      `c();`,
      `// yg-suppress(my-aspect) reason B`,
      `d();`,
    ].join('\n');
    const ranges = await collectFromSource('x.ts', code, 6);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 6, endLine: 6 },
    ]);
  });
});

describe('markdownFencedLines: the shared fence mask', () => {
  // 1-based line numbers INSIDE a fenced code block, delimiters included. The
  // helper is the single source of truth both raw-scan consumers share.
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

  it('backtick fence: opener, interior, and closer are all masked', () => {
    const text = ['before', '```', 'inside', '```', 'after'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([2, 3, 4]);
  });

  it('tilde fence masks like a backtick fence', () => {
    const text = ['before', '~~~', 'inside', '~~~', 'after'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([2, 3, 4]);
  });

  it('an info string after the opener (```ts) still opens a fence', () => {
    const text = ['```ts', 'inside', '```'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([1, 2, 3]);
  });

  it('an unclosed fence extends through EOF (fail toward enforcement)', () => {
    const text = ['before', '```', 'a', 'b'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([2, 3, 4]);
  });

  it('an up-to-3-space-indented fence opens; a 4-space-indented line does not', () => {
    const opens = ['x', '   ```', 'in', '   ```', 'y'].join('\n');
    expect(sorted(markdownFencedLines(opens))).toEqual([2, 3, 4]);
    // 4 leading spaces is an indented code block, not a fence opener — no mask.
    const noOpen = ['x', '    ```', 'in', '    ```', 'y'].join('\n');
    expect(markdownFencedLines(noOpen).size).toBe(0);
  });

  it('a ~~~ line does NOT close a ``` fence (the fence char must match)', () => {
    const text = ['```', 'inside', '~~~', 'still inside', '```', 'after'].join('\n');
    // ``` opens at 1; ~~~ at 3 is interior, not a close; ``` at 5 closes.
    expect(sorted(markdownFencedLines(text))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a shorter same-character run does NOT close a longer opener (CommonMark run length)', () => {
    // ```` opens (run 4); the inner ``` (run 3 < 4) is interior; the ```` closes.
    const text = ['````', '```', 'in', '```', '````', 'after'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([1, 2, 3, 4, 5]);
    // A LONGER run does close a shorter opener (run 4 ≥ 3, no info string).
    const longerCloses = ['```', 'in', '````', 'after'].join('\n');
    expect(sorted(markdownFencedLines(longerCloses))).toEqual([1, 2, 3]);
  });

  it('a run bearing an info string does NOT close an open fence (only the opener may have one)', () => {
    // ```lang while a fence is open is interior; the bare ``` closes.
    const text = ['```', '```lang', 'in', '```', 'after'].join('\n');
    expect(sorted(markdownFencedLines(text))).toEqual([1, 2, 3, 4]);
  });

  it('no fences → empty set (plain prose is never masked)', () => {
    expect(markdownFencedLines('a\nb\nc').size).toBe(0);
  });
});

describe('suppress: Markdown fenced examples are inert (A4 — the docs suppress hole)', () => {
  // A `yg-suppress(...)` inside a fenced code block of a Markdown file is a
  // documented EXAMPLE, not a live waiver. Both raw-scan paths — the reviewer
  // honoring path (collectSuppressions) and the `yg suppressions` inventory
  // (scanSuppressionMarkers) — mask fenced lines out. A plain-prose mention is
  // already inert via anchoring. Backed by a real .md fixture with ```, ~~~, and
  // an unclosed fence. (The fixture carries NO live out-of-fence marker: it lives
  // under the mapped `tests/fixtures/` node, where a real marker would pollute the
  // `yg suppressions` audit — the honored-out-of-fence case is asserted below on an
  // inline `.md` string instead.)
  const MD_FIXTURE = join(import.meta.dirname, '../../fixtures/suppress-markdown.md');
  const text = readFileSync(MD_FIXTURE, 'utf-8');
  const mdPath = 'docs/example.md';
  const totalLines = text.split('\n').length;

  it('the fixture masks every fenced line and leaves the prose line unmasked', () => {
    const fenced = markdownFencedLines(text);
    // backtick block (5–7), tilde block (9–11), unclosed block (15→EOF).
    for (const l of [5, 6, 7, 9, 10, 11, 15, 16, 17]) expect(fenced.has(l)).toBe(true);
    // the plain-prose mention on line 3 is never fenced.
    expect(fenced.has(3)).toBe(false);
  });

  it('honoring path: every fenced example is inert and the prose mention is inert', () => {
    const ranges = collectSuppressions(undefined, mdPath, totalLines, text);
    expect(ranges).toEqual([]);
    // Each fenced marker would waive the line below it (6→7, 10→11, 16→17) if honored.
    expect(isLineSuppressed(ranges, 'fenced-backtick', 7)).toBe(false);
    expect(isLineSuppressed(ranges, 'fenced-tilde', 11)).toBe(false);
    expect(isLineSuppressed(ranges, 'fenced-unclosed', 17)).toBe(false);
    // The plain-prose mention contributes nothing (anchoring).
    expect(isLineSuppressed(ranges, 'prose-aspect', 4)).toBe(false);
  });

  it('inventory path mirrors the honoring path exactly — nothing inventoried', () => {
    expect(scanSuppressionMarkers(text, mdPath)).toEqual([]);
  });

  it('the mask is Markdown-gated: the SAME text without a .md path honors the fenced markers', () => {
    // No filePath ⇒ no masking; the three delimiter-led fenced markers are all
    // seen. This is exactly the pre-fix behavior the mask removes for Markdown.
    const unmasked = scanSuppressionMarkers(text);
    expect(unmasked.map((m) => m.aspectId).sort()).toEqual(
      ['fenced-backtick', 'fenced-tilde', 'fenced-unclosed'].sort(),
    );
    // A non-Markdown extension likewise gets no masking (raw scan honors all three).
    const asTxt = collectSuppressions(undefined, 'notes.txt', totalLines, text);
    expect(asTxt).toHaveLength(3);
  });

  it('an HTML-comment marker OUTSIDE a fence is still honored; one INSIDE a fence is inert', () => {
    // The sanctioned Markdown suppress form is an HTML comment outside any fence.
    const md = [
      '<!-- yg-suppress(outside-fence) sanctioned markdown waiver -->', // 1 — honored
      'this target line is waived',                                     // 2 — waived
      '',                                                               // 3
      '```',                                                            // 4 — fence open
      '<!-- yg-suppress(inside-fence) documented example, inert -->',   // 5 — masked
      '```',                                                            // 6 — fence close
    ].join('\n');
    // Honoring path: exactly the out-of-fence marker waives its line.
    const ranges = collectSuppressions(undefined, 'docs/x.md', md.split('\n').length, md);
    expect(ranges).toHaveLength(1);
    expect(isLineSuppressed(ranges, 'outside-fence', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'inside-fence', 6)).toBe(false);
    // Inventory path mirrors: one marker, the out-of-fence HTML comment.
    const markers = scanSuppressionMarkers(md, 'docs/x.md');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ line: 1, aspectId: 'outside-fence', kind: 'single' });
  });

  // REGRESSION (post-review): CommonMark-correct fence CLOSING. The pre-fix mask
  // compared only the fence CHARACTER, ignoring run length and info strings, so a
  // shorter inner run — or a ```lang line — inside an open fence was mistaken for a
  // CLOSE, ending the mask early and letting a `yg-suppress(...)` written between
  // the inner delimiters be honored as a LIVE waiver: the exact laundering hole the
  // fenced-block masking was meant to close. These two cases pin that the marker
  // now stays MASKED (inert) on BOTH the honoring path (collectSuppressions → no
  // live range) and the inventory path (scanSuppressionMarkers → nothing). Each
  // also proves the marker is a REAL, otherwise-honored marker by scanning the same
  // text with NO Markdown path (no masking) — so the fence mask is what makes it
  // inert, not anchoring.

  it('nested fences: a 4-backtick outer fence keeps a 3-backtick inner run (and a marker between it) MASKED', () => {
    const md = [
      '````',                                                       // 1 — outer opener (run length 4)
      '```',                                                        // 2 — inner run of 3 < 4 ⇒ NOT a close, interior
      '<!-- yg-suppress(nested-inert) documented example, inert -->', // 3 — interior, masked
      '```',                                                        // 4 — inner run of 3 < 4 ⇒ still interior
      '````',                                                       // 5 — outer close (run length 4 ≥ 4, no info string)
      'after the fenced block',                                     // 6
    ].join('\n');
    const mdPath = 'docs/nested.md';

    // The mask covers the whole nested block (1–5); line 6 is outside.
    const fenced = markdownFencedLines(md);
    for (const l of [1, 2, 3, 4, 5]) expect(fenced.has(l)).toBe(true);
    expect(fenced.has(6)).toBe(false);

    // Honoring path: the marker between the inner delimiters is inert — no range,
    // and it does not waive the line below it (4).
    const ranges = collectSuppressions(undefined, mdPath, md.split('\n').length, md);
    expect(ranges).toEqual([]);
    expect(isLineSuppressed(ranges, 'nested-inert', 4)).toBe(false);

    // Inventory path mirrors the honoring path exactly — nothing inventoried.
    expect(scanSuppressionMarkers(md, mdPath)).toEqual([]);

    // Load-bearing mask: the SAME text with NO Markdown path honors the marker,
    // proving it is a real marker and only the fence mask makes it inert.
    expect(scanSuppressionMarkers(md).map((m) => m.aspectId)).toEqual(['nested-inert']);
  });

  it('info-string close: a ```lang line inside an open fence is interior, not a close, so a marker after it stays MASKED', () => {
    const md = [
      '```',                                                          // 1 — opener (no info string)
      '```lang',                                                      // 2 — same run length but carries an info string ⇒ NOT a close, interior
      '<!-- yg-suppress(after-info-inert) documented example, inert -->', // 3 — interior, masked
      '```',                                                          // 4 — real close (no info string)
      'after the fenced block',                                       // 5
    ].join('\n');
    const mdPath = 'docs/info.md';

    // The mask stays open across the ```lang line: lines 1–4 are all fenced.
    const fenced = markdownFencedLines(md);
    for (const l of [1, 2, 3, 4]) expect(fenced.has(l)).toBe(true);
    expect(fenced.has(5)).toBe(false);

    // Honoring path: the marker after the info-string line is inert.
    const ranges = collectSuppressions(undefined, mdPath, md.split('\n').length, md);
    expect(ranges).toEqual([]);
    expect(isLineSuppressed(ranges, 'after-info-inert', 4)).toBe(false);

    // Inventory path mirrors — nothing inventoried.
    expect(scanSuppressionMarkers(md, mdPath)).toEqual([]);

    // Load-bearing mask: without a Markdown path the marker is honored.
    expect(scanSuppressionMarkers(md).map((m) => m.aspectId)).toEqual(['after-info-inert']);
  });
});
