import { describe, it, expect } from 'vitest';
import {
  collectSuppressions,
  isLineSuppressed,
  formatSuppressedRangesForAspect,
  SuppressMarkerError,
  scanSuppressionMarkers,
  scanSuppressionMarkersInComments,
} from '../../../src/ast/suppress.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('suppress: language-aware comment resolution', () => {
  it('Rust: yg-suppress on line_comment is detected', async () => {
    const code = `fn foo() {}\n// yg-suppress(my-aspect) reason here\nfn bar() {}`;
    const tree = await parseFile('a.rs', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'a.rs', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Java: yg-suppress on line_comment is detected', async () => {
    const code = `class A {}\n// yg-suppress(my-aspect) reason here\nclass B {}`;
    const tree = await parseFile('A.java', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'A.java', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Kotlin: yg-suppress on line_comment is detected', async () => {
    const code = `fun foo() {}\n// yg-suppress(my-aspect) reason here\nfun bar() {}`;
    const tree = await parseFile('a.kt', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'a.kt', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('unknown extension with no content arg returns empty suppressions (no throw)', async () => {
    // An unrecognised extension has no grammar, so there are no comment nodes to
    // walk. With no `content` supplied there is nothing to scan either, so the
    // result is empty (rather than throwing).
    const code = `const x = 1;\n// yg-suppress(my-aspect) reason\nconst y = 2;`;
    const tree = await parseFile('x.ts', code);
    // Pass a file path with an unknown extension and omit content.
    const ranges = collectSuppressions(tree, 'file.unknownext', 3);
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
    const tree = await parseFile('x.ts', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'x.ts', n);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });

  it('rejects empty reason', async () => {
    const code = `// yg-suppress(async-fs)\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
  });

  it('does NOT match yg-suppress in string literal', async () => {
    const code = `const banner = "yg-suppress(async-fs) this is just a string";\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(false);
  });

  it('multi-aspect: yg-suppress(a, b) applies both', async () => {
    const code = `// yg-suppress(async-fs, posix-paths) cleanup\nfs.readFileSync('x');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'unrelated', 2)).toBe(false);
  });
});

describe('suppress: bracket form', () => {
  it('single disable/enable cycle', async () => {
    const code = `// yg-suppress-disable(async-fs) refactor planned\nfs.readFileSync('a');\nfs.readFileSync('b');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('c');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('disable without enable extends to EOF', async () => {
    const code = `// yg-suppress-disable(async-fs) until ticket-X\na(); b(); c();`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 6);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
    expect(isLineSuppressed(ranges, 'posix-paths', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 6)).toBe(false);
  });

  it('empty reason on disable rejected', async () => {
    const code = `// yg-suppress-disable(async-fs)\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
  });

  it('block comment disable/enable', async () => {
    const code = `/* yg-suppress-disable(async-fs) refactor planned */\nfs.readFileSync('a');\n/* yg-suppress-enable(async-fs) */\nfs.readFileSync('b');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 4);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });
});

describe('suppress: wildcard semantics', () => {
  it('disable(*) suppresses all aspects', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\nconsole.log('x');\n// yg-suppress-enable(*)\nconsole.log('y');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('specific enable does NOT punch through wildcard disable', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('y');\nconsole.log('z');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(ranges).toEqual([]);
    expect(isLineSuppressed(ranges, 'any-aspect', 3)).toBe(false);
    // Inventory paths see nothing either — same matcher.
    expect(scanSuppressionMarkersInComments(tree, 'x.ts')).toHaveLength(0);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('a reasonless prose mention does NOT throw SuppressMarkerError (it is not a marker at all)', async () => {
    const code = ['// See the docs about yg-suppress(no-forbidden)', 'b();'].join('\n');
    const tree = await parseFile('x.ts', code);
    expect(collectSuppressions(tree, 'x.ts', 2)).toEqual([]);
  });

  it('id charset: anchored tokens with junk ids — (...) and (<aspect-id>) — are prose, not markers', async () => {
    const code = [
      '// yg-suppress(...) that merely appears inside a doc sentence',
      '// yg-suppress(<aspect-id>) placeholder from documentation',
      'b();',
    ].join('\n');
    const tree = await parseFile('x.ts', code);
    expect(collectSuppressions(tree, 'x.ts', 3)).toEqual([]);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('quotation-style `// // yg-suppress(x) r` is not a marker (at most ONE comment delimiter may precede the token)', async () => {
    const code = ['// // yg-suppress(x) quoted example from a code review', 'b();'].join('\n');
    const tree = await parseFile('x.ts', code);
    expect(collectSuppressions(tree, 'x.ts', 2)).toEqual([]);
    expect(scanSuppressionMarkers(code)).toHaveLength(0);
  });

  it('a backtick-quoted `yg-suppress(*)` at comment start is not a marker', async () => {
    const code = ['// `yg-suppress(*)` waives every aspect on the next line', 'b();'].join('\n');
    const tree = await parseFile('x.ts', code);
    expect(collectSuppressions(tree, 'x.ts', 2)).toEqual([]);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 4);
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
    const tree = await parseFile('x.ts', code);

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

describe('suppress: trailing block-comment closers are comment syntax, not reason text', () => {
  // RE_TRAILING_CLOSER strips a block-comment terminator ending the marker's own
  // line (`*/`, `-->`, `-}`, `*)`) BEFORE the reason is read: the closer must
  // never leak into the reason, and a marker whose "reason" is ONLY the closer
  // has no reason at all.

  it("'/* yg-suppress(my-aspect) legacy path */' → reason is exactly 'legacy path' (no trailing '*/')", async () => {
    const code = `/* yg-suppress(my-aspect) legacy path */\nconst x = 1;`;
    const tree = await parseFile('x.ts', code);
    // The honoring path accepts the marker (reason survives closer-stripping)…
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'my-aspect', 2)).toBe(true);
    // …and the parsed reason excludes the closer, exactly.
    const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe('legacy path');
  });

  it("'<!-- yg-suppress(my-aspect) generated -->' → reason is exactly 'generated' (no trailing '-->')", () => {
    const markers = scanSuppressionMarkers('<!-- yg-suppress(my-aspect) generated -->');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('single');
    expect(markers[0].reason).toBe('generated');
  });

  it("'/* yg-suppress(my-aspect) */' → reason is EMPTY after closer-stripping → SuppressMarkerError", async () => {
    const code = `/* yg-suppress(my-aspect) */\nconst x = 1;`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
  });

  it("disable form: '/* yg-suppress-disable(my-aspect) migration debt */' → kind disable, reason 'migration debt'", async () => {
    const code = `/* yg-suppress-disable(my-aspect) migration debt */\nconst x = 1;`;
    const tree = await parseFile('x.ts', code);
    const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('disable');
    expect(markers[0].reason).toBe('migration debt');
  });

  it("disable form: '/* yg-suppress-disable(my-aspect) */' → reason empty after closer-stripping → SuppressMarkerError", async () => {
    const code = `/* yg-suppress-disable(my-aspect) */\nconst x = 1;`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', code.split('\n').length);
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
    const tree = await parseFile('x.ts', code);
    // Honoring path (comment-isolated → optional delimiter): the interior line
    // with NO leading delimiter is still a marker.
    const ranges = collectSuppressions(tree, 'x.ts', 4);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    // Inventory comment scan agrees.
    const markers = scanSuppressionMarkersInComments(tree, 'x.ts');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ line: 2, aspectId: 'my-aspect', reason: 'known debt' });
    // But the SAME bare line raw-scanned (no comment isolation) is NOT a marker.
    expect(scanSuppressionMarkers('yg-suppress(my-aspect) known debt')).toHaveLength(0);
  });
});

describe('suppress: degenerate inverted ranges are never emitted (NOTE 6)', () => {
  it('a bare disable on the last line of the file emits no span', async () => {
    // start = totalLines + 1, end = totalLines → inverted → dropped.
    const code = ['const x = 1;', '// yg-suppress-disable(my-aspect) trailing'].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(ranges).toEqual([]);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });

  it('an enable directly following its disable emits no span', async () => {
    const code = ['// yg-suppress-disable(my-aspect) a', '// yg-suppress-enable(my-aspect)', 'const x = 1;'].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    // disable opens at line 2, enable closes at line 1 → inverted → dropped.
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });
});

describe('formatSuppressedRangesForAspect', () => {
  it('single-line marker → one 1-line span on the line below the marker', async () => {
    const code = [`a();`, `// yg-suppress(my-aspect) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    // disable on line 1 opens at line 2; enable on line 4 closes at line 3.
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('lone disable (no enable) → span runs to EOF (totalLines)', async () => {
    const code = [`// yg-suppress-disable(my-aspect) reason`, `a();`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('wildcard marker applies to ANY aspect id', async () => {
    const code = [`a();`, `// yg-suppress(*) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'whatever-id')).toEqual([{ startLine: 3, endLine: 3 }]);
    expect(formatSuppressedRangesForAspect(ranges, 'another-id')).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  it('returns [] when no range applies to the aspect', async () => {
    const code = [`a();`, `// yg-suppress(other-aspect) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
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
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 6);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 6, endLine: 6 },
    ]);
  });
});
