/**
 * Bounty 4 — SPEC-CONFORMANCE suite for `yg knowledge read writing-deterministic-aspects`.
 *
 * The doc is the authority. Each test below pins one concrete, documented
 * invariant of the deterministic-aspect runtime contract against the REAL code:
 *   - the single-file runner   (src/ast/runner.ts)
 *   - the graph-aware runner   (src/structure/runner.ts)
 *   - the minimal helper API   (src/ast: walk, closest, report, inFile, findComments)
 *   - the ctx surface          (src/structure/ctx-*.ts)
 *
 * Conventions copied from tests/unit/structure/runner.test.ts and
 * tests/integration/ast-runner.test.ts: hermetic mkdtemp fixtures, no network,
 * no LLM, no wall-clock reads in assertions, temp dirs removed in afterEach.
 *
 * Where a documented invariant DOES NOT hold against the code, the offending
 * assertion is removed (recorded in the bounty's suspectedBugs) so this saved
 * file stays 100% green.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import { runAstAspect } from '../../../src/ast/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { walk, closest } from '../../../src/ast/walk.js';
import { report } from '../../../src/ast/report.js';
import { inFile } from '../../../src/ast/file-path.js';
import { findComments } from '../../../src/ast/find-comments.js';
import { withParsedFile } from '../../../src/ast/parser.js';

let projectRoot: string;
let cbCounter = 0;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-'));
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;\n');
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Write a graph-aware aspect check.mjs and return its absolute dir. */
function writeAspect(aspectId: string, checkBody: string): string {
  cbCounter += 1;
  const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
  return aspectDir;
}

function run(aspectId: string, nodePath: string, graph: ReturnType<typeof buildTestGraphForStructure>) {
  return runStructureAspect({
    aspectDir: path.join('.yggdrasil/aspects', aspectId),
    aspectId,
    unit: { kind: 'node', nodePath },
    graph,
    projectRoot,
  });
}

const oneNode = (mapping = ['src/a.ts']) =>
  buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping }] });

// ===========================================================================
// SECTION 1 — Runtime contract: named export `check`, single arg, synchronous.
//   Doc: "Named export `check`, synchronous. No `async`, no `Promise`."
//   Doc: "'check' must accept exactly 1 parameter (ctx)".
// ===========================================================================

describe('contract: named export `check`', () => {
  it('graph runner: missing named export -> STRUCTURE_CHECK_NOT_EXPORTED', async () => {
    writeAspect('s-noexport', `export const notCheck = 1;`);
    await expect(run('s-noexport', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_NOT_EXPORTED/);
  });

  it('graph runner: default-export `check` is rejected (named required) -> STRUCTURE_CHECK_DEFAULT_EXPORT', async () => {
    cbCounter += 1;
    const dir = path.join(projectRoot, '.yggdrasil', 'aspects', 's-default');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), `// cb=${cbCounter}\nexport default function check(ctx) { return []; }`);
    await expect(run('s-default', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_DEFAULT_EXPORT/);
  });

  it('graph runner: `check` exported but not a function -> STRUCTURE_CHECK_NOT_FUNCTION', async () => {
    writeAspect('s-notfn', `export const check = 42;`);
    await expect(run('s-notfn', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_NOT_FUNCTION/);
  });

  it('single-file runner: default-export `check` is rejected -> AST_CHECK_DEFAULT_EXPORT', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-ast-'));
    try {
      writeFileSync(path.join(dir, 'check.mjs'), 'export default function check(ctx) { return []; }');
      const f = path.join(dir, 'x.ts');
      writeFileSync(f, 'const x = 1;\n');
      await expect(
        runAstAspect({ aspectDir: dir, aspectId: 'ast-default', files: [{ path: f }], projectRoot: '/' }),
      ).rejects.toMatchObject({ code: 'AST_CHECK_DEFAULT_EXPORT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('contract: `check` arity is EXACTLY 1', () => {
  it('graph runner: arity 2 -> STRUCTURE_CHECK_WRONG_ARITY', async () => {
    writeAspect('s-arity2', `export function check(ctx, extra) { return []; }`);
    await expect(run('s-arity2', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_WRONG_ARITY/);
  });

  it('graph runner: arity 0 -> STRUCTURE_CHECK_WRONG_ARITY', async () => {
    writeAspect('s-arity0', `export function check() { return []; }`);
    await expect(run('s-arity0', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_WRONG_ARITY/);
  });

  it('graph runner: arity exactly 1 is accepted', async () => {
    writeAspect('s-arity1', `export function check(ctx) { return []; }`);
    const r = await run('s-arity1', 'N', oneNode());
    expect(r.succeeded).toBe(true);
  });

  it('single-file runner: arity 2 -> AST_CHECK_WRONG_ARITY', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-ast-'));
    try {
      writeFileSync(path.join(dir, 'check.mjs'), 'export function check(a, b) { return []; }');
      const f = path.join(dir, 'x.ts');
      writeFileSync(f, 'const x = 1;\n');
      await expect(
        runAstAspect({ aspectDir: dir, aspectId: 'ast-arity', files: [{ path: f }], projectRoot: '/' }),
      ).rejects.toMatchObject({ code: 'AST_CHECK_WRONG_ARITY' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('contract: async `check` is rejected (synchronous only)', () => {
  it('graph runner: async function -> STRUCTURE_CHECK_ASYNC', async () => {
    writeAspect('s-async', `export async function check(ctx) { return []; }`);
    await expect(run('s-async', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_ASYNC/);
  });

  it('graph runner: sync function returning a Promise -> STRUCTURE_CHECK_ASYNC', async () => {
    writeAspect('s-thenable', `export function check(ctx) { return Promise.resolve([]); }`);
    await expect(run('s-thenable', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_ASYNC/);
  });

  it('single-file runner: async function -> AST_CHECK_ASYNC', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-ast-'));
    try {
      writeFileSync(path.join(dir, 'check.mjs'), 'export async function check(ctx) { return []; }');
      const f = path.join(dir, 'x.ts');
      writeFileSync(f, 'const x = 1;\n');
      await expect(
        runAstAspect({ aspectDir: dir, aspectId: 'ast-async', files: [{ path: f }], projectRoot: '/' }),
      ).rejects.toMatchObject({ code: 'AST_CHECK_ASYNC' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// SECTION 2 — Return shape: `check` must return Violation[]; each entry an
//   object with a string `message` and optional file/line/column.
//   Doc: "Return an array of { file, line, column, message } objects".
//   Doc error code: AST_CHECK_RETURN_SHAPE / STRUCTURE_CHECK_RETURN_SHAPE.
// ===========================================================================

describe('contract: return value must be Violation[]', () => {
  it('graph runner: non-array return -> STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    writeAspect('s-nonarray', `export function check(ctx) { return 'oops'; }`);
    await expect(run('s-nonarray', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('graph runner: array element without string message -> STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    writeAspect('s-badentry', `export function check(ctx) { return [{ notMessage: 'x' }]; }`);
    await expect(run('s-badentry', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('graph runner: null array element -> STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    writeAspect('s-nullentry', `export function check(ctx) { return [null]; }`);
    await expect(run('s-nullentry', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('graph runner: empty array is a valid (passing) return', async () => {
    writeAspect('s-empty', `export function check(ctx) { return []; }`);
    const r = await run('s-empty', 'N', oneNode());
    expect(r.succeeded).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('graph runner: a well-formed violation flows through', async () => {
    writeAspect('s-ok', `export function check(ctx) { return [{ message: 'hi', file: 'src/a.ts', line: 1, column: 0 }]; }`);
    const r = await run('s-ok', 'N', oneNode());
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toBe('hi');
  });

  it('single-file runner: non-array return -> AST_CHECK_RETURN_SHAPE', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-ast-'));
    try {
      writeFileSync(path.join(dir, 'check.mjs'), 'export function check(ctx) { return 5; }');
      const f = path.join(dir, 'x.ts');
      writeFileSync(f, 'const x = 1;\n');
      await expect(
        runAstAspect({ aspectDir: dir, aspectId: 'ast-shape', files: [{ path: f }], projectRoot: '/' }),
      ).rejects.toMatchObject({ code: 'AST_CHECK_RETURN_SHAPE' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// SECTION 3 — ctx.files surface (graph-aware): array of { path, content, ast }.
//   Doc: "ctx.files — array of { path, content, ast }".
//   Doc: "A graph-level violation (no file) is allowed".
// ===========================================================================

describe('ctx surface: ctx.files carry { path, content, ast }', () => {
  it('ctx.files element has path and content for the own mapping', async () => {
    writeAspect('s-files', `export function check(ctx) {
      const f = ctx.files[0];
      return [{ message: JSON.stringify({ path: f.path, hasContent: typeof f.content === 'string', content: f.content }) }];
    }`);
    const r = await run('s-files', 'N', oneNode());
    const payload = JSON.parse(r.violations[0].message);
    expect(payload.path).toBe('src/a.ts');
    expect(payload.hasContent).toBe(true);
    expect(payload.content).toBe('export const x = 1;\n');
  });

  it('ctx.files === ctx.node.files (documented alias)', async () => {
    writeAspect('s-alias', `export function check(ctx) {
      return [{ message: String(ctx.files === ctx.node.files) }];
    }`);
    const r = await run('s-alias', 'N', oneNode());
    expect(r.violations[0].message).toBe('true');
  });

  it('a parseable own file (.ts) has a tree-sitter ast reachable via file.ast.rootNode', async () => {
    writeAspect('s-ast', `export function check(ctx) {
      const f = ctx.files[0];
      const hasAst = f.ast != null && f.ast.rootNode != null;
      return [{ message: 'rootType=' + (hasAst ? f.ast.rootNode.type : 'NONE') }];
    }`);
    const r = await run('s-ast', 'N', oneNode());
    expect(r.violations[0].message).toBe('rootType=program');
  });
});

// ===========================================================================
// SECTION 4 — file.ast is undefined for non-parseable files; guard before use.
//   Doc: "For those files file.ast is undefined. Always guard before touching
//         file.ast".
// ===========================================================================

describe('ctx surface: file.ast === undefined for non-parseable mapped files', () => {
  it('a .md file in the mapping arrives with file.ast undefined', async () => {
    writeFileSync(path.join(projectRoot, 'src/readme.md'), '# hello\n');
    writeAspect('s-md', `export function check(ctx) {
      const md = ctx.files.find(f => f.path.endsWith('.md'));
      return [{ message: 'mdAst=' + (md ? String(md.ast) : 'NO_MD_FILE') }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/readme.md'] }],
    });
    const r = await run('s-md', 'N', g);
    expect(r.violations[0].message).toBe('mdAst=undefined');
  });

  it('a .sh file in the mapping arrives with file.ast undefined (content still present)', async () => {
    writeFileSync(path.join(projectRoot, 'src/run.sh'), 'echo hi\n');
    writeAspect('s-sh', `export function check(ctx) {
      const sh = ctx.files.find(f => f.path.endsWith('.sh'));
      return [{ message: 'astUndef=' + (sh.ast === undefined) + ',content=' + JSON.stringify(sh.content) }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/run.sh'] }],
    });
    const r = await run('s-sh', 'N', g);
    expect(r.violations[0].message).toBe('astUndef=true,content="echo hi\\n"');
  });
});

// ===========================================================================
// SECTION 5 — File-not-in-context boundary.
//   Doc (single-file): AST_CHECK_FILE_NOT_IN_CONTEXT when check touches a file
//     not in ctx.files.
//   Doc (graph-aware): a violation referencing a file outside ctx is an error.
// ===========================================================================

describe('contract: violation file must be in context', () => {
  it('graph runner: violation file outside own-mapping/touched -> STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT', async () => {
    writeAspect('s-fnic', `export function check(ctx) {
      return [{ message: 'x', file: 'src/not-tracked.ts', line: 1, column: 0 }];
    }`);
    await expect(run('s-fnic', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT/);
  });

  it('graph runner: a file-less (graph-level) violation is permitted', async () => {
    writeAspect('s-graphlevel', `export function check(ctx) { return [{ message: 'graph-level' }]; }`);
    const r = await run('s-graphlevel', 'N', oneNode());
    expect(r.violations[0].message).toBe('graph-level');
  });

  it('single-file runner: violation referencing an unknown file -> AST_CHECK_FILE_NOT_IN_CONTEXT', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-ast-'));
    try {
      writeFileSync(
        path.join(dir, 'check.mjs'),
        `export function check(ctx) { return [{ file: 'phantom.ts', line: 1, column: 0, message: 'x' }]; }`,
      );
      const f = path.join(dir, 'x.ts');
      writeFileSync(f, 'const x = 1;\n');
      await expect(
        runAstAspect({ aspectDir: dir, aspectId: 'ast-fnic', files: [{ path: f }], projectRoot: '/' }),
      ).rejects.toMatchObject({ code: 'AST_CHECK_FILE_NOT_IN_CONTEXT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// SECTION 6 — Allowed reads boundary (graph-aware) and its three runtime kinds.
//   Doc: structure-aspect-undeclared-fs-read / -undeclared-graph-read /
//        -parseast-not-prewarmed.
//   Doc: "Accessing anything outside this set produces..." (the table).
//   Doc: own mapping / relation targets / ancestors / descendants are inside.
// ===========================================================================

describe('allowed reads: ctx.fs boundary', () => {
  it('ctx.fs.read on a path outside the allowed set -> structure-aspect-undeclared-fs-read', async () => {
    writeFileSync(path.join(projectRoot, 'src/secret.ts'), 'export const s = 1;\n');
    writeAspect('s-fsread', `export function check(ctx) { ctx.fs.read('src/secret.ts'); return []; }`);
    const r = await run('s-fsread', 'N', oneNode());
    expect(r.succeeded).toBe(false);
    expect(r.violations[0].kind).toBe('structure-aspect-undeclared-fs-read');
  });

  it('ctx.fs.read of an own-mapping file is permitted', async () => {
    writeAspect('s-fsok', `export function check(ctx) {
      const c = ctx.fs.read('src/a.ts');
      return [{ message: 'read=' + c.length }];
    }`);
    const r = await run('s-fsok', 'N', oneNode());
    expect(r.succeeded).toBe(true);
    expect(r.violations[0].message).toBe('read=' + 'export const x = 1;\n'.length);
  });

  it('ancestor mapping files are inside the allowed set', async () => {
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/p.ts'), 'export const p = 1;\n');
    writeFileSync(path.join(projectRoot, 'src/child.ts'), 'export const c = 1;\n');
    writeAspect('s-anc', `export function check(ctx) {
      return [{ message: 'parentExists=' + ctx.fs.exists('lib/p.ts') }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'Parent', type: 'module', mapping: ['lib/p.ts'] },
        { path: 'Parent/Child', type: 'module', mapping: ['src/child.ts'], parent: 'Parent' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/s-anc'),
      aspectId: 's-anc',
      unit: { kind: 'node', nodePath: 'Parent/Child' },
      graph: g,
      projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations[0].message).toBe('parentExists=file');
  });

  it('declared relation target mapping files are inside the allowed set', async () => {
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/b.ts'), 'export const y = 2;\n');
    writeAspect('s-rel', `export function check(ctx) {
      return [{ message: 'depExists=' + ctx.fs.exists('lib/b.ts') }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['lib/b.ts'] },
      ],
    });
    const r = await run('s-rel', 'N', g);
    expect(r.succeeded).toBe(true);
    expect(r.violations[0].message).toBe('depExists=file');
  });
});

describe('allowed reads: ctx.graph boundary', () => {
  it('ctx.graph.node on an undeclared node -> structure-aspect-undeclared-graph-read', async () => {
    writeAspect('s-graphread', `export function check(ctx) { ctx.graph.node('Other'); return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'Other', type: 'module', mapping: [] },
      ],
    });
    const r = await run('s-graphread', 'N', g);
    expect(r.succeeded).toBe(false);
    expect(r.violations[0].kind).toBe('structure-aspect-undeclared-graph-read');
  });

  it('ctx.graph.children reaches own descendants without a declared relation', async () => {
    writeFileSync(path.join(projectRoot, 'src/child.ts'), 'export const c = 1;\n');
    writeAspect('s-children', `export function check(ctx) {
      const kids = ctx.graph.children(ctx.node).map(k => k.id).sort();
      return [{ message: 'children=' + kids.join(',') }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'P', type: 'module', mapping: ['src/a.ts'] },
        { path: 'P/Kid', type: 'module', mapping: ['src/child.ts'], parent: 'P' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/s-children'),
      aspectId: 's-children',
      unit: { kind: 'node', nodePath: 'P' },
      graph: g,
      projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations[0].message).toBe('children=P/Kid');
  });
});

describe('allowed reads: ctx.parseAst pre-warm boundary', () => {
  it('parseAst on a non-prewarmed file -> structure-aspect-parseast-not-prewarmed (typed violation, not a crash)', async () => {
    writeAspect('s-prewarm', `export function check(ctx) {
      ctx.parseAst({ path: 'src/not-prewarmed.ts', content: 'const x = 1;' }, 'typescript');
      return [];
    }`);
    const r = await run('s-prewarm', 'N', oneNode());
    expect(r.succeeded).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].kind).toBe('structure-aspect-parseast-not-prewarmed');
  });

  it('parseAst on a prewarmed own-mapping file returns a tree synchronously (no await)', async () => {
    writeAspect('s-parseok', `export function check(ctx) {
      const f = ctx.files[0];
      const tree = ctx.parseAst(f, 'typescript');
      const isThenable = tree != null && typeof tree.then === 'function';
      return [{ message: 'thenable=' + isThenable + ',root=' + (tree && tree.rootNode ? tree.rootNode.type : 'NONE') }];
    }`);
    const r = await run('s-parseok', 'N', oneNode());
    expect(r.succeeded).toBe(true);
    expect(r.violations[0].message).toBe('thenable=false,root=program');
  });
});

// ===========================================================================
// SECTION 7 — Reserved violation kinds.
//   Doc: "The structure-aspect-* prefix is reserved for runtime-emitted
//         violations." (these are the kinds the runtime emits).
// ===========================================================================

describe('reserved kinds: runtime emits the documented structure-aspect-* kinds', () => {
  it('the three documented runtime kinds all begin with structure-aspect-', async () => {
    // Drive each of the three runtime emissions and confirm their kind prefix.
    writeFileSync(path.join(projectRoot, 'src/secret.ts'), 'export const s = 1;\n');
    writeAspect('k-fs', `export function check(ctx) { ctx.fs.read('src/secret.ts'); return []; }`);
    const fsR = await run('k-fs', 'N', oneNode());

    writeAspect('k-graph', `export function check(ctx) { ctx.graph.node('Other'); return []; }`);
    const gGraph = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'Other', type: 'module', mapping: [] },
      ],
    });
    const graphR = await run('k-graph', 'N', gGraph);

    writeAspect('k-prewarm', `export function check(ctx) {
      ctx.parseAst({ path: 'src/nope.ts', content: 'const y = 2;' }, 'typescript'); return [];
    }`);
    const prewarmR = await run('k-prewarm', 'N', oneNode());

    for (const r of [fsR, graphR, prewarmR]) {
      expect(r.succeeded).toBe(false);
      expect(r.violations[0].kind?.startsWith('structure-aspect-')).toBe(true);
    }
  });
});

// ===========================================================================
// SECTION 8 — Minimal helper API semantics.
//   walk(node, visitor): DFS; visitor returning false skips descent.
//   closest(node, types): nearest ancestor whose type ∈ types, else null.
//   report(file, node, message): { file, line (1-based), column (0-based), message }.
//   inFile(file, { glob | regex | contains }).
// ===========================================================================

describe('helper: report() — line 1-based, column 0-based', () => {
  it('maps node.startPosition (row 0-based) to line+1 and column unchanged', async () => {
    // Parse a real TS file; pick a node at a known position. Row 0 col 0 root.
    await withParsedFile('x.ts', '  const y = 1;\n', (tree) => {
      const root = tree.rootNode;
      const v = report({ path: 'x.ts', content: '', ast: tree }, root, 'msg');
      expect(v.file).toBe('x.ts');
      expect(v.message).toBe('msg');
      // root starts at row 0; report() must report line 1.
      expect(v.line).toBe(root.startPosition.row + 1);
      expect(v.line).toBe(1);
      // column passes through 0-based.
      expect(v.column).toBe(root.startPosition.column);
    });
  });

  it('a node indented from column 0 reports its 0-based column verbatim', async () => {
    const src = 'const a = 1;\n    const b = 2;\n';
    await withParsedFile('y.ts', src, (tree) => {
      // Find the second statement (the indented one) via walk.
      let indented: import('web-tree-sitter').Node | null = null;
      walk(tree.rootNode, (n) => {
        if (n.type === 'lexical_declaration' && n.startPosition.row === 1) indented = n;
      });
      expect(indented).not.toBeNull();
      const node = indented as unknown as import('web-tree-sitter').Node;
      const v = report({ path: 'y.ts', content: src, ast: tree }, node, 'm');
      expect(v.line).toBe(2); // row 1 -> line 2
      expect(v.column).toBe(4); // 4 spaces of indent, 0-based
    });
  });
});

describe('helper: walk() — DFS; returning false prunes the subtree', () => {
  it('visits every node when the visitor never returns false', async () => {
    await withParsedFile('w.ts', 'const a = 1;\n', (tree) => {
      let count = 0;
      walk(tree.rootNode, () => {
        count += 1;
      });
      expect(count).toBeGreaterThan(1); // program + descendants
    });
  });

  it('returning false from the visitor skips descent into that subtree', async () => {
    await withParsedFile('w2.ts', 'function f() { const inner = 1; }\n', (tree) => {
      const visitedTypes: string[] = [];
      walk(tree.rootNode, (n) => {
        visitedTypes.push(n.type);
        // Prune the function body — its descendants must NOT be visited.
        if (n.type === 'statement_block') return false;
      });
      expect(visitedTypes).toContain('statement_block');
      // The lexical_declaration inside the pruned statement_block must be absent.
      expect(visitedTypes).not.toContain('lexical_declaration');
    });
  });

  it('the root node itself is always visited (visited first)', async () => {
    await withParsedFile('w3.ts', 'const z = 9;\n', (tree) => {
      const order: string[] = [];
      walk(tree.rootNode, (n) => {
        order.push(n.type);
      });
      expect(order[0]).toBe('program');
    });
  });
});

describe('helper: closest() — nearest ancestor of a given type, else null', () => {
  it('finds the nearest enclosing ancestor matching one of the requested types', async () => {
    const src = 'function f() { const x = 1; }\n';
    await withParsedFile('c.ts', src, (tree) => {
      // Locate the identifier `x` deep inside, then climb to the function.
      let id: import('web-tree-sitter').Node | null = null;
      walk(tree.rootNode, (n) => {
        if (n.type === 'identifier' && n.text === 'x') id = n;
      });
      expect(id).not.toBeNull();
      const found = closest(id as unknown as import('web-tree-sitter').Node, ['function_declaration']);
      expect(found).not.toBeNull();
      expect(found?.type).toBe('function_declaration');
    });
  });

  it('returns null when no ancestor matches', async () => {
    await withParsedFile('c2.ts', 'const q = 1;\n', (tree) => {
      let id: import('web-tree-sitter').Node | null = null;
      walk(tree.rootNode, (n) => {
        if (n.type === 'identifier' && n.text === 'q') id = n;
      });
      const found = closest(id as unknown as import('web-tree-sitter').Node, ['class_declaration']);
      expect(found).toBeNull();
    });
  });

  it('does NOT match the node itself — only proper ancestors', async () => {
    await withParsedFile('c3.ts', 'const r = 1;\n', (tree) => {
      // The root `program` node: asking for its own type must climb past it (no parent matches).
      const found = closest(tree.rootNode, ['program']);
      expect(found).toBeNull();
    });
  });
});

describe('helper: inFile() — discriminated path filter', () => {
  const f = (p: string) => ({ path: p, content: '', ast: undefined as unknown } as any);

  it('{ glob } uses segment-aware glob ( * within a segment, ** across )', () => {
    expect(inFile(f('src/api/handler.ts'), { glob: 'src/api/**' })).toBe(true);
    expect(inFile(f('src/db/client.ts'), { glob: 'src/api/**' })).toBe(false);
    // single * does not cross a path separator
    expect(inFile(f('src/api/handler.ts'), { glob: 'src/*' })).toBe(false);
    expect(inFile(f('src/api'), { glob: 'src/*' })).toBe(true);
  });

  it('{ regex } tests the path against the supplied RegExp', () => {
    expect(inFile(f('src/components/Button.tsx'), { regex: /\.tsx$/ })).toBe(true);
    expect(inFile(f('src/components/Button.ts'), { regex: /\.tsx$/ })).toBe(false);
  });

  it('{ contains } is a plain substring test on the path', () => {
    expect(inFile(f('src/ui/legacy/x.ts'), { contains: 'legacy' })).toBe(true);
    expect(inFile(f('src/ui/modern/x.ts'), { contains: 'legacy' })).toBe(false);
  });
});

describe('helper: findComments() — comment nodes within a file/subtree', () => {
  it('finds line and block comments in a SourceFile (language derived from path)', async () => {
    const src = '// hi\nconst a = 1; /* blk */\n';
    await withParsedFile('cm.ts', src, (tree) => {
      const comments = findComments({ path: 'cm.ts', ast: tree });
      const texts = comments.map((c) => c.text).sort();
      expect(texts).toContain('// hi');
      expect(texts).toContain('/* blk */');
    });
  });

  it('explicit { ast, language } form works without a path', async () => {
    await withParsedFile('cm2.ts', '// only\nconst b = 2;\n', (tree) => {
      const comments = findComments({ ast: tree, language: 'typescript' });
      expect(comments.map((c) => c.text)).toContain('// only');
    });
  });
});

// ===========================================================================
// SECTION 9 — Cookbook fidelity: documented cookbook patterns actually run.
//   Cookbook 3 (child-type composition) — uses ctx.graph.children, returns a
//   bare graph-level violation. We exercise the exact documented mechanic.
// ===========================================================================

describe('cookbook: child-type composition via ctx.graph.children', () => {
  it('flags a child whose type differs from the expected component type', async () => {
    writeFileSync(path.join(projectRoot, 'src/comp.ts'), 'export const c = 1;\n');
    writeFileSync(path.join(projectRoot, 'src/bad.ts'), 'export const b = 1;\n');
    writeAspect('cb-compose', `export function check(ctx) {
      const violations = [];
      for (const child of ctx.graph.children(ctx.node)) {
        if (child.type !== 'engine-component') {
          violations.push({ message: "child '" + child.id + "' is '" + child.type + "', expected 'engine-component'." });
        }
      }
      return violations;
    }`);
    const g = buildTestGraphForStructure({
      types: [
        { id: 'engine' },
        { id: 'engine-component' },
        { id: 'module' },
      ],
      nodes: [
        { path: 'E', type: 'engine', mapping: ['src/a.ts'] },
        { path: 'E/Good', type: 'engine-component', mapping: ['src/comp.ts'], parent: 'E' },
        { path: 'E/Bad', type: 'module', mapping: ['src/bad.ts'], parent: 'E' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/cb-compose'),
      aspectId: 'cb-compose',
      unit: { kind: 'node', nodePath: 'E' },
      graph: g,
      projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toContain("'E/Bad'");
  });
});

// ===========================================================================
// SECTION 10 — Touched files are recorded (drift baseline narrower than boundary).
//   Doc: "the set of files the check actually touched (read) at this run".
// ===========================================================================

describe('drift baseline: touchedFiles reflect what the check actually read', () => {
  it('own-mapping files are recorded as touched even without an explicit read', async () => {
    writeAspect('t-own', `export function check(ctx) { return []; }`);
    const r = await run('t-own', 'N', oneNode());
    expect(r.touchedFiles).toContain('src/a.ts');
  });

  it('a relation target file is only recorded as touched when the check reads it', async () => {
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/b.ts'), 'export const y = 2;\n');
    // This check does NOT read the dependency.
    writeAspect('t-norel', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['lib/b.ts'] },
      ],
    });
    const r = await run('t-norel', 'N', g);
    // Boundary would allow lib/b.ts, but it was never read -> not in touchedFiles.
    expect(r.touchedFiles).toContain('src/a.ts');
    expect(r.touchedFiles).not.toContain('lib/b.ts');
  });

  it('a file read via ctx.fs becomes a valid violation target (touched widens context)', async () => {
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/b.ts'), 'export const y = 2;\n');
    // Read the dependency through ctx.fs, THEN report a violation against it.
    // The doc says a violation may target a file "touched via ctx.fs/ctx.graph".
    writeAspect('t-fsviol', `export function check(ctx) {
      ctx.fs.read('lib/b.ts');
      return [{ message: 'flagged dep', file: 'lib/b.ts', line: 1, column: 0 }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['lib/b.ts'] },
      ],
    });
    const r = await run('t-fsviol', 'N', g);
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].file).toBe('lib/b.ts');
    expect(r.touchedFiles).toContain('lib/b.ts');
  });
});

// ===========================================================================
// SECTION 11 — Documented error conditions of the graph-aware runner.
//   STRUCTURE_NODE_MISSING — node not in graph.
//   STRUCTURE_LOADER_RESOLVE_FAILED — check.mjs absent / unresolved import.
//   STRUCTURE_CHECK_THROWN — check threw a plain exception.
// ===========================================================================

describe('error conditions: graph-aware runner', () => {
  it('unknown node path -> STRUCTURE_NODE_MISSING', async () => {
    writeAspect('e-nonode', `export function check(ctx) { return []; }`);
    await expect(run('e-nonode', 'does-not-exist', oneNode())).rejects.toThrow(/STRUCTURE_NODE_MISSING/);
  });

  it('missing check.mjs -> STRUCTURE_LOADER_RESOLVE_FAILED', async () => {
    cbCounter += 1;
    const dir = path.join(projectRoot, '.yggdrasil', 'aspects', 'e-noload');
    mkdirSync(dir, { recursive: true }); // dir exists, but no check.mjs inside
    await expect(run('e-noload', 'N', oneNode())).rejects.toThrow(/STRUCTURE_LOADER_RESOLVE_FAILED/);
  });

  it('check throwing a plain exception -> STRUCTURE_CHECK_THROWN', async () => {
    writeAspect('e-throw', `export function check(ctx) { throw new Error('boom'); }`);
    await expect(run('e-throw', 'N', oneNode())).rejects.toThrow(/STRUCTURE_CHECK_THROWN/);
  });

  it('thrown StructureRunnerError carries what/why/next messageData', async () => {
    writeAspect('e-msg', `export async function check(ctx) { return []; }`);
    let caught: unknown;
    try {
      await run('e-msg', 'N', oneNode());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    const err = caught as StructureRunnerError;
    expect(typeof err.messageData.what).toBe('string');
    expect(typeof err.messageData.why).toBe('string');
    expect(typeof err.messageData.next).toBe('string');
    expect(err.messageData.what.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SECTION 12 — findComments subtree form THAT IS implemented.
//   The doc's bare-node form (findComments(node)) is NOT implemented and is
//   recorded as a bug; the explicit { rootNode, language } subtree form works
//   and is pinned here so the contract that DOES hold stays covered.
// ===========================================================================

describe('helper: findComments() subtree via { rootNode, language }', () => {
  it('returns only comments inside the given subtree, not the whole file', async () => {
    const src = '// outside\nfunction f() { /* inside */ const a = 1; }\n';
    await withParsedFile('sub.ts', src, (tree) => {
      // Locate the function's statement_block subtree.
      let block: import('web-tree-sitter').Node | null = null;
      walk(tree.rootNode, (n) => {
        if (n.type === 'statement_block') block = n;
      });
      expect(block).not.toBeNull();
      const comments = findComments({ rootNode: block as unknown as import('web-tree-sitter').Node, language: 'typescript' });
      const texts = comments.map((c) => c.text);
      expect(texts).toContain('/* inside */');
      expect(texts).not.toContain('// outside');
    });
  });
});
