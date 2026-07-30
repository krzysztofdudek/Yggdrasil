import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runStructureAspect', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-runner-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('returns violations from check.mjs', async () => {
    await writeAspect('a1', `export function check(ctx) { return [{ message: 'hi', file: 'src/a.ts', line: 1, column: 0 }]; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a1'),
      aspectId: 'a1', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toBe('hi');
  });

  it('async check throws STRUCTURE_CHECK_ASYNC', async () => {
    await writeAspect('a2', `export async function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a2'),
      aspectId: 'a2', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_ASYNC/);
  });

  it('thrown StructureRunnerError carries structured messageData (what/why/next)', async () => {
    await writeAspect('amsgdata', `export async function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/amsgdata'),
        aspectId: 'amsgdata', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    const err = caught as StructureRunnerError;
    expect(err.code).toBe('STRUCTURE_CHECK_ASYNC');
    expect(typeof err.messageData.what).toBe('string');
    expect(typeof err.messageData.why).toBe('string');
    expect(typeof err.messageData.next).toBe('string');
    expect(err.messageData.what.length).toBeGreaterThan(0);
    // code is still present in .message so existing toThrow(/STRUCTURE_.../) assertions hold
    expect(err.message).toMatch(/STRUCTURE_CHECK_ASYNC/);
  });

  it('non-array return throws STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    await writeAspect('a3', `export function check(ctx) { return 'oops'; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a3'),
      aspectId: 'a3', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('check throws → STRUCTURE_CHECK_THROWN', async () => {
    await writeAspect('a4', `export function check(ctx) { throw new Error('boom'); }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a4'),
      aspectId: 'a4', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_THROWN/);
  });

  it('missing export → STRUCTURE_CHECK_NOT_EXPORTED', async () => {
    await writeAspect('a5', `export const notCheck = 1;`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a5'),
      aspectId: 'a5', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_NOT_EXPORTED/);
  });

  it('file-kind violation outside ctx → STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT', async () => {
    await writeAspect('a6', `export function check(ctx) {
      return [{ message: 'x', file: 'src/not-tracked.ts', line: 1, column: 0 }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a6'),
      aspectId: 'a6', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT/);
  });

  it('graph-kind violation (no file) is allowed', async () => {
    await writeAspect('a7', `export function check(ctx) { return [{ message: 'graph-level' }]; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a7'),
      aspectId: 'a7', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.violations[0].message).toBe('graph-level');
  });

  it('records touchedFiles', async () => {
    await writeAspect('a8', `export function check(ctx) { ctx.fs.exists('src/a.ts'); return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a8'),
      aspectId: 'a8', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.touchedFiles).toContain('src/a.ts');
  });

  it('missing node → STRUCTURE_NODE_MISSING', async () => {
    await writeAspect('a9', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({ nodes: [] });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a9'),
      aspectId: 'a9', unit: { kind: 'node', nodePath: 'nonexistent' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_NODE_MISSING/);
  });

  it('missing check.mjs → STRUCTURE_LOADER_RESOLVE_FAILED', async () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    // Aspect dir exists but check.mjs does not
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'a10');
    mkdirSync(aspectDir, { recursive: true });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a10'),
      aspectId: 'a10', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_LOADER_RESOLVE_FAILED/);
  });

  it('default export named check → STRUCTURE_CHECK_DEFAULT_EXPORT', async () => {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'a11');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\nexport default function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a11'),
      aspectId: 'a11', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_DEFAULT_EXPORT/);
  });

  it('check export is not a function → STRUCTURE_CHECK_NOT_FUNCTION', async () => {
    await writeAspect('a12', `export const check = 42;`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a12'),
      aspectId: 'a12', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_NOT_FUNCTION/);
  });

  it('check function arity != 1 → STRUCTURE_CHECK_WRONG_ARITY', async () => {
    await writeAspect('a13', `export function check(ctx, extra) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a13'),
      aspectId: 'a13', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_WRONG_ARITY/);
  });

  it('node with no mapping returns empty violations', async () => {
    await writeAspect('anomap', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module' }], // no mapping
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/anomap'),
      aspectId: 'anomap', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('accepts pre-populated parseCache', async () => {
    await writeAspect('acache', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const parseCache = new Map();
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/acache'),
      aspectId: 'acache', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      parseCache,
    });
    expect(r.succeeded).toBe(true);
  });

  it('null violation entry → STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    await writeAspect('anull', `export function check(ctx) { return [null]; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/anull'),
      aspectId: 'anull', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('default export that is not a function → falls through to STRUCTURE_CHECK_NOT_EXPORTED', async () => {
    // mod.default is set but is not a function — the DEFAULT_EXPORT guard is skipped
    // and we fall through to the NOT_EXPORTED guard (since 'check' is not a named export)
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'anonfn');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\nexport default 42;`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/anonfn'),
      aspectId: 'anonfn', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_NOT_EXPORTED/);
  });

  it('absolute aspectDir path is resolved correctly', async () => {
    const aspectDir = await writeAspect('aabs', `export function check(ctx) { return []; }`);
    // aspectDir is already absolute (returned by writeAspect)
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir, // absolute path
      aspectId: 'aabs', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('undeclared fs read → structured violation (succeeded: false)', async () => {
    await writeAspect('a14', `export function check(ctx) { ctx.fs.read('src/not-allowed.ts'); return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a14'),
      aspectId: 'a14', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(false);
    expect(r.violations[0].kind).toBe('structure-aspect-undeclared-fs-read');
  });

  it('bad violation entry shape → STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    await writeAspect('a15', `export function check(ctx) { return [{ notMessage: 'oops' }]; }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    await expect(runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a15'),
      aspectId: 'a15', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    })).rejects.toThrow(/STRUCTURE_CHECK_RETURN_SHAPE/);
  });

  it('undeclared graph read → structured violation (succeeded: false)', async () => {
    await writeAspect('a16', `export function check(ctx) { ctx.graph.node('Other'); return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'Other', type: 'module', mapping: [] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a16'),
      aspectId: 'a16', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(false);
    expect(r.violations[0].kind).toBe('structure-aspect-undeclared-graph-read');
  });

  it('relation target files prewarmup', async () => {
    // Relation target's files should be in the AST input set for prewarmup
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/b.ts'), 'export const y = 2;');
    await writeAspect('a17', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['lib/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a17'),
      aspectId: 'a17', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('relation target with directory mapping enumerates files for prewarmup', async () => {
    // Create a subdir with nested dirs and files; use as relation target's dir mapping
    mkdirSync(path.join(projectRoot, 'lib/nested'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'lib/nested/c.ts'), 'export const z = 3;');
    await writeAspect('a18', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep2' }] },
        { path: 'Dep2', type: 'module', mapping: ['lib'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a18'),
      aspectId: 'a18', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('parseAst on non-prewarmed file → structured violation (succeeded: false)', async () => {
    // The file 'src/a.ts' is in the node mapping but a file NOT prewarmed by
    // the dispatcher (src/not-prewarmed.ts) should yield a typed violation,
    // NOT a hard StructureRunnerError / STRUCTURE_CHECK_THROWN crash.
    await writeAspect('a20', `export function check(ctx) {
      ctx.parseAst({ path: 'src/not-prewarmed.ts', content: 'const x = 1;' }, 'typescript');
      return [];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a20'),
      aspectId: 'a20', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    // Must NOT throw — runner converts to a typed violation
    expect(r.succeeded).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].kind).toBe('structure-aspect-parseast-not-prewarmed');
  });

  // Regression canary for the shared-hook-loader extraction (Task 3). The
  // deterministic path must keep BYTE-IDENTICAL behavior after buildUnitCtx is
  // factored out: an async check still hard-rejects (sync-reject policy), and a
  // normal check still loads, runs, and records touched files.
  describe('hook-loader extraction canary (deterministic path unchanged)', () => {
    it('async check.mjs STILL throws STRUCTURE_CHECK_ASYNC (sync-reject policy preserved)', async () => {
      await writeAspect('canary-async', `export async function check(ctx) { return []; }`);
      const g = buildTestGraphForStructure({
        nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
      });
      await expect(runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/canary-async'),
        aspectId: 'canary-async', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      })).rejects.toThrow(/STRUCTURE_CHECK_ASYNC/);
    });

    it('normal check.mjs still loads, runs, and records touched identically', async () => {
      await writeAspect('canary-sync', `export function check(ctx) { ctx.fs.read('src/a.ts'); return [{ message: 'ok', file: 'src/a.ts', line: 1 }]; }`);
      const g = buildTestGraphForStructure({
        nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
      });
      const r = await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/canary-sync'),
        aspectId: 'canary-sync', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      });
      expect(r.succeeded).toBe(true);
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0].message).toBe('ok');
      expect(r.touchedFiles).toContain('src/a.ts');
    });

    it('reading ctx.node.type folds a graph: observation on the reviewed node (no stale-green on a type change)', async () => {
      await writeAspect('canary-type', `export function check(ctx) { if (ctx.node.type === 'engine') return [{ message: 'x' }]; return []; }`);
      const g = buildTestGraphForStructure({
        nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
      });
      const r = await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/canary-type'),
        aspectId: 'canary-type', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      });
      expect(r.succeeded).toBe(true);
      // The node's identity is now folded, so a later type/ports change invalidates.
      expect(r.observations.some(([k]) => k.startsWith('graph:') && k.includes('N'))).toBe(true);
    });

    it('a check that never reads ctx.node.type/ports does NOT fold the self graph: observation', async () => {
      await writeAspect('canary-id', `export function check(ctx) { void ctx.node.id; void ctx.node.files; return []; }`);
      const g = buildTestGraphForStructure({
        nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
      });
      const r = await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/canary-id'),
        aspectId: 'canary-id', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      });
      expect(r.succeeded).toBe(true);
      expect(r.observations.some(([k]) => k.startsWith('graph:') && k.includes('N'))).toBe(false);
    });
  });

  it('node with children — child mapping carved out of own files', async () => {
    // Add a child mapping so buildOwnFiles exercises the child carve-out path
    mkdirSync(path.join(projectRoot, 'src/sub'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/sub/child.ts'), 'export const c = 3;');
    await writeAspect('a19', `export function check(ctx) { return []; }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'Parent', type: 'module', mapping: ['src/a.ts', 'src/sub/child.ts'], parent: undefined },
        { path: 'Parent/Child', type: 'module', mapping: ['src/sub/child.ts'], parent: 'Parent' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/a19'),
      aspectId: 'a19', unit: { kind: 'node', nodePath: 'Parent' }, graph: g, projectRoot,
    });
    // src/sub/child.ts is child-owned so carved out; only src/a.ts in own files
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});
