import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAstAspect, AstRunnerError } from '../../src/ast/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, '../..');  // source/cli/

describe('ast runner', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it('runs check.mjs and returns violations for bad file', async () => {
    const result = await runAstAspect({
      aspectDir: 'tests/fixtures/ast-aspects/async-fs',
      aspectId: 'async-fs',
      files: [{ path: 'tests/fixtures/async-fs-bad.ts' }],
      projectRoot: CWD,
    });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].message).toMatch(/readFileSync|sync/i);
  });

  it('returns empty violations for clean file', async () => {
    const result = await runAstAspect({
      aspectDir: 'tests/fixtures/ast-aspects/async-fs',
      aspectId: 'async-fs',
      files: [{ path: 'tests/fixtures/async-fs-clean.ts' }],
      projectRoot: CWD,
    });
    expect(result.violations).toEqual([]);
  });

  it('AST_CHECK_WRONG_ARITY for check(a, b)', async () => {
    // Create a temp fixture inline
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(a, b) { return []; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(runAstAspect({
      aspectDir: dir,
      aspectId: 'test',
      files: [{ path: tmpFile }],
      projectRoot: '/',
    })).rejects.toMatchObject({ code: 'AST_CHECK_WRONG_ARITY' });
  });

  it('AST_CHECK_THROWN with stack in message', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), "export function check(ctx) { throw new Error('boom'); }");
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    try {
      await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('AST_CHECK_THROWN');
      expect(e.message).toContain('boom');
    }
  });

  it('AST_CHECK_DEFAULT_EXPORT when check is default export', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export default function check(ctx) { return []; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }))
      .rejects.toMatchObject({ code: 'AST_CHECK_DEFAULT_EXPORT' });
  });

  it('suppressed violation is filtered from results', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // check.mjs: flag all call_expressions — no @chrisdudek/yg/ast import needed,
    // we use the raw tree-sitter API via ctx.files[].ast directly.
    writeFileSync(path.join(dir, 'check.mjs'), `
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of file.ast.rootNode.descendantsOfType('call_expression')) {
      violations.push({ file: file.path, line: node.startPosition.row + 1, message: 'test violation' });
    }
  }
  return violations;
}
`);
    const srcFile = path.join(dir, 'src.ts');
    // Line 1: normal call — NOT suppressed
    // Line 2: suppress marker
    // Line 3: suppressed call
    writeFileSync(srcFile, 'foo();\n// yg-suppress(test) refactor\nbar();\n');
    const result = await runAstAspect({
      aspectDir: dir,
      aspectId: 'test',
      files: [{ path: srcFile }],
      projectRoot: '/',
    });
    // bar() on line 3 should be suppressed; foo() on line 1 should not
    const lines = result.violations.map(v => v.line);
    expect(lines).toContain(1); // foo() not suppressed
    expect(lines).not.toContain(3); // bar() suppressed
  });

  it('AST_SUPPRESS_MARKER_MALFORMED when a marker is missing its required reason', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(ctx) { void ctx; return []; }');
    const srcFile = path.join(dir, 'x.ts');
    // A single-line yg-suppress marker with NO reason text after the aspect list
    // is malformed — the fault is in the subject file's marker, not check.mjs.
    writeFileSync(srcFile, '// yg-suppress(test)\nfoo();\n');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: srcFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_SUPPRESS_MARKER_MALFORMED' });
  });

  it('AST_CHECK_THROWN falls back to String(e) when check.mjs throws a non-Error value', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), "export function check(ctx) { throw 'plain-string-boom'; }");
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    try {
      await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('AST_CHECK_THROWN');
      expect(e.message).toContain('plain-string-boom');
    }
  });

  it('AST_CHECK_ASYNC when check returns a Promise', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export async function check(ctx) { return []; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_ASYNC' });
  });

  it('AST_CHECK_RETURN_SHAPE when check returns non-array', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(ctx) { return "not-an-array"; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_RETURN_SHAPE' });
  });

  it('a content-only check runs over a syntactically-broken grammar-extension file (best-effort, no abort — mirrors production)', async () => {
    // Harness/production fidelity: the production check runner (structure
    // prewarmupAstCache) parses a broken same-extension source best-effort and
    // never aborts on a parse error, so a content-only rule (one that never reads
    // file.ast — e.g. a raw-control-byte scan) runs over it. The drill/aspect-test
    // runner must behave identically; a parse-error abort used to make such a
    // fixture impossible to exercise here.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // A content-only check: flags any delivered file whose content carries the
    // marker text — it never dereferences file.ast.
    writeFileSync(
      path.join(dir, 'check.mjs'),
      'export function check(ctx) { return ctx.files.filter(f => f.content.includes("MARKER")).map(f => ({ file: f.path, line: 1, column: 0, message: "content-only rule ran" })); }',
    );
    const tmpFile = path.join(dir, 'bad.ts');
    // Syntactically invalid TypeScript (tree-sitter yields a tree with error nodes).
    writeFileSync(tmpFile, 'function )(( // MARKER\n');
    const result = await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
    // No AST_SOURCE_PARSE_ERROR abort — the content-only check ran and reported.
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ file: tmpFile, message: 'content-only rule ran' });
  });

  it('an AST-consuming check receives the same error-laden best-effort tree production hands it', async () => {
    // The faithful mirror is not "ast:undefined for a broken grammar file": an
    // AST-consuming check must get the identical tree the production structure
    // runner caches — parsed, with rootNode.hasError true. This proves the harness
    // neither aborts nor substitutes undefined, so no NEW divergence is introduced.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(
      path.join(dir, 'check.mjs'),
      'export function check(ctx) { return ctx.files.filter(f => f.ast !== undefined && f.ast.rootNode.hasError).map(f => ({ file: f.path, line: 1, column: 0, message: "best-effort tree with errors delivered" })); }',
    );
    const tmpFile = path.join(dir, 'bad.ts');
    writeFileSync(tmpFile, 'function )((\n');
    const result = await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toBe('best-effort tree with errors delivered');
  });

  it('AST_LOADER_RESOLVE_FAILED when check.mjs does not exist', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    // No check.mjs written → import() will throw ERR_MODULE_NOT_FOUND
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_LOADER_RESOLVE_FAILED' });
  });

  it('AST_CHECK_NOT_EXPORTED when check.mjs has no named check export', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export const foo = 42;');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_NOT_EXPORTED' });
  });

  it('AST_CHECK_NOT_FUNCTION when check is exported as non-function', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export const check = 42;');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_NOT_FUNCTION' });
  });

  it('delivers a non-parseable file to check() with ast undefined (content rules still run)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // A content-only check: flags any delivered file that has no AST yet whose
    // content is still readable — proving the non-parseable file reached check().
    writeFileSync(
      path.join(dir, 'check.mjs'),
      'export function check(ctx) { return ctx.files.filter(f => f.ast === undefined && f.content.includes("let x")).map(f => ({ file: f.path, line: 1, column: 0, message: "non-parseable file delivered" })); }',
    );
    const tmpFile = path.join(dir, 'data.swift'); // .swift has no registered grammar
    writeFileSync(tmpFile, 'let x = 1\n');
    const result = await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ file: tmpFile, message: 'non-parseable file delivered' });
  });

  it('re-throws raw error when check.mjs has a JS syntax error (not MODULE_NOT_FOUND)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // Invalid JS syntax — import() throws SyntaxError, not MODULE_NOT_FOUND
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check( }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toSatisfy((e: any) => !(e instanceof AstRunnerError));
  });

  it('parseCache: same file across two aspect calls is parsed only once', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // The check counts call_expressions via the cached AST — a discriminator that
    // does NOT depend on a parse-error abort (the runner now delivers a best-effort
    // tree instead of throwing, so a broken second read would no longer distinguish
    // "cache reused" from "re-parsed").
    writeFileSync(path.join(dir, 'check.mjs'), `
export function check(ctx) {
  const out = [];
  for (const f of ctx.files) {
    for (const n of f.ast.rootNode.descendantsOfType('call_expression')) {
      out.push({ file: f.path, line: n.startPosition.row + 1, message: 'call' });
    }
  }
  return out;
}
`);
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const valid = 1;'); // zero call_expressions

    const cache = new Map();
    const r1 = await runAstAspect({ aspectDir: dir, aspectId: 'a1', files: [{ path: tmpFile }], projectRoot: '/', parseCache: cache });
    expect(r1.violations).toHaveLength(0);
    expect(cache.size).toBe(1);

    // Change the file on disk to content with ONE call_expression. If the cache is
    // consulted (parse-once), the second run reuses the cached AST of `const valid
    // = 1;` and sees zero calls; if the cache were ignored, it would re-read/parse
    // `doThing();` and report one call. Zero violations proves the cache was reused.
    writeFileSync(tmpFile, 'doThing();');
    const r2 = await runAstAspect({ aspectDir: dir, aspectId: 'a2', files: [{ path: tmpFile }], projectRoot: '/', parseCache: cache });
    expect(r2.violations).toHaveLength(0); // cached AST reused → no re-parse
    expect(cache.size).toBe(1);
  });

  it('AST_CHECK_FILE_NOT_IN_CONTEXT when check.mjs returns violation for file outside ctx.files', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    // check.mjs returns a violation referencing a file that was NOT passed in ctx.files
    writeFileSync(path.join(dir, 'check.mjs'), `
export function check(ctx) {
  return [{ file: '/some/other/file.ts', line: 1, column: 0, message: 'synthetic' }];
}
`);
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_FILE_NOT_IN_CONTEXT' });
  });
});
