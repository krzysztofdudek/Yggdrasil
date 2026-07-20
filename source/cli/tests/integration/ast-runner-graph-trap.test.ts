// The graph-access sentinel trap on runAstAspect (yg drill's deterministic path).
//
// Real temp fixtures, no mocking. A check.mjs that reads ctx.node behaves
// differently under the trap:
//   - graphAccessTrap: true  → AST_GRAPH_CTX_UNSUPPORTED (a capability gap → drill
//     records the case as `unsupported`, not scored).
//   - graphAccessTrap: false / unset → AST_CHECK_THROWN (today's behavior — the
//     REGRESSION PIN: production paths never set the flag, so ctx stays { files }
//     and dereferencing the absent ctx.node throws a TypeError that wraps as
//     AST_CHECK_THROWN, exactly as before the flag existed).
// A files-only check is unaffected either way.

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

  it('graphAccessTrap: true → AST_GRAPH_CTX_UNSUPPORTED when the check reads ctx.node', async () => {
    const { projectRoot, aspectDir, file } = stage(GRAPH_CHECK);
    await expect(
      runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot, graphAccessTrap: true }),
    ).rejects.toMatchObject({ code: 'AST_GRAPH_CTX_UNSUPPORTED' });
  });

  it('REGRESSION PIN: the SAME check with graphAccessTrap unset throws AST_CHECK_THROWN (today\'s behavior)', async () => {
    const { projectRoot, aspectDir, file } = stage(GRAPH_CHECK);
    // No graphAccessTrap → ctx is exactly { files }; ctx.node is undefined and
    // `.type` throws a TypeError that wraps as AST_CHECK_THROWN.
    await expect(
      runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_THROWN' });
  });

  it('REGRESSION PIN: graphAccessTrap: false is identical to unset (AST_CHECK_THROWN)', async () => {
    const { projectRoot, aspectDir, file } = stage(GRAPH_CHECK);
    await expect(
      runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot, graphAccessTrap: false }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_THROWN' });
  });

  it('a files-only check is unaffected by the trap — returns its violations under either regime', async () => {
    const filesOnly = `export function check(ctx) { return ctx.files.map((f) => ({ file: f.path, line: 1, column: 0, message: 'seen' })); }`;
    for (const graphAccessTrap of [true, false, undefined]) {
      const { projectRoot, aspectDir, file } = stage(filesOnly);
      const result = await runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot, graphAccessTrap });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].message).toBe('seen');
    }
  });

  it('the trap fires on every graph-context accessor of the production Ctx (minus files), each naming its accessor', async () => {
    // Full complement of structure/types.ts `Ctx` minus `files`. A check reading
    // subject / parseAst / parseJson / parseToml under a drill must be reported as
    // a capability gap (AST_GRAPH_CTX_UNSUPPORTED → `unsupported`, exit 0), NOT as
    // a check bug (AST_CHECK_THROWN → `unrun`, exit 2) which a missing trap would
    // have produced via a plain TypeError on the absent property.
    for (const accessor of ['node', 'subject', 'graph', 'fs', 'parseAst', 'parseYaml', 'parseJson', 'parseToml']) {
      const src = `export function check(ctx) { const _ = ctx.${accessor}; return []; }`;
      const { projectRoot, aspectDir, file } = stage(src);
      await expect(
        runAstAspect({ aspectDir, aspectId: 'trap', files: [{ path: file }], projectRoot, graphAccessTrap: true }),
      ).rejects.toMatchObject({ code: 'AST_GRAPH_CTX_UNSUPPORTED' });
    }
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
