// BOUNTY 4 — SPEC-CONFORMANCE audit for the `suppress-syntax` knowledge topic.
//
// SPEC (ground truth):  node dist/bin.js knowledge read suppress-syntax
//   source: src/templates/knowledge/suppress-syntax.ts
// CODE under test:
//   - src/ast/suppress.ts        (collectSuppressions / isLineSuppressed —
//                                  the reviewer-honored engine; scanSuppressionMarkers —
//                                  the inventory scanner; SuppressMarkerError)
//   - src/cli/suppressions.ts    (runSuppressionsScan / formatSuppressionsOutput —
//                                  the `yg suppressions` inventory; spawned binary)
//
// Each test names the SPEC sentence it pins (quoted) and exercises the REAL
// function (or the real binary for CLI-observable behavior). Where the code
// diverges from the documented promise, the assertion is removed and the gap is
// recorded in the structured output's suspectedBugs[]; the saved file stays 100%
// green.
//
// HERMETIC: every temp tree is a fresh mkdtemp under os.tmpdir(), cleaned in
// finally/afterEach. No network, no LLM, no randomness, no wall-clock read in any
// assertion. tree-sitter parsing is local (bundled WASM grammars).

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../../support/git-fixture.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDir(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `yg-bounty4-${label}-`));
  tempDirs.push(d);
  return d;
}

/** Parse a snippet and collect reviewer-honored ranges.
 *  The WASM tree lives only inside the withParsedFile callback. */
async function rangesOf(file: string, code: string) {
  return withParsedFile(file, code, (tree) =>
    collectSuppressions(tree, file, code.split('\n').length),
  );
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ===========================================================================
// SPEC §"Single-line": "The single-line form suppresses the immediately
//   following line only."  Verified against the EXACT three language examples
//   the spec prints (TypeScript //, Python #, YAML #).
// ===========================================================================

describe('spec: single-line form suppresses the immediately following line only', () => {
  it('TypeScript (// example from spec) — covers next line, not the marker line, not the line after', async () => {
    // // yg-suppress(security/input-validation) static config, no user input
    // const TIMEOUT = parseInt(process.env.TIMEOUT_MS);
    const code = [
      'const A = 1;',                                                       // 1
      '// yg-suppress(security/input-validation) static config, no input',  // 2
      'const TIMEOUT = parseInt(process.env.TIMEOUT_MS);',                  // 3
      'const B = 2;',                                                       // 4
    ].join('\n');
    const ranges = await rangesOf('config.ts', code);
    expect(isLineSuppressed(ranges, 'security/input-validation', 3)).toBe(true);  // immediately following
    expect(isLineSuppressed(ranges, 'security/input-validation', 2)).toBe(false); // the marker line itself
    expect(isLineSuppressed(ranges, 'security/input-validation', 4)).toBe(false); // only ONE line
  });

  it('Python (# example from spec) — # comment form is honored, next line covered', async () => {
    // # yg-suppress(cqrs/single-responsibility) brownfield handler, refactor TICKET-123
    // def handle_order(request):
    const code = [
      'x = 1',                                                                  // 1
      '# yg-suppress(cqrs/single-responsibility) brownfield, refactor later',   // 2
      'def handle_order(request):',                                            // 3
      '    pass',                                                              // 4
    ].join('\n');
    const ranges = await rangesOf('handler.py', code);
    expect(isLineSuppressed(ranges, 'cqrs/single-responsibility', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'cqrs/single-responsibility', 4)).toBe(false);
  });

  it('YAML (# example from spec) — # comment form is honored', async () => {
    // # yg-suppress(schema/required-description) auto-generated, description added later
    // name: GeneratedNode
    const code = [
      '# yg-suppress(schema/required-description) auto-generated',  // 1
      'name: GeneratedNode',                                        // 2
    ].join('\n');
    const ranges = await rangesOf('node.yaml', code);
    expect(isLineSuppressed(ranges, 'schema/required-description', 2)).toBe(true);
  });
});

// ===========================================================================
// SPEC §"Single-line": "The token inside the parentheses is the aspect id ...
//   ids may be hierarchical like `parent/child`."
// ===========================================================================

describe('spec: aspect id may be hierarchical (parent/child)', () => {
  it('a parent/child id is matched verbatim as the aspect id', async () => {
    const ranges = await rangesOf('x.ts', '// yg-suppress(audit-logging/emit-before-mutate) ok\nmutate();');
    expect(isLineSuppressed(ranges, 'audit-logging/emit-before-mutate', 2)).toBe(true);
    // a different child under the same parent is a different string => not suppressed
    expect(isLineSuppressed(ranges, 'audit-logging/other', 2)).toBe(false);
  });
});

// ===========================================================================
// SPEC §"Reason text" / final paragraph: "A suppress marker (single or disable
//   form) must carry a reason — an empty reason is rejected with a clear error."
//   The error code documented in code is SUPPRESS_MARKER_MISSING_REASON.
// ===========================================================================

describe('spec: a missing reason is rejected with a clear error (single + disable)', () => {
  it('single-line with NO reason throws SuppressMarkerError (code SUPPRESS_MARKER_MISSING_REASON)', async () => {
    await withParsedFile('x.ts', '// yg-suppress(some-aspect)\ncode();', (tree) => {
      let thrown: unknown;
      try { collectSuppressions(tree, 'x.ts', 2); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(SuppressMarkerError);
      expect((thrown as SuppressMarkerError).code).toBe('SUPPRESS_MARKER_MISSING_REASON');
      expect((thrown as SuppressMarkerError).line).toBe(1);
    });
  });

  it('disable with NO reason throws SuppressMarkerError', async () => {
    await withParsedFile('x.ts', '// yg-suppress-disable(some-aspect)\ncode();', (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });

  it('a whitespace-only reason is treated as empty and rejected', async () => {
    await withParsedFile('x.ts', '// yg-suppress(some-aspect)    \ncode();', (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
    });
  });

  it('the ENABLE form is reason-free by design and never throws', async () => {
    const code = [
      '// yg-suppress-disable(some-aspect) legacy, tracked',
      'code();',
      '// yg-suppress-enable(some-aspect)',   // no reason — must be accepted
      'after();',
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'some-aspect', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'some-aspect', 4)).toBe(false);
  });
});

// ===========================================================================
// SPEC §"Bracket": "The bracket form suppresses all lines between the disable
//   and enable markers."  Verified against the TypeScript example shape.
// ===========================================================================

describe('spec: bracket form suppresses all lines between disable and enable', () => {
  it('every line strictly between the markers is suppressed; lines outside are not', async () => {
    const code = [
      '// yg-suppress-disable(audit-logging/emit-before-mutate) legacy, TICKET-456',  // 1
      'function legacyUpdate(id) {',                                                  // 2
      '  return repo.update(id, data);',                                             // 3
      '}',                                                                           // 4
      '// yg-suppress-enable(audit-logging/emit-before-mutate)',                     // 5
      'clean();',                                                                    // 6
    ].join('\n');
    const id = 'audit-logging/emit-before-mutate';
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, id, 2)).toBe(true);
    expect(isLineSuppressed(ranges, id, 3)).toBe(true);
    expect(isLineSuppressed(ranges, id, 4)).toBe(true);
    expect(isLineSuppressed(ranges, id, 6)).toBe(false); // after enable
  });

  it('block-comment (/* */) disable/enable markers are honored too', async () => {
    const code = [
      '/* yg-suppress-disable(rule-x) refactor planned */',  // 1
      'work();',                                             // 2
      '/* yg-suppress-enable(rule-x) */',                    // 3
      'done();',                                             // 4
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'rule-x', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-x', 4)).toBe(false);
  });
});

// ===========================================================================
// SPEC §"Bracket": "The enable marker must repeat the same aspect id as the
//   disable marker — only a matching enable closes the range. An enable with
//   no open disable is ignored, and a disable with no matching enable
//   suppresses through to the end of the file. The matcher does not raise an
//   error for an unmatched marker."
// ===========================================================================

describe('spec: only a MATCHING enable closes the range', () => {
  it('a non-matching enable id does NOT close an open disable', async () => {
    const code = [
      '// yg-suppress-disable(rule-a) tracked',  // 1
      'a();',                                    // 2
      '// yg-suppress-enable(rule-b)',           // 3  (different id — must NOT close rule-a)
      'b();',                                    // 4
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-a', 4)).toBe(true); // still open through EOF
  });

  it('a matching enable id closes the range exactly', async () => {
    const code = [
      '// yg-suppress-disable(rule-a) tracked',  // 1
      'a();',                                    // 2
      '// yg-suppress-enable(rule-a)',           // 3
      'b();',                                    // 4
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-a', 4)).toBe(false);
  });
});

describe('spec: an enable with no open disable is ignored (no throw, no range)', () => {
  it('a stray enable before any disable produces no suppression and no error', async () => {
    const code = [
      '// yg-suppress-enable(rule-a)',  // 1  stray — ignored
      'work();',                        // 2
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(ranges).toEqual([]);            // ignored: produced no range
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(false);
  });
});

describe('spec: a disable with no matching enable suppresses through to end of file', () => {
  it('an unterminated disable covers every line below it to EOF', async () => {
    const code = [
      '// yg-suppress-disable(rule-a) until ticket-X',  // 1
      'a();',                                           // 2
      'b();',                                           // 3
      'c();',                                           // 4 (last line)
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-a', 4)).toBe(true); // through EOF
  });
});

describe('spec: the matcher does not raise an error for an unmatched marker', () => {
  it('an open disable (no enable) does NOT throw — it silently extends to EOF', async () => {
    await withParsedFile('x.ts', '// yg-suppress-disable(rule-a) tracked\na();\nb();', (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 3)).not.toThrow();
    });
  });
  it('a stray enable (no disable) does NOT throw', async () => {
    await withParsedFile('x.ts', '// yg-suppress-enable(rule-a)\na();', (tree) => {
      expect(() => collectSuppressions(tree, 'x.ts', 2)).not.toThrow();
    });
  });
});

// ===========================================================================
// SPEC §"Wildcard": "`*` as the id suppresses ALL aspects (LLM, AST, and
//   structure) in the range." and "A specific `enable(<id>)` does NOT punch
//   through `disable(*)` — the wildcard disable covers the entire range
//   regardless of specific enables within it."
// ===========================================================================

describe('spec: wildcard `*` suppresses ALL aspects in the range', () => {
  it('disable(*)/enable(*) waives every (arbitrary) aspect id between the markers', async () => {
    const code = [
      '// yg-suppress-disable(*) generated code, do not edit manually',  // 1
      'export const GENERATED_MAPPING = {};',                           // 2
      'more();',                                                        // 3
      '// yg-suppress-enable(*)',                                       // 4
      'hand();',                                                        // 5
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    // ANY aspect id is waived inside the wildcard range...
    expect(isLineSuppressed(ranges, 'aspect-never-heard-of', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'another-arbitrary-one', 3)).toBe(true);
    // ...and nothing is waived after enable(*)
    expect(isLineSuppressed(ranges, 'aspect-never-heard-of', 5)).toBe(false);
  });

  it('single-line yg-suppress(*) waives every aspect on exactly the next line', async () => {
    const ranges = await rangesOf('x.ts', '// yg-suppress(*) generated\noffending();\nclean();');
    expect(isLineSuppressed(ranges, 'literally-anything', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'literally-anything', 3)).toBe(false);
  });
});

describe('spec: a specific enable(<id>) does NOT punch through disable(*)', () => {
  it('disable(*) keeps everything suppressed even after a specific enable(<id>) inside it', async () => {
    const code = [
      '// yg-suppress-disable(*) generated, do not edit',  // 1
      'one();',                                            // 2
      '// yg-suppress-enable(specific-id)',                // 3  (specific enable — must NOT punch through)
      'two();',                                            // 4
      'three();',                                          // 5
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    // even the specifically-"enabled" id stays suppressed under the wildcard
    expect(isLineSuppressed(ranges, 'specific-id', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'anything-else', 5)).toBe(true);
  });
});

// ===========================================================================
// SPEC §final paragraph: "the token is matched as a plain string against the
//   aspect id being checked: there is NO validation that the id names an
//   existing aspect, so a typo simply suppresses nothing (the marker is
//   inert)."
// ===========================================================================

describe('spec: a typo id is inert — it suppresses only its (nonexistent) own id, nothing real', () => {
  it('collectSuppressions never validates existence: a typo waives only that exact string', async () => {
    const ranges = await rangesOf('x.ts', '// yg-suppress(securty/input-validaton) typo, tracked\ncode();');
    // The real aspect is NOT suppressed (the typo did not waive it)...
    expect(isLineSuppressed(ranges, 'security/input-validation', 2)).toBe(false);
    // ...the parse itself does not throw on an unknown id — it is accepted verbatim.
    expect(isLineSuppressed(ranges, 'securty/input-validaton', 2)).toBe(true);
  });

  it('the marker is matched exact-string — no case folding (KNOWN != known)', async () => {
    // yg suppressions warning engine: a mismatched-case id is reported as unknown.
    const root = freshDir('case');
    write(root, 'c.ts', '// yg-suppress(KNOWN) wrong case, tracked\nx();\n');
    const report = await runSuppressionsScan(root, ['c.ts'], new Set(['known']));
    expect(report.warnings.some(w => w.includes('Unknown aspect id "KNOWN"'))).toBe(true);
  });
});

// ===========================================================================
// SPEC §"Single-line": comment-syntax-per-language detection. The reviewer
//   engine (collectSuppressions) resolves comment node types per the file
//   extension. A marker only counts when it is a real COMMENT in that language
//   (not, e.g., a string literal). Verified for the spec's three example
//   languages plus the string-literal exclusion.
// ===========================================================================

describe('spec: per-language comment-syntax detection (collectSuppressions)', () => {
  it('a yg-suppress that lives inside a STRING literal is NOT a marker', async () => {
    const code = [
      'const banner = "yg-suppress(rule-a) just text";',  // 1 — string, not a comment
      'offending();',                                     // 2
    ].join('\n');
    const ranges = await rangesOf('x.ts', code);
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(false);
  });

  it('an unknown file extension yields no suppressions (the engine cannot resolve comment types)', async () => {
    // Parse as TS but present an unknown extension; collectSuppressions guards
    // and returns [] rather than throwing.
    const ranges = await withParsedFile('x.ts', 'const x = 1;\n// yg-suppress(rule-a) r\nconst y = 2;', (tree) =>
      collectSuppressions(tree, 'file.unknownextxyz', 3),
    );
    expect(ranges).toEqual([]);
  });
});

// ===========================================================================
// SPEC §"Bracket" SQL example. The spec prints a SQL `-- yg-suppress-disable`
//   example as a valid bracket-form usage. The language-agnostic INVENTORY
//   scanner (scanSuppressionMarkers / `yg suppressions`) does detect it; the
//   reviewer-honored engine (collectSuppressions) does NOT, because there is
//   no SQL grammar in the registry. We pin the scanner behavior (green) and
//   record the reviewer-side gap as a suspected bug (no assertion on the gap).
// ===========================================================================

describe('spec: SQL `--` bracket-form example is detected by the inventory scanner', () => {
  it('scanSuppressionMarkers picks up the spec SQL disable/enable example verbatim', () => {
    const sql = [
      '-- yg-suppress-disable(no-select-star) reporting query batch',
      'SELECT * FROM users;',
      'SELECT * FROM orders;',
      '-- yg-suppress-enable(no-select-star)',
    ].join('\n');
    const markers = scanSuppressionMarkers(sql);
    expect(markers.map(m => ({ id: m.aspectId, kind: m.kind }))).toEqual([
      { id: 'no-select-star', kind: 'disable' },
      { id: 'no-select-star', kind: 'enable' },
    ]);
  });
});

// ===========================================================================
// SPEC §"Effect on approve": "A suppressed line or range does not generate a
//   violation, even if the code clearly violates the aspect." — verified at the
//   filter boundary via isLineSuppressed, the predicate the AST + structure
//   runners use to drop violations.
// ===========================================================================

describe('spec: a suppressed line is dropped from the violation set (filter predicate)', () => {
  it('isLineSuppressed is true for a covered line and false for an uncovered one', async () => {
    const ranges = await rangesOf('x.ts', '// yg-suppress(rule-a) tracked\noffend();\nclean();');
    // a runner drops a violation when isLineSuppressed(...) is true
    expect(isLineSuppressed(ranges, 'rule-a', 2)).toBe(true);  // dropped
    expect(isLineSuppressed(ranges, 'rule-a', 3)).toBe(false); // kept
  });
});

// ===========================================================================
// SPEC: `yg suppressions` is "Read-only inventory of active yg-suppress
//   markers; warns on unknown aspect-id, wildcard, or unbounded range. Exit 0."
//   (rules.ts table). End-to-end against the real binary.
// ===========================================================================

function gitInit(dir: string): void {
  runGitFixture(dir, ['init', '-q']);
  runGitFixture(dir, ['config', 'user.email', 'test@example.com']);
  runGitFixture(dir, ['config', 'user.name', 'Test']);
  runGitFixture(dir, ['add', '-A']);
  runGitFixture(dir, ['commit', '-qm', 'init']);
}

describe.skipIf(!distExists)('spec: `yg suppressions` inventory — exit 0 + warns on the three documented footguns', () => {
  it('lists genuine source waivers, warns on unknown/wildcard/unbounded, always exits 0', () => {
    const dir = freshDir('e2e');
    cpSync(FIXTURE, dir, { recursive: true });

    appendFileSync(
      path.join(dir, 'src', 'services', 'orders.ts'),
      '\n// yg-suppress(no-todo-comments) genuine waiver, debt tracked\nconst t = 1;\n',
      'utf-8',
    );
    appendFileSync(
      path.join(dir, 'src', 'services', 'payments.ts'),
      [
        '',
        '// yg-suppress(ghost-renamed-aspect) refers to a deleted aspect',
        '// yg-suppress(*) blanket bypass',
        '// yg-suppress-disable(no-todo-comments) open block never closed',
        '',
      ].join('\n'),
      'utf-8',
    );
    gitInit(dir);

    const res = spawnSync('node', [BIN_PATH, 'suppressions'], { cwd: dir, encoding: 'utf-8' });
    const all = (res.stdout ?? '') + (res.stderr ?? '');

    expect(res.status).toBe(0); // "Exit 0."
    expect(all).toContain('src/services/orders.ts');
    expect(all).toContain('src/services/payments.ts');
    // the three documented warning kinds
    expect(all).toContain('Unknown aspect id "ghost-renamed-aspect"');
    expect(all).toContain('Wildcard suppression "*"');
    expect(all).toContain('Unbounded yg-suppress-disable("no-todo-comments")');
  });

  it('a tree with no markers prints the no-markers line and exits 0', () => {
    const dir = freshDir('e2e-clean');
    cpSync(FIXTURE, dir, { recursive: true });
    gitInit(dir);
    const res = spawnSync('node', [BIN_PATH, 'suppressions'], { cwd: dir, encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect((res.stdout ?? '') + (res.stderr ?? '')).toContain('No active suppression markers found.');
  });
});

// ===========================================================================
// SPEC §"Effect on approve" — the inventory render is purely a mirror of
//   markers; it does NOT enforce the documented "must carry a reason" rule.
//   We pin the OBSERVED inventory behavior (empty reason is listed, not
//   flagged) and separately record the spec gap in suspectedBugs.
// ===========================================================================

describe('spec note: the inventory scanner does not enforce the reason requirement', () => {
  it('scanSuppressionMarkers records an empty reason without rejecting it (scanner is non-validating)', () => {
    // Only collectSuppressions (the parse/approve path) throws on a missing
    // reason. The inventory scanner lists the marker with reason: ''.
    const markers = scanSuppressionMarkers('// yg-suppress(rule-a)');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ aspectId: 'rule-a', kind: 'single', reason: '' });
  });

  it('runSuppressionsScan emits NO "missing reason" warning for an empty-reason marker', async () => {
    const root = freshDir('noreason');
    write(root, 'r.ts', '// yg-suppress(known)\nx();\n');
    const report = await runSuppressionsScan(root, ['r.ts'], new Set(['known']));
    // The three documented warning kinds are unknown-id / wildcard / unbounded.
    // None of them is "missing reason", so the inventory stays silent on it.
    expect(report.warnings.some(w => /reason/i.test(w))).toBe(false);
    expect(report.totalMarkers).toBe(1);
  });
});

// ===========================================================================
// formatSuppressionsOutput — documented rendering of the inventory.
// ===========================================================================

describe('spec: inventory rendering (formatSuppressionsOutput)', () => {
  it('marks a wildcard entry with a [wildcard] tag', () => {
    const out = formatSuppressionsOutput({
      fileEntries: [{ file: 'a.ts', markers: [{ line: 1, aspectId: '*', kind: 'single', wildcard: true, reason: 'r' }] }],
      totalMarkers: 1,
      warnings: [],
    });
    expect(out).toContain('[wildcard]');
    expect(out).toContain('single(*)');
  });

  it('singular tally wording for exactly one marker / one file', () => {
    const out = formatSuppressionsOutput({
      fileEntries: [{ file: 'a.ts', markers: [{ line: 1, aspectId: 'x', kind: 'single', wildcard: false, reason: 'r' }] }],
      totalMarkers: 1,
      warnings: [],
    });
    expect(out).toContain('1 marker across 1 file.');
  });
});
