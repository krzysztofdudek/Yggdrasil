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

  it('parse error node is detected and reported as AST_PARSE_ERROR', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(ctx) { return []; }');
    const tmpFile = path.join(dir, 'bad.ts');
    // Syntactically invalid TypeScript
    writeFileSync(tmpFile, 'function )((\n');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_SOURCE_PARSE_ERROR' });
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

  it('AST_SOURCE_PARSE_ERROR traverses clean nodes before finding error (findFirstErrorNode coverage)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(ctx) { return []; }');
    const tmpFile = path.join(dir, 'mixed.ts');
    // Valid statement first, then invalid — findFirstErrorNode traverses clean lexical_declaration
    writeFileSync(tmpFile, 'const x = 1;\n)((\n');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }),
    ).rejects.toMatchObject({ code: 'AST_SOURCE_PARSE_ERROR' });
  });

  it('parseCache: same file across two aspect calls is parsed only once', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-')); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'check.mjs'), `
export function check(ctx) {
  return [];
}
`);
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const valid = 1;');

    const cache = new Map();
    await runAstAspect({ aspectDir: dir, aspectId: 'a1', files: [{ path: tmpFile }], projectRoot: '/', parseCache: cache });
    expect(cache.size).toBe(1);

    // Modify the file to syntactically invalid content between calls.
    // If the cache is consulted on the second run, the call still succeeds because
    // the cached AST is reused. If the cache is ignored, the runner reads the file
    // again and surfaces AST_SOURCE_PARSE_ERROR.
    writeFileSync(tmpFile, 'const = = broken @@');
    await expect(
      runAstAspect({ aspectDir: dir, aspectId: 'a2', files: [{ path: tmpFile }], projectRoot: '/', parseCache: cache }),
    ).resolves.toMatchObject({ violations: [] });
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
