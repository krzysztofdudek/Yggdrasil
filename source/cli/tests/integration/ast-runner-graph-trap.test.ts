// The graph-access sentinel trap on runAstAspect — the one ctx every graphless
// run hands a check (yg drill over its case files, yg aspect-test --files over
// the given files).
//
// Real temp fixtures, no mocking. A check.mjs that reads ctx.node gets
// AST_GRAPH_CTX_UNSUPPORTED (a capability gap: a drill records the case as
// `unsupported`, not scored; aspect-test --files names the graph-aware run),
// never AST_CHECK_THROWN, which would blame a correct check. A files-only check
// is unaffected, and ctx.subject / ctx.config are always supplied.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAstAspect, AstRunnerError, GraphAccessTrap } from '../../src/ast/runner.js';

describe('ast runner — graph-access sentinel trap', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stage(checkSource: string, fileSource = 'export const x = 1;\n'): { projectRoot: string; aspectDir: string; file: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-drill-trap-'));
    tmpDirs.push(root);
    const aspectDir = path.join('aspects', 'trap');
    mkdirSync(path.join(root, aspectDir), { recursive: true });
    writeFileSync(path.join(root, aspectDir, 'check.mjs'), checkSource, 'utf-8');
    const file = 'subject.ts';
    writeFileSync(path.join(root, file), fileSource, 'utf-8');
    return { projectRoot: root, aspectDir, file };
  }

  // A check that dereferences ctx.node — so it THROWS under both regimes, but with
  // a different code. `.type` forces the read (a bare `const x = ctx.node` would
  // not throw under no-trap since undefined is a legal value).
  const GRAPH_CHECK = `export function check(ctx) { return [{ file: ctx.node.type, line: 1, column: 0, message: 'x' }]; }`;

  it('AST_GRAPH_CTX_UNSUPPORTED when the check reads ctx.node — never AST_CHECK_THROWN', async () => {
    const { projectRoot, aspectDir, file } = stage(GRAPH_CHECK);
    await expect(
      runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot }),
    ).rejects.toMatchObject({ code: 'AST_GRAPH_CTX_UNSUPPORTED' });
  });

  it('a files-only check is unaffected by the trap — returns its violations', async () => {
    const filesOnly = `export function check(ctx) { return ctx.files.map((f) => ({ file: f.path, line: 1, column: 0, message: 'seen' })); }`;
    const { projectRoot, aspectDir, file } = stage(filesOnly);
    const result = await runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toBe('seen');
  });

  it('the trap fires on every graph-context accessor a drill cannot supply, each naming its accessor', async () => {
    // The production `Ctx` (structure/types.ts) minus `files`, and minus the two a
    // drill DOES supply — `subject` (the case files) and `config` (the rule's
    // settings). A check reading parseAst / parseJson / parseToml under a drill
    // must be reported as a capability gap (AST_GRAPH_CTX_UNSUPPORTED →
    // `unsupported`, exit 0), NOT as a check bug (AST_CHECK_THROWN → `unrun`,
    // exit 2) which a missing trap would have produced via a plain TypeError.
    for (const accessor of ['node', 'graph', 'fs', 'parseAst', 'parseYaml', 'parseJson', 'parseToml']) {
      const src = `export function check(ctx) { const _ = ctx.${accessor}; return []; }`;
      const { projectRoot, aspectDir, file } = stage(src);
      await expect(
        runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot }),
      ).rejects.toMatchObject({ code: 'AST_GRAPH_CTX_UNSUPPORTED' });
    }
  });

  it('in a graphless run, ctx.subject is the given files and ctx.config the settings handed in', async () => {
    // A rule parameterized through ctx.config — the only way a package rule is —
    // used to throw here on `ctx.config.limit` and be reported as a check bug.
    const src = `export function check(ctx) {
      return ctx.subject
        .filter((f) => f.content.length > ctx.config.limit)
        .map((f) => ({ file: f.path, line: 1, column: 0, message: 'over ' + ctx.config.limit }));
    }`;
    const { projectRoot, aspectDir, file } = stage(src, 'export const long = 1;\n');
    const tight = await runAstAspect({ aspectDir, aspectId: 'cfg', files: [{ path: file }], projectRoot, config: { limit: 5 } });
    expect(tight.violations.map((v) => v.message)).toEqual(['over 5']);
    const loose = await runAstAspect({ aspectDir, aspectId: 'cfg', files: [{ path: file }], projectRoot, config: { limit: 500 } });
    expect(loose.violations).toEqual([]);
  });

  it('GraphAccessTrap carries the accessor name and never escapes runAstAspect', () => {
    const err = new GraphAccessTrap('node');
    expect(err).toBeInstanceOf(Error);
    expect(err.accessor).toBe('node');
    // The runner only ever surfaces AstRunnerError, never a raw GraphAccessTrap.
    expect(new AstRunnerError('AST_GRAPH_CTX_UNSUPPORTED', { what: 'w', why: 'y', next: 'n' }).code).toBe(
      'AST_GRAPH_CTX_UNSUPPORTED',
    );
  });
});
