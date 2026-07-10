import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectSuppressions,
  isLineSuppressed,
  scanSuppressionMarkers,
  SuppressMarkerError,
} from '../../../src/ast/suppress.js';
import { withParsedFile } from '../../../src/ast/parser.js';
import {
  runSuppressionsScan,
  formatSuppressionsOutput,
} from '../../../src/cli/suppressions.js';

// ---------------------------------------------------------------------------
// BOUNTY 3 — yg-suppress forms + language-aware detection + inventory warnings.
//
// Targets gaps the existing suites leave open:
//   * tests/unit/ast/suppress.test.ts only covers Rust/Java/Kotlin LINE comments
//     and TS forms — never Python/Ruby (#), Go/C#/C/C++/PHP (//), YAML, JSON,
//     and never Rust/Kotlin BLOCK comments.
//   * tests/unit/cli/suppressions.test.ts exercises the SCANNER and FORMATTER,
//     but the WARNING engine (unknown-id / wildcard / unbounded) and the
//     noise-file / binary exclusion live inside runSuppressionsScan and are
//     tested only through an in-memory MIRROR helper — never the real
//     filesystem-walking function. This suite drives the real function.
//   * the divergence between collectSuppressions (reviewer, Map-guard close)
//     and runSuppressionsScan (inventory, stack pop) on nested disables.
//
// HERMETIC: every test uses a fresh mkdtemp tree under os.tmpdir(), cleaned in
// finally / afterEach. No network, no LLM, no clock-in-assertion, no randomness.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// Track temp dirs created outside try/finally for afterEach cleanup safety net.
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDir(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `yg-bounty3-${label}-`));
  tempDirs.push(d);
  return d;
}

/** Parse + collect ranges for a snippet and return the SuppressedRange[].
 *  The WASM tree lives only inside the withParsedFile callback. */
async function rangesOf(file: string, code: string) {
  const total = code.split('\n').length;
  return withParsedFile(file, code, (tree) => collectSuppressions(tree, file, total));
}

// ===========================================================================
// 1. LANGUAGE-AWARE COMMENT DETECTION — the families the AST suite never pins.
//    A wrong commentTypes / commentDelimiters value silently disables suppress
//    for a whole language: if collectSuppressions returns no range, a real
//    violation is reported and the marker the author wrote is INERT. That is a
//    lost-waiver invariant, so each family gets an explicit pin.
// ===========================================================================

describe('bounty3: language-aware comment detection (hash-comment languages)', () => {
  it('Python: a # yg-suppress line comment is detected', async () => {
    const code = 'x = 1\n# yg-suppress(my-aspect) reason here\ny = 2';
    const ranges = await rangesOf('a.py', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Ruby: a # yg-suppress line comment is detected', async () => {
    const code = 'x = 1\n# yg-suppress(my-aspect) reason here\ny = 2';
    const ranges = await rangesOf('a.rb', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('Python: hash-comment disable/enable wildcard range works end to end', async () => {
    const code = [
      'a = 1',
      '# yg-suppress-disable(*) batch cleanup queued',
      'b = 2',
      'c = 3',
      '# yg-suppress-enable(*)',
      'd = 4',
    ].join('\n');
    const ranges = await rangesOf('w.py', code);
    expect(isLineSuppressed(ranges, 'anything-at-all', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'anything-at-all', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'anything-at-all', 6)).toBe(false);
  });
});

describe('bounty3: language-aware comment detection (slash-comment languages)', () => {
  it('Go: a // yg-suppress line comment is detected', async () => {
    const code = 'package main\n// yg-suppress(my-aspect) reason\nvar x = 1';
    const ranges = await rangesOf('a.go', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('C#: a // yg-suppress line comment is detected', async () => {
    const code = 'class A {}\n// yg-suppress(my-aspect) reason\nclass B {}';
    const ranges = await rangesOf('A.cs', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('C: a // yg-suppress line comment is detected', async () => {
    const code = 'int a;\n// yg-suppress(my-aspect) reason\nint b;';
    const ranges = await rangesOf('a.c', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('C++: a // yg-suppress line comment is detected', async () => {
    const code = 'int a;\n// yg-suppress(my-aspect) reason\nint b;';
    const ranges = await rangesOf('a.cpp', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('PHP: a // yg-suppress line comment is detected', async () => {
    const code = '<?php\n// yg-suppress(my-aspect) reason\n$b = 1;';
    const ranges = await rangesOf('a.php', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });
});

describe('bounty3: BLOCK-comment detection (block_comment node type) for Rust + Kotlin', () => {
  // The AST suite only pins // line comments for Rust/Kotlin. Both registry
  // entries list 'block_comment' too — a /* ... */ marker must be honored, or
  // an author using block comments in those languages gets a silent inert
  // marker.
  it('Rust: a /* yg-suppress */ block comment is detected', async () => {
    const code = 'fn f(){}\n/* yg-suppress(my-aspect) reason */\nfn g(){}';
    const ranges = await rangesOf('a.rs', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('Kotlin: a /* yg-suppress */ block comment is detected', async () => {
    const code = 'fun f(){}\n/* yg-suppress(my-aspect) reason */\nfun g(){}';
    const ranges = await rangesOf('a.kt', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });
});

describe('bounty3: data-language comment handling (YAML has comments, JSON has none)', () => {
  it('YAML: a # yg-suppress comment is detected', async () => {
    const code = 'key: value\n# yg-suppress(my-aspect) reason\nkey2: value2';
    const ranges = await rangesOf('a.yaml', code);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
  });

  it('JSON: registry declares no comment types, so collectSuppressions yields nothing', async () => {
    // JSON has commentTypes: [] in the registry. Even valid JSON with no comment
    // node never produces a marker — the function returns an empty range list.
    const code = '{\n  "x": 1\n}';
    const ranges = await rangesOf('a.json', code);
    expect(ranges).toEqual([]);
  });
});

// ===========================================================================
// 2. collectSuppressions FORM SEMANTICS — branches the AST suite leaves open.
// ===========================================================================

describe('bounty3: single-line form scopes EXACTLY the line below the marker', () => {
  it('marker on the LAST line produces an empty range (startLine > totalLines)', async () => {
    // m.line + 1 for a marker on the final line is past EOF; the range
    // [startLine, endLine] = [last+1, last] is empty — nothing is suppressed,
    // and isLineSuppressed must never report a phantom suppression.
    const code = 'foo();\n// yg-suppress(async-fs) trailing marker, debt tracked';
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(false);
    expect(isLineSuppressed(ranges, 'async-fs', 1)).toBe(false);
  });

  it('two single-line markers each cover only their own next line', async () => {
    const code = [
      '// yg-suppress(a-rule) one',   // 1 -> covers line 2
      'first();',                     // 2
      'middle();',                    // 3 (uncovered)
      '// yg-suppress(b-rule) two',   // 4 -> covers line 5
      'second();',                    // 5
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'a-rule', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'a-rule', 3)).toBe(false);
    expect(isLineSuppressed(ranges, 'b-rule', 5)).toBe(true);
    expect(isLineSuppressed(ranges, 'b-rule', 3)).toBe(false);
  });
});

describe('bounty3: empty-reason rejection covers BOTH single-line and disable forms', () => {
  it('single-line with no reason throws SuppressMarkerError with file + line populated', async () => {
    const code = '// yg-suppress(async-fs)\nfs.readFileSync("a");';
    await withParsedFile('x.ts', code, (tree) => {
      let thrown: unknown;
      try {
        collectSuppressions(tree, 'x.ts', 2);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SuppressMarkerError);
      const err = thrown as SuppressMarkerError;
      expect(err.code).toBe('SUPPRESS_MARKER_MISSING_REASON');
      expect(err.file).toBe('x.ts');
      expect(err.line).toBe(1); // marker is on line 1
    });
  });

  it('disable with no reason throws; enable with no reason is VALID (never throws)', async () => {
    const bad = '// yg-suppress-disable(async-fs)\ncode();';
    await withParsedFile('bad.ts', bad, (badTree) => {
      expect(() => collectSuppressions(badTree, 'bad.ts', 2)).toThrow(SuppressMarkerError);
    });

    // A reasoned disable closed by a bare (reasonless) enable must NOT throw —
    // RE_ENABLE captures only the id; the enable form is reason-free by design.
    const good = [
      '// yg-suppress-disable(async-fs) legacy block, debt tracked',
      'code();',
      '// yg-suppress-enable(async-fs)',
      'after();',
    ].join('\n');
    const ranges = await rangesOf('good.ts', good);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });
});

describe('bounty3: bracket disable/enable ordering + stray-marker edge cases', () => {
  it('a stray enable BEFORE any disable is a no-op; a later unterminated disable still extends to EOF', async () => {
    const code = [
      '// yg-suppress-enable(a) stray enable, no open range',  // 1 no-op
      'before();',                                            // 2
      '// yg-suppress-disable(a) open to EOF, debt tracked',  // 3
      'after();',                                             // 4
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'a', 2)).toBe(false);
    expect(isLineSuppressed(ranges, 'a', 4)).toBe(true);
  });

  it('NESTED same-id disable: the Map-guard keeps the FIRST start; a single enable CLOSES the range', async () => {
    // collectSuppressions guards openSpecific with `!has(id)`, so a second
    // disable(a) is ignored and one enable(a) closes the range that opened at
    // the FIRST disable. Lines after the enable are NOT suppressed. This is the
    // reviewer-side ground truth that the inventory's stack model diverges from
    // (pinned in the divergence test below).
    const code = [
      '// yg-suppress-disable(a) first, debt tracked',   // 1
      'one();',                                          // 2
      '// yg-suppress-disable(a) nested, debt tracked',  // 3
      'two();',                                          // 4
      '// yg-suppress-enable(a)',                        // 5
      'three();',                                        // 6 — NOT suppressed
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'a', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'a', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'a', 6)).toBe(false);
  });
});

describe('bounty3: wildcard semantics — single-line wildcard + comma list with *', () => {
  it('single-line yg-suppress(*) waives EVERY aspect on exactly the next line only', async () => {
    const code = [
      '// yg-suppress(*) blanket waiver, debt tracked',  // 1
      'offending();',                                    // 2 (covered, any aspect)
      'clean();',                                        // 3 (not covered)
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'any-aspect-name', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'other-aspect', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'any-aspect-name', 3)).toBe(false);
  });

  it('comma list yg-suppress(a, *): the range is wildcard, so it waives a third unrelated aspect too', async () => {
    const code = '// yg-suppress(specific, *) mixed list, debt tracked\nline();';
    const ranges = await rangesOf('x.ts', code);
    // isWildcard is set when any id is '*', so the whole range is a wildcard.
    expect(isLineSuppressed(ranges, 'specific', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'totally-unrelated', 2)).toBe(true);
  });
});

describe('bounty3: collectSuppressions guards on unknown extension', () => {
  it('an unknown extension yields an empty range list (no throw, no comment lookup)', async () => {
    // Parse as TS but pass a path whose extension is unknown — getLanguage
    // ForExtension returns null and the function short-circuits to [].
    const code = 'const x = 1;\n// yg-suppress(my-aspect) reason\nconst y = 2;';
    const ranges = await withParsedFile('x.ts', code, (tree) =>
      collectSuppressions(tree, 'file.unknownextxyz', 3),
    );
    expect(ranges).toEqual([]);
  });
});

// ===========================================================================
// 3. scanSuppressionMarkers — raw, language-agnostic scanner edge cases the
//    cli suppressions suite leaves open.
// ===========================================================================

describe('bounty3: scanSuppressionMarkers raw-scan edge cases', () => {
  it('disable-form on a line is classified as disable, never as a single (precedence)', () => {
    const markers = scanSuppressionMarkers('// yg-suppress-disable(a) reason text');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('disable');
  });

  it('hash-prefixed marker with no comment delimiter stripping is still matched (language-agnostic)', () => {
    const markers = scanSuppressionMarkers('# yg-suppress(py-rule) reason');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ aspectId: 'py-rule', kind: 'single', reason: 'reason' });
  });

  it('a comma list containing * yields a normal entry AND a wildcard entry on the same line', () => {
    const markers = scanSuppressionMarkers('// yg-suppress(real-id, *) mixed');
    expect(markers.map(m => ({ id: m.aspectId, w: m.wildcard }))).toEqual([
      { id: 'real-id', w: false },
      { id: '*', w: true },
    ]);
  });

  it('empty/whitespace entries in the comma list are dropped', () => {
    const markers = scanSuppressionMarkers('// yg-suppress(a, , b) reason');
    expect(markers.map(m => m.aspectId)).toEqual(['a', 'b']);
  });

  it('a single-line marker with NO reason still scans (the SCANNER does not enforce reason)', () => {
    // Only collectSuppressions throws on a missing reason. The inventory scanner
    // happily lists it (reason: '').
    const markers = scanSuppressionMarkers('// yg-suppress(a)');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ aspectId: 'a', kind: 'single', reason: '' });
  });

  it('a non-marker comment produces no entries', () => {
    expect(scanSuppressionMarkers('// just a normal comment about yg stuff')).toHaveLength(0);
  });

  it('reports 1-based line numbers across a multi-line buffer', () => {
    const markers = scanSuppressionMarkers('a\nb\n// yg-suppress(x) r\nc');
    expect(markers[0].line).toBe(3);
  });
});

// ===========================================================================
// 4. runSuppressionsScan — the REAL filesystem-walking warning engine.
//    The existing cli suite only tests an in-memory MIRROR; this drives the
//    actual function over a temp tree.
// ===========================================================================

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('bounty3: runSuppressionsScan noise + binary exclusion (live-waiver invariant)', () => {
  it('excludes .yggdrasil/, generated rules mirrors, any log.md, prose docs, and binary files', async () => {
    const root = freshDir('noise');
    write(root, 'src/real.ts', '// yg-suppress(known) genuine waiver, tracked\nx();\n');
    write(root, 'README.md', '// yg-suppress(known) doc only mentions syntax\n');
    write(root, 'CHANGELOG.markdown', '// yg-suppress(known) changelog mention\n');
    write(root, 'notes.txt', '// yg-suppress(known) text note\n');
    write(root, 'rules.mdc', '// yg-suppress(known) mdc mention\n');
    write(root, 'src/deep/log.md', '// yg-suppress(known) nested per-node log\n');
    write(root, '.yggdrasil/agent-rules.md', '// yg-suppress(known) rules block\n');
    write(root, '.yggdrasil/model/x/yg-node.yaml', '# yg-suppress(known) yaml example\n');
    write(root, '.cursor/rules/yggdrasil.mdc', '// yg-suppress(known) cursor mirror\n');
    write(root, '.github/copilot-instructions.md', '// yg-suppress(known) copilot mirror\n');
    write(root, '.windsurfrules', '// yg-suppress(known) windsurf mirror\n');
    write(root, '.clinerules', '// yg-suppress(known) cline mirror\n');
    // Binary: a NUL byte in the first 8 KB even though it contains marker text.
    write(root, 'blob.bin', Buffer.concat([Buffer.from('// yg-suppress(known) inside binary\n'), Buffer.from([0])]));

    const files = [
      'src/real.ts', 'README.md', 'CHANGELOG.markdown', 'notes.txt', 'rules.mdc',
      'src/deep/log.md', '.yggdrasil/agent-rules.md', '.yggdrasil/model/x/yg-node.yaml',
      '.cursor/rules/yggdrasil.mdc', '.github/copilot-instructions.md',
      '.windsurfrules', '.clinerules', 'blob.bin',
    ];
    const report = await runSuppressionsScan(root, files, new Set(['known']));

    // Only the genuine source file is a live waiver site.
    expect(report.fileEntries.map(f => f.file)).toEqual(['src/real.ts']);
    expect(report.totalMarkers).toBe(1);
    expect(report.warnings).toHaveLength(0);
  });

  it('a tracked file missing from disk is skipped silently (git/working-tree race)', async () => {
    const root = freshDir('missing');
    write(root, 'present.ts', '// yg-suppress(known) here\nx();\n');
    const report = await runSuppressionsScan(root, ['present.ts', 'GONE_FROM_DISK.ts'], new Set(['known']));
    expect(report.fileEntries.map(f => f.file)).toEqual(['present.ts']);
    expect(report.totalMarkers).toBe(1);
  });

  it('an empty file list returns an empty, warning-free report', async () => {
    const root = freshDir('empty');
    const report = await runSuppressionsScan(root, [], new Set(['known']));
    expect(report.fileEntries).toHaveLength(0);
    expect(report.totalMarkers).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });
});

describe('bounty3: runSuppressionsScan warning generation (all three kinds, real FS)', () => {
  it('warns on unknown aspect id, on wildcard, and on unbounded disable — exempting wildcard from unknown', async () => {
    const root = freshDir('warns');
    write(root, 'unknown.ts', '// yg-suppress(ghost-typo) renamed away\nx();\n');
    write(root, 'wild.ts', '// yg-suppress(*) emergency bypass\nx();\n');
    // The disable sits BELOW the file-head window (6th non-empty line), so it is a
    // genuinely-unbounded disable — not the sanctioned file-level whole-file form
    // (RZ-12), which would not warn.
    write(root, 'open.ts', 'a1();\na2();\na3();\na4();\na5();\n// yg-suppress-disable(known) legacy, never closed\nmore();\n');

    const report = await runSuppressionsScan(
      root,
      ['unknown.ts', 'wild.ts', 'open.ts'],
      new Set(['known']),
    );

    const heads = report.warnings.map(w => w.split('\n')[0]);
    expect(heads).toContain('Unknown aspect id "ghost-typo" in suppress marker at unknown.ts:1.');
    expect(heads.some(h => h.startsWith('Wildcard suppression "*" at wild.ts:1'))).toBe(true);
    expect(heads.some(h => h.startsWith('Unbounded yg-suppress-disable("known") at open.ts:6'))).toBe(true);

    // The wildcard marker must NOT also be reported as an unknown aspect id.
    expect(report.warnings.some(w => w.includes('Unknown aspect id "*"'))).toBe(false);
  });

  it('a bounded disable+enable pair produces NO unbounded warning', async () => {
    const root = freshDir('bounded');
    write(
      root,
      'b.ts',
      [
        '// yg-suppress-disable(known) bounded block, debt tracked',
        'x();',
        '// yg-suppress-enable(known)',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['b.ts'], new Set(['known']));
    expect(report.warnings.some(w => w.startsWith('Unbounded'))).toBe(false);
  });

  it('a mixed comma list yg-suppress(known, *) fires exactly ONE warning (the wildcard, de-duped per file:line)', async () => {
    const root = freshDir('mixed');
    write(root, 'm.ts', '// yg-suppress(known, *) mixed list, debt tracked\nx();\n');
    const report = await runSuppressionsScan(root, ['m.ts'], new Set(['known']));
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].split('\n')[0]).toMatch(/^Wildcard suppression "\*" at m\.ts:1/);
  });

  it('DIVERGENCE: a known but UNKNOWN-cased id still warns (matcher is exact-string, not normalized)', async () => {
    // Known set has "known"; a marker spelling "KNOWN" is a different string and
    // must be reported as unknown — pinning that the matcher does no casefolding.
    const root = freshDir('case');
    write(root, 'c.ts', '// yg-suppress(KNOWN) wrong case, debt tracked\nx();\n');
    const report = await runSuppressionsScan(root, ['c.ts'], new Set(['known']));
    expect(report.warnings.some(w => w.includes('Unknown aspect id "KNOWN"'))).toBe(true);
  });
});

// ===========================================================================
// 5. DIVERGENCE between the two engines on nested same-id disables.
//    collectSuppressions (reviewer) closes the range at the single enable;
//    runSuppressionsScan (inventory stack) still reports the FIRST disable as
//    unbounded. The inventory warning is therefore over-reported relative to
//    the actual reviewer behavior. We pin BOTH observed behaviors so a future
//    fix to either side is caught.
// ===========================================================================

describe('bounty3: nested-disable divergence — reviewer closes, inventory over-warns', () => {
  it('reviewer (collectSuppressions): nested disable + single enable => line after enable NOT suppressed', async () => {
    const code = [
      '// yg-suppress-disable(a) first, debt tracked',   // 1
      'one();',                                          // 2
      '// yg-suppress-disable(a) nested, debt tracked',  // 3
      'two();',                                          // 4
      '// yg-suppress-enable(a)',                        // 5
      'three();',                                        // 6
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'a', 6)).toBe(false);
  });

  it('inventory (runSuppressionsScan): the SAME nested disable still emits an Unbounded warning', async () => {
    const root = freshDir('diverge');
    write(
      root,
      'd.ts',
      [
        // Five non-empty lines push the nested block BELOW the file-head window, so
        // the still-open first disable is genuinely unbounded — not the sanctioned
        // file-level whole-file form (RZ-12), which would not warn.
        'pre1();',
        'pre2();',
        'pre3();',
        'pre4();',
        'pre5();',
        '// yg-suppress-disable(a) first, debt tracked',
        'one();',
        '// yg-suppress-disable(a) nested, debt tracked',
        'two();',
        '// yg-suppress-enable(a)',
        'three();',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['d.ts'], new Set(['a']));
    // Observed: the inventory's stack model leaves the FIRST disable open and
    // warns Unbounded, even though the reviewer closed the range at the enable.
    expect(report.warnings.some(w => w.startsWith('Unbounded yg-suppress-disable("a")'))).toBe(true);
  });
});

// ===========================================================================
// 6. formatSuppressionsOutput — rendering invariants (no chalk-color assertions;
//    we assert plain substrings so colorization does not flake the test).
// ===========================================================================

describe('bounty3: formatSuppressionsOutput rendering', () => {
  it('singular vs plural tally: 1 marker / 1 file uses singular wording', () => {
    const out = formatSuppressionsOutput({
      fileEntries: [{ file: 'a.ts', markers: [{ line: 1, aspectId: 'x', kind: 'single', wildcard: false, reason: 'r' }] }],
      totalMarkers: 1,
      warnings: [],
    });
    expect(out).toContain('1 marker across 1 file.');
    expect(out).not.toContain('1 markers');
  });

  it('renders the [wildcard] tag and the kind/aspect for each marker', () => {
    const out = formatSuppressionsOutput({
      fileEntries: [{
        file: 'a.ts',
        markers: [
          { line: 3, aspectId: '*', kind: 'single', wildcard: true, reason: 'blanket' },
          { line: 7, aspectId: 'audit', kind: 'disable', wildcard: false, reason: '' },
        ],
      }],
      totalMarkers: 2,
      warnings: [],
    });
    expect(out).toContain('[wildcard]');
    expect(out).toContain('single(*)');
    expect(out).toContain('disable(audit)');
    // A reasonless marker renders without a trailing em-dash reason segment.
    expect(out).toContain('disable(audit)');
    expect(out).not.toContain('disable(audit) [wildcard]');
  });

  it('empty report renders the no-markers line even when warnings exist', () => {
    const out = formatSuppressionsOutput({ fileEntries: [], totalMarkers: 0, warnings: ['w1', 'w2'] });
    expect(out).toContain('No active suppression markers found.');
  });

  it('warnings section header counts the warnings', () => {
    const out = formatSuppressionsOutput({
      fileEntries: [{ file: 'a.ts', markers: [{ line: 1, aspectId: 'x', kind: 'single', wildcard: false, reason: 'r' }] }],
      totalMarkers: 1,
      warnings: ['first warning text', 'second warning text'],
    });
    expect(out).toContain('Warnings (2):');
    expect(out).toContain('first warning text');
    expect(out).toContain('second warning text');
  });
});

// ===========================================================================
// 7. E2E — `yg suppressions` against a real temp fixture. Pins the always-0
//    exit code + that the rendered inventory and all three warning kinds reach
//    stdout. Hermetic: the suppressions command makes no LLM call, so no mock
//    reviewer is needed; it only reads git-tracked files.
// ===========================================================================

function gitInit(dir: string): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

describe.skipIf(!distExists)('bounty3 E2E: yg suppressions always exits 0 and lists waivers + warnings', () => {
  it('renders genuine waivers, skips doc/log noise, warns on unknown/wildcard/unbounded, exit 0', () => {
    const dir = freshDir('e2e');
    cpSync(FIXTURE, dir, { recursive: true });

    // A genuine source-side waiver.
    appendFileSync(
      path.join(dir, 'src', 'services', 'orders.ts'),
      '\n// yg-suppress(no-todo-comments) genuine waiver, debt tracked in the issue tracker\nconst t = 1;\n',
      'utf-8',
    );
    // All three warning footguns in one source file.
    appendFileSync(
      path.join(dir, 'src', 'services', 'payments.ts'),
      [
        '',
        '// yg-suppress(ghost-renamed) refers to a deleted aspect',
        '// yg-suppress(*) blanket bypass',
        '// yg-suppress-disable(no-todo-comments) open block never closed',
        '',
      ].join('\n'),
      'utf-8',
    );
    // Pure NOISE that must NOT be counted: a doc file mentioning the syntax.
    writeFileSync(
      path.join(dir, 'NOTES.md'),
      '// yg-suppress(no-todo-comments) this is only documentation prose\n',
      'utf-8',
    );

    gitInit(dir);

    const res = spawnSync('node', [BIN_PATH, 'suppressions'], { cwd: dir, encoding: 'utf-8' });
    const all = (res.stdout ?? '') + (res.stderr ?? '');

    // Always exit 0 — purely informational command.
    expect(res.status).toBe(0);

    // Inventory lists the two genuine source files but NOT the doc file.
    expect(all).toContain('src/services/orders.ts');
    expect(all).toContain('src/services/payments.ts');
    expect(all).not.toContain('NOTES.md');

    // All three warning kinds reached the output.
    expect(all).toContain('Unknown aspect id "ghost-renamed"');
    expect(all).toContain('Wildcard suppression "*"');
    expect(all).toContain('Unbounded yg-suppress-disable("no-todo-comments")');
  });

  it('a clean fixture with NO markers prints the no-markers line and exits 0', () => {
    const dir = freshDir('e2e-clean');
    cpSync(FIXTURE, dir, { recursive: true });
    gitInit(dir);

    const res = spawnSync('node', [BIN_PATH, 'suppressions'], { cwd: dir, encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect((res.stdout ?? '') + (res.stderr ?? '')).toContain('No active suppression markers found.');
  });
});
