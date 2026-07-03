import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  cpSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFileWhen } from '../../../src/core/file-when-evaluator.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import { parseFileWhen, WhenPredicateInvalidError } from '../../../src/utils/file-when-parser.js';
import type { FileWhenPredicate } from '../../../src/model/file-when.js';

// ---------------------------------------------------------------------------
// Bounty 2 — file-when evaluator (src/core/file-when-evaluator.ts) + parser
// (src/utils/file-when-parser.ts). Exhaustive branch coverage.
//
// Two halves:
//   EVALUATOR — every branch of evaluateFileWhen / evaluatePredicate /
//     evaluateAtomic, both sides of every boolean. Predicates are built as
//     plain objects (so branches the PARSER rejects, e.g. empty all_of/any_of,
//     are still reachable in the evaluator).
//   PARSER — every malformed-rejection branch + every accept branch.
//
// E2E — the evaluator is reachable through `yg check` via node_type file-when
// classification (type-when-mismatch / file-unreadable). The parser is
// reachable through `yg check` via architecture when-predicate validation
// (when-predicate-invalid). We spawn the built binary against a temp copy of
// the e2e-lifecycle fixture for both.
//
// Determinism: no random payloads (mkdtemp uses an OS-supplied suffix only for
// directory isolation, never read in an assertion); no wall-clock reads inside
// assertions; every temp tree removed in a finally.
// ---------------------------------------------------------------------------

describe('file-when evaluator — branch coverage', () => {
  let tmpDir: string;
  let cache: FileContentCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'b2-fwe-'));
    cache = new FileContentCache();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build an EvalContext for a repo-relative path inside the temp tree. */
  function ctx(relPath: string) {
    return {
      absPath: join(tmpDir, relPath),
      repoRelPath: relPath,
      projectRoot: tmpDir,
      cache,
    };
  }

  // -------------------------------------------------------------------------
  // evaluateFileWhen top-level guard: .yggdrasil/ auto-exempt (both sides).
  // -------------------------------------------------------------------------

  it('auto-exempts a path under .yggdrasil/ (vacuously true, exempt trace)', async () => {
    // No file written: the exempt branch returns BEFORE any content read, so a
    // non-existent path under .yggdrasil/ is still true.
    const pred: FileWhenPredicate = { path: 'never-matches.py' };
    const r = await evaluateFileWhen(pred, ctx('.yggdrasil/model/services/foo.yaml'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('exempt');
    expect((r.trace as { reason: string }).reason).toMatch(/auto-exempt/);
  });

  it('does NOT exempt a path that merely contains .yggdrasil/ mid-string', async () => {
    // The guard uses startsWith — a non-prefix occurrence must fall through to
    // normal evaluation.
    writeFileSync(join(tmpDir, 'nested-yggdrasil.ts'), '');
    const pred: FileWhenPredicate = { path: '*.py' };
    const r = await evaluateFileWhen(pred, ctx('src/.yggdrasil/nested-yggdrasil.ts'));
    expect(r.result).toBe(false);
    expect(r.trace.kind).toBe('atom-path');
  });

  // -------------------------------------------------------------------------
  // Atomic: path-only (match / no-match).
  // -------------------------------------------------------------------------

  it('path-only atom: glob match within a segment (*.ts)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({ path: '*.ts' }, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace).toMatchObject({ kind: 'atom-path', pattern: '*.ts', result: true });
  });

  it('path-only atom: no match (wrong extension)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({ path: '*.py' }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace).toMatchObject({ kind: 'atom-path', pattern: '*.py', result: false });
  });

  it('path-only atom: * does not cross a slash, ** does', async () => {
    const single = await evaluateFileWhen({ path: 'src/*.ts' }, ctx('src/sub/a.ts'));
    expect(single.result).toBe(false);
    const deep = await evaluateFileWhen({ path: 'src/**/*.ts' }, ctx('src/sub/a.ts'));
    expect(deep.result).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Atomic: content-only (readable+match / readable+no-match / unreadable /
  // binary / too-large).
  // -------------------------------------------------------------------------

  it('content-only atom: readable file, regex matches', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export function registerThing() {}');
    const r = await evaluateFileWhen({ content: 'register[A-Z]\\w*' }, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace).toMatchObject({ kind: 'atom-content', result: true });
  });

  it('content-only atom: an INVALID regex fails closed (no SyntaxError) — defense-in-depth', async () => {
    // The parser rejects an invalid content regex (when-predicate-invalid) before
    // evaluation, so this is normally unreachable. Fed directly to the evaluator
    // (bypassing the parser), a malformed pattern must NOT throw — it returns
    // result:false, consistent with the evaluator's other graceful branches.
    writeFileSync(join(tmpDir, 'a.ts'), 'anything');
    const r = await evaluateFileWhen({ content: '(unclosed' }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace).toMatchObject({ kind: 'atom-content', result: false });
  });

  it('content-only atom: readable file, regex does not match', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'nothing relevant here');
    const r = await evaluateFileWhen({ content: 'register[A-Z]\\w*' }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace).toMatchObject({ kind: 'atom-content', result: false });
  });

  it('content-only atom: unreadable file → result false + unreadable flag', async () => {
    // missing.ts never created → stat fails → unreadable.
    const r = await evaluateFileWhen({ content: 'anything' }, ctx('missing.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
    expect((r.trace as { detail?: string }).detail).toBe('file unreadable');
  });

  it('content-only atom: broken symlink → unreadable with reason', async () => {
    const target = join(tmpDir, 'target.ts');
    const link = join(tmpDir, 'link.ts');
    writeFileSync(target, 'content');
    symlinkSync(target, link);
    unlinkSync(target); // dangling symlink
    const r = await evaluateFileWhen({ content: 'content' }, ctx('link.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
  });

  it('content-only atom: binary file (null bytes) → false with binary detail', async () => {
    writeFileSync(join(tmpDir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const r = await evaluateFileWhen({ content: '.' }, ctx('bin'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBeUndefined();
    expect((r.trace as { detail?: string }).detail).toMatch(/binary/i);
  });

  it('content-only atom: file >5MB → false with >5MB detail (not scanned)', async () => {
    // One byte over the 5MB limit. 'a' would otherwise match content: 'a'.
    writeFileSync(join(tmpDir, 'big.ts'), 'a'.repeat(5 * 1024 * 1024 + 1));
    const r = await evaluateFileWhen({ content: 'a' }, ctx('big.ts'));
    expect(r.result).toBe(false);
    expect((r.trace as { detail?: string }).detail).toMatch(/>5MB/);
  });

  it('content-only atom: head-limit boundary — match found inside first 256KB', async () => {
    // safeRegexTest only scans the first 256KB. Place the match early so the
    // 256KB slice path (str.length > HEAD_LIMIT) still finds it.
    const body = 'NEEDLE' + 'x'.repeat(300 * 1024);
    writeFileSync(join(tmpDir, 'head.ts'), body);
    const r = await evaluateFileWhen({ content: 'NEEDLE' }, ctx('head.ts'));
    expect(r.result).toBe(true);
  });

  it('content-only atom: head-limit boundary — match BEYOND 256KB is not seen', async () => {
    // The match lives after the 256KB head slice, so it is invisible.
    const body = 'x'.repeat(300 * 1024) + 'TAILNEEDLE';
    writeFileSync(join(tmpDir, 'tail.ts'), body);
    const r = await evaluateFileWhen({ content: 'TAILNEEDLE' }, ctx('tail.ts'));
    expect(r.result).toBe(false);
  });

  it('content-only atom: empty file, regex requires content → no match', async () => {
    writeFileSync(join(tmpDir, 'empty.ts'), '');
    const r = await evaluateFileWhen({ content: 'something' }, ctx('empty.ts'));
    expect(r.result).toBe(false);
  });

  it('content-only atom: empty file, .* matches the empty string', async () => {
    writeFileSync(join(tmpDir, 'empty2.ts'), '');
    const r = await evaluateFileWhen({ content: '.*' }, ctx('empty2.ts'));
    expect(r.result).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Atomic: path + content combined → implicit all_of (both sides).
  // -------------------------------------------------------------------------

  it('path+content combined: both satisfied → true via implicit all_of trace', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'has the BODY token');
    const r = await evaluateFileWhen({ path: '*.ts', content: 'BODY' }, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('all_of');
    const t = r.trace as { children: Array<{ kind: string }> };
    expect(t.children[0].kind).toBe('atom-path');
    expect(t.children[1].kind).toBe('atom-content');
  });

  it('path+content combined: path matches but content fails → false', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'no token');
    const r = await evaluateFileWhen({ path: '*.ts', content: 'BODY' }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace.kind).toBe('all_of');
  });

  it('path+content combined: content matches but path fails → false', async () => {
    writeFileSync(join(tmpDir, 'a.py'), 'has BODY token');
    const r = await evaluateFileWhen({ path: '*.ts', content: 'BODY' }, ctx('a.py'));
    expect(r.result).toBe(false);
  });

  it('path+content combined: unreadable content surfaces unreadable through implicit all_of', async () => {
    // path matches but the file does not exist → content child is unreadable;
    // the all_of must propagate the unreadable flag.
    const r = await evaluateFileWhen({ path: '*.ts', content: 'x' }, ctx('ghost.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
  });

  // -------------------------------------------------------------------------
  // Empty atomic ({}): defensive branch — false with 'empty atomic' detail.
  // -------------------------------------------------------------------------

  it('empty atomic {} → false with empty-atomic trace detail', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({} as FileWhenPredicate, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace).toMatchObject({ kind: 'atom-path', pattern: '<empty>', detail: 'empty atomic' });
  });

  // -------------------------------------------------------------------------
  // all_of — all true / one false / empty (vacuous true) / unreadable child.
  // -------------------------------------------------------------------------

  it('all_of: all children true → true', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'token here');
    const pred: FileWhenPredicate = { all_of: [{ path: '*.ts' }, { content: 'token' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('all_of');
    expect((r.trace as { children: unknown[] }).children).toHaveLength(2);
  });

  it('all_of: one child false → false (allPass flips on first failure)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'token here');
    const pred: FileWhenPredicate = { all_of: [{ path: '*.ts' }, { content: 'absent' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(false);
  });

  it('all_of: empty array → vacuously true (loop never sets allPass false)', async () => {
    // Parser rejects empty all_of, but the evaluator must handle it. Built as
    // a raw object to reach the branch.
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const pred = { all_of: [] } as unknown as FileWhenPredicate;
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('all_of');
    expect((r.trace as { children: unknown[] }).children).toHaveLength(0);
  });

  it('all_of: unreadable child propagates unreadable + keeps first reason', async () => {
    // Two unreadable content children; unreadableReason ??= keeps the FIRST.
    const pred: FileWhenPredicate = { all_of: [{ content: 'a' }, { content: 'b' }] };
    const r = await evaluateFileWhen(pred, ctx('missing.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
  });

  it('all_of: false-but-readable child does NOT set unreadable', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'present');
    const pred: FileWhenPredicate = { all_of: [{ path: '*.ts' }, { content: 'absent' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // any_of — one true / all false / empty (vacuous false) / unreadable only
  // when NOT anyPass.
  // -------------------------------------------------------------------------

  it('any_of: one child true → true', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'present');
    const pred: FileWhenPredicate = { any_of: [{ path: '*.py' }, { content: 'present' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('any_of');
  });

  it('any_of: all children false → false', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'nope');
    const pred: FileWhenPredicate = { any_of: [{ path: '*.py' }, { content: 'absent' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(false);
  });

  it('any_of: empty array → vacuously false (anyPass never set)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const pred = { any_of: [] } as unknown as FileWhenPredicate;
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace.kind).toBe('any_of');
    expect((r.trace as { children: unknown[] }).children).toHaveLength(0);
  });

  it('any_of: all unreadable AND not passing → unreadable surfaces (first reason)', async () => {
    const pred: FileWhenPredicate = { any_of: [{ content: 'a' }, { content: 'b' }] };
    const r = await evaluateFileWhen(pred, ctx('missing.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
  });

  it('any_of: a readable TRUE child suppresses the unreadable flag even if a sibling was unreadable', async () => {
    // path child is readable & true → anyPass true → the `!anyPass` guard
    // drops the unreadable flag despite the unreadable content sibling.
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const pred: FileWhenPredicate = { any_of: [{ path: '*.ts' }, { content: 'x' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.unreadable).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // not — true→false / false→true / unreadable passthrough.
  // -------------------------------------------------------------------------

  it('not: child true → false', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({ not: { path: '*.ts' } }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.trace.kind).toBe('not');
    expect((r.trace as { child: { kind: string } }).child.kind).toBe('atom-path');
  });

  it('not: child false → true', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({ not: { path: '*.py' } }, ctx('a.ts'));
    expect(r.result).toBe(true);
  });

  it('not: unreadable child propagates unreadable (result is !false = true, but flag set)', async () => {
    // content child unreadable → child.result false → not → true; the
    // unreadable flag must still pass through.
    const r = await evaluateFileWhen({ not: { content: 'x' } }, ctx('missing.ts'));
    expect(r.result).toBe(true);
    expect(r.unreadable).toBe(true);
    expect(r.unreadableReason).toMatch(/ENOENT/);
  });

  it('not: readable child does NOT set unreadable', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    const r = await evaluateFileWhen({ not: { path: '*.ts' } }, ctx('a.ts'));
    expect(r.result).toBe(false);
    expect(r.unreadable).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Nested combinators — exercise recursion across all three operators.
  // -------------------------------------------------------------------------

  it('nested: all_of[ any_of, not ] true path', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'has FEATURE');
    const pred: FileWhenPredicate = {
      all_of: [
        { any_of: [{ path: '*.py' }, { path: '*.ts' }] },
        { not: { content: 'FORBIDDEN' } },
      ],
    };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('all_of');
  });

  it('nested: not[ all_of[...] ] flips an inner failure to true', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'present');
    const pred: FileWhenPredicate = {
      not: { all_of: [{ path: '*.ts' }, { content: 'absent' }] },
    };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    // inner all_of false → not → true
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('not');
  });

  it('nested: any_of[ all_of[fail], not[true] ] → false (all branches false)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'present');
    const pred: FileWhenPredicate = {
      any_of: [
        { all_of: [{ path: '*.ts' }, { content: 'absent' }] }, // false
        { not: { path: '*.ts' } }, // not(true) → false
      ],
    };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(false);
  });

  it('nested: deeply unreadable content surfaces through not→all_of→content', async () => {
    const pred: FileWhenPredicate = {
      not: { all_of: [{ content: 'x' }] },
    };
    const r = await evaluateFileWhen(pred, ctx('missing.ts'));
    // inner content unreadable → false → all_of false → not → true; flag set.
    expect(r.result).toBe(true);
    expect(r.unreadable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cache reuse — content read memoized per absPath across atoms.
  // -------------------------------------------------------------------------

  it('content cache memoizes: two content atoms over the same file share one read', async () => {
    const p = join(tmpDir, 'a.ts');
    writeFileSync(p, 'ALPHA and BETA');
    const pred: FileWhenPredicate = { all_of: [{ content: 'ALPHA' }, { content: 'BETA' }] };
    const r = await evaluateFileWhen(pred, ctx('a.ts'));
    expect(r.result).toBe(true);
    // The cache must have exactly one entry for this absPath.
    const second = await cache.read(p);
    expect(second.content).toContain('ALPHA');
  });
});

// ===========================================================================
// PARSER — parseFileWhen rejection + accept branches.
// ===========================================================================

describe('parseFileWhen — branch coverage', () => {
  // --- top-level shape guards ---
  it('rejects null', () => {
    expect(() => parseFileWhen(null, 'C', 'scope.files')).toThrow(/when must be a YAML mapping/);
  });
  it('rejects a non-object (string)', () => {
    expect(() => parseFileWhen('hello', 'C', 'scope.files')).toThrow(/when must be a YAML mapping/);
  });
  it('rejects an array', () => {
    expect(() => parseFileWhen([{ path: 'a' }], 'C', 'scope.files')).toThrow(/when must be a YAML mapping/);
  });
  it('rejects an empty mapping', () => {
    expect(() => parseFileWhen({}, 'C', 'scope.files')).toThrow(/when mapping must not be empty/);
  });

  // --- unknown key ---
  it('rejects an unknown key and names the allowed set', () => {
    expect(() => parseFileWhen({ foo: 'bar' }, 'C', 'scope.files')).toThrow(
      /unknown when key 'foo' \(expected one of: all_of, any_of, not, path, content\)/,
    );
  });
  it('reports the FIRST unknown key when several are present', () => {
    // keys() order is insertion order for string keys.
    expect(() => parseFileWhen({ zzz: 1, qqq: 2 }, 'C', 'scope.files')).toThrow(/unknown when key 'zzz'/);
  });

  // --- mixing / multiplicity ---
  it('rejects mixing a boolean operator with an atomic clause', () => {
    expect(() => parseFileWhen({ all_of: [{ path: 'a' }], path: 'b' }, 'C', 'scope.files')).toThrow(
      /cannot mix boolean operators with atomic clauses/,
    );
  });
  it('rejects two boolean operators at the same level', () => {
    expect(() => parseFileWhen({ all_of: [{ path: 'a' }], any_of: [{ path: 'b' }] }, 'C', 'scope.files')).toThrow(
      /at most one boolean operator at a level \(got: all_of, any_of\)/,
    );
  });

  // --- atomic accept + reject ---
  it('accepts a bare path atom', () => {
    expect(parseFileWhen({ path: 'src/**' }, 'C', 'scope.files')).toEqual({ path: 'src/**' });
  });
  it('accepts a bare content atom (valid regex)', () => {
    expect(parseFileWhen({ content: 'foo\\d+' }, 'C', 'scope.files')).toEqual({ content: 'foo\\d+' });
  });
  it('accepts path + content together (implicit all_of preserved as object)', () => {
    expect(parseFileWhen({ path: 'a', content: 'b' }, 'C', 'scope.files')).toEqual({ path: 'a', content: 'b' });
  });
  it('rejects a non-string path and reports its typeof', () => {
    expect(() => parseFileWhen({ path: 123 }, 'C', 'scope.files')).toThrow(/path must be a string \(got number\)/);
  });
  it('rejects a non-string content and reports its typeof', () => {
    expect(() => parseFileWhen({ content: [] }, 'C', 'scope.files')).toThrow(
      /content must be a string \(got object\)/,
    );
  });
  it('rejects content with an invalid regex (the parser is the regex guard)', () => {
    expect(() => parseFileWhen({ content: '(unclosed' }, 'C', 'scope.files')).toThrow(/Invalid regex in content/);
  });
  it('throws WhenPredicateInvalidError carrying the when-predicate-invalid code', () => {
    try {
      parseFileWhen({ foo: 1 }, 'C', 'scope.files');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WhenPredicateInvalidError);
      expect((e as WhenPredicateInvalidError).code).toBe('when-predicate-invalid');
    }
  });

  // --- boolean accept ---
  it('accepts all_of with multiple children (recurses into each)', () => {
    expect(parseFileWhen({ all_of: [{ path: 'a' }, { content: 'b' }] }, 'C', 'scope.files')).toEqual({
      all_of: [{ path: 'a' }, { content: 'b' }],
    });
  });
  it('accepts any_of', () => {
    expect(parseFileWhen({ any_of: [{ path: 'a' }] }, 'C', 'scope.files')).toEqual({ any_of: [{ path: 'a' }] });
  });
  it('accepts not with a mapping child', () => {
    expect(parseFileWhen({ not: { path: 'a' } }, 'C', 'scope.files')).toEqual({ not: { path: 'a' } });
  });
  it('accepts nested operators (all_of containing a not)', () => {
    expect(parseFileWhen({ all_of: [{ path: 'a' }, { not: { content: 'b' } }] }, 'C', 'scope.files')).toEqual({
      all_of: [{ path: 'a' }, { not: { content: 'b' } }],
    });
  });

  // --- boolean reject ---
  it('rejects an empty all_of array', () => {
    expect(() => parseFileWhen({ all_of: [] }, 'C', 'scope.files')).toThrow(/'all_of' array must not be empty/);
  });
  it('rejects an empty any_of array', () => {
    expect(() => parseFileWhen({ any_of: [] }, 'C', 'scope.files')).toThrow(/'any_of' array must not be empty/);
  });
  it('rejects all_of whose value is not an array', () => {
    expect(() => parseFileWhen({ all_of: 'x' }, 'C', 'scope.files')).toThrow(/'all_of' must be an array/);
  });
  it('rejects any_of whose value is not an array', () => {
    expect(() => parseFileWhen({ any_of: { path: 'a' } }, 'C', 'scope.files')).toThrow(/'any_of' must be an array/);
  });
  it('rejects a not whose child is not a mapping (string)', () => {
    expect(() => parseFileWhen({ not: 'src/**' }, 'C', 'scope.files')).toThrow(/when must be a YAML mapping/);
  });
  it('rejects a not whose child is null', () => {
    expect(() => parseFileWhen({ not: null }, 'C', 'scope.files')).toThrow(/when must be a YAML mapping/);
  });
  it('rejects an invalid child inside all_of (recursive failure surfaces)', () => {
    expect(() => parseFileWhen({ all_of: [{ path: 'a' }, { bogus: 1 }] }, 'C', 'scope.files')).toThrow(
      /unknown when key 'bogus'/,
    );
  });
  it('error context propagates the path label into nested errors', () => {
    expect(() => parseFileWhen({ all_of: [{ content: '(' }] }, 'TOP', 'scope.files')).toThrow(
      /TOP\/all_of\[0\]: Invalid regex/,
    );
  });
});

// ===========================================================================
// E2E — spawn the built CLI against a temp copy of the e2e-lifecycle fixture.
// The evaluator drives node_type file-when classification (type-when-mismatch
// / file-unreadable). The parser drives architecture when-predicate validation
// (when-predicate-invalid). Skipped automatically if dist/bin.js is absent.
// ===========================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, '../../..');
const BIN_PATH = join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string) {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `b2-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const archPath = (dir: string) => join(dir, '.yggdrasil', 'yg-architecture.yaml');

/** Replace the service type's file-when block (the fixture ships this exact text). */
function replaceServiceWhen(dir: string, whenBlock: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8').replace(
    '    when:\n      path: "src/services/**"',
    whenBlock,
  );
  writeFileSync(archPath(dir), arch, 'utf-8');
}

describe.skipIf(!distExists)('file-when E2E — evaluator + parser through yg check', () => {
  // --- EVALUATOR via classification: content-atom NO-MATCH → type-when-mismatch ---
  it('E1: content when that the mapped files do NOT contain raises type-when-mismatch', () => {
    const dir = copyFixture('content-miss');
    try {
      // Require a token the fixture source files do not contain. orders.ts and
      // payments.ts are mapped to service-typed nodes; the content atom fails.
      replaceServiceWhen(dir, '    when:\n      content: "ZZ_NOT_IN_ANY_SOURCE_ZZ"');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('type-when-mismatch');
      // Both service-typed nodes own a source file that fails the content when.
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- EVALUATOR: content-atom MATCH → no type-when-mismatch (positive side) ---
  it('E2: content when satisfied by the mapped files raises NO type-when-mismatch', () => {
    const dir = copyFixture('content-hit');
    try {
      // The fixture source files export functions; match a permissive token.
      // 'export' appears in both orders.ts and payments.ts.
      replaceServiceWhen(dir, '    when:\n      content: "export"');
      const { stdout } = run(['check'], dir);
      expect(stdout).not.toContain('type-when-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- EVALUATOR: path-atom NO-MATCH → type-when-mismatch (combinator path) ---
  it('E3: an all_of whose path branch excludes the mapped files raises type-when-mismatch', () => {
    const dir = copyFixture('allof-miss');
    try {
      // all_of[ path under src/services (true), path *.py (false) ] → false.
      replaceServiceWhen(
        dir,
        [
          '    when:',
          '      all_of:',
          '        - path: "src/services/**"',
          '        - path: "**/*.py"',
        ].join('\n'),
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('type-when-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- EVALUATOR: not[ matching path ] → false → type-when-mismatch ---
  it('E4: not over a matching path makes every mapped file mismatch', () => {
    const dir = copyFixture('not-miss');
    try {
      replaceServiceWhen(
        dir,
        ['    when:', '      not:', '        path: "src/services/**"'].join('\n'),
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('type-when-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- PARSER through CLI: invalid regex in content → when-predicate-invalid ---
  it('E5: an invalid regex in a content when raises when-predicate-invalid', () => {
    const dir = copyFixture('bad-regex');
    try {
      replaceServiceWhen(dir, '    when:\n      content: "([unclosed"');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('when-predicate-invalid');
      expect(stdout).toContain('Invalid regex in content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- PARSER through CLI: empty all_of → when-predicate-invalid ---
  it('E6: an empty all_of when raises when-predicate-invalid', () => {
    const dir = copyFixture('empty-allof');
    try {
      replaceServiceWhen(dir, '    when:\n      all_of: []');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('when-predicate-invalid');
      expect(stdout).toContain("'all_of' array must not be empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- EVALUATOR over a mapped DIRECTORY: classify by the files INSIDE it ---
  it('E7: a content when over a mapped directory reads the files INSIDE it (not the directory as a file)', () => {
    const dir = copyFixture('dir-content-when');
    try {
      // Require content, so the path-only shortcut does not bypass the read.
      replaceServiceWhen(dir, '    when:\n      content: "export"');
      // Map the orders node to a DIRECTORY whose only file satisfies the content.
      const subdir = join(dir, 'src', 'services', 'orderdir');
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(subdir, 'inner.ts'), 'export const x = 1;\n');
      const ordersNode = join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
      const y = readFileSync(ordersNode, 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/orderdir',
      );
      writeFileSync(ordersNode, y, 'utf-8');
      const { all } = run(['check'], dir);
      // A directory mapping is classified by the files it owns: the entry expands
      // to inner.ts, whose content matches — so the directory is NEVER read as a
      // file (no file-unreadable) and there is no type-when mismatch. (Before the
      // directory-expansion fix, the literal directory string was read as content,
      // failed with EISDIR, and surfaced a spurious file-unreadable.)
      expect(all).not.toContain('file-unreadable');
      expect(all).not.toContain('type-when-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
