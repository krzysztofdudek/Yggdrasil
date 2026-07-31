/**
 * A directory (or glob) mapping's allowed-reads set is drawn from the RAW
 * mapping entry, not from an already-boundary-filtered file list — so a
 * check.mjs, a companion.mjs, or a returned companion descriptor can name a
 * path that textually falls inside the mapped directory but actually belongs
 * to a SEPARATE project (a nested `.yggdrasil/` graph, or a nested `.git`
 * checkout/submodule/worktree). Every one of the three ways a rule's review
 * reads a file — ctx.fs.*, ctx.parseYaml/Json/Toml (string-path form), and a
 * resolved companion — must refuse such a path, not just ctx.files/ctx.node.files.
 *
 * HERMETIC: real on-disk fixtures under a fresh mkdtemp per test, no mocking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import { resolveCompanionsForPair } from '../../../src/core/companion-resolve.js';
import { nodeUnit } from '../../../src/model/lock.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import type { AspectDef } from '../../../src/model/graph.js';

describe('a nested project inside a mapped directory is refused on every read surface', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-nested-read-guard-'));
    mkdirSync(path.join(projectRoot, 'services'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'services', 'alpha.py'), 'def alpha(): return 1\n');
    // A vendored sub-project with its own graph, nested inside the mapped
    // directory. The 'services' mapping entry textually covers it.
    mkdirSync(path.join(projectRoot, 'services', 'vendorlib', '.yggdrasil'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'services', 'vendorlib', '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\n',
    );
    writeFileSync(
      path.join(projectRoot, 'services', 'vendorlib', 'other.py'),
      'SECRET_VENDOR_TOKEN = "not-yours"\n',
    );
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function graphN() {
    return buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['services'] }],
    });
  }

  function writeDetAspect(aspectId: string, checkBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), checkBody);
  }

  it('ctx.fs.read on a foreign file inside the nested project is refused', async () => {
    writeDetAspect('read-foreign', `export function check(ctx) {
      ctx.fs.read('services/vendorlib/other.py');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/read-foreign'),
        aspectId: 'read-foreign', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('ctx.fs.read on the nested project\'s OWN yg-config.yaml is refused', async () => {
    writeDetAspect('read-foreign-config', `export function check(ctx) {
      ctx.fs.read('services/vendorlib/.yggdrasil/yg-config.yaml');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/read-foreign-config'),
        aspectId: 'read-foreign-config', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('ctx.fs.exists / ctx.fs.list on the foreign subtree are refused', async () => {
    writeDetAspect('exists-foreign', `export function check(ctx) {
      ctx.fs.exists('services/vendorlib/other.py');
      return [];
    }`);
    let caughtExists: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/exists-foreign'),
        aspectId: 'exists-foreign', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caughtExists = e; }
    expect((caughtExists as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');

    writeDetAspect('list-foreign', `export function check(ctx) {
      ctx.fs.list('services/vendorlib');
      return [];
    }`);
    let caughtList: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/list-foreign'),
        aspectId: 'list-foreign', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caughtList = e; }
    expect((caughtList as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('ctx.parseYaml(path) (string-path form) on the nested project\'s own config is refused', async () => {
    writeDetAspect('parse-foreign', `export function check(ctx) {
      ctx.parseYaml('services/vendorlib/.yggdrasil/yg-config.yaml');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/parse-foreign'),
        aspectId: 'parse-foreign', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  // ── The confirmed control: an ordinary, non-nested sibling stays readable ──
  it('control: ctx.fs.read on an ordinary mapped sibling still works (the guard does not over-reject)', async () => {
    writeDetAspect('read-ordinary', `export function check(ctx) {
      const body = ctx.fs.read('services/alpha.py');
      return body.includes('alpha') ? [] : [{ message: 'missing', file: 'services/alpha.py', line: 1 }];
    }`);
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/read-ordinary'),
      aspectId: 'read-ordinary', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  // ── Companion resolution: the same billed, paid-reviewer-prompt path ──────

  function writeCompanionAspect(aspectId: string, companionBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule\n');
    writeFileSync(path.join(aspectDir, 'companion.mjs'), companionBody);
  }

  function makePair(): ExpectedPair {
    return {
      aspectId: 'co-nested',
      kind: 'llm',
      unitKey: nodeUnit('N'),
      nodePath: 'N',
      status: 'enforced',
      subjectFiles: ['services/alpha.py'],
    };
  }

  function makeAspect(): AspectDef {
    return {
      id: 'co-nested',
      name: 'co-nested',
      reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '# rule\n' }],
    } as unknown as AspectDef;
  }

  it('a companion.mjs returning a foreign file inside the nested project fails closed (infra), never billed', async () => {
    writeCompanionAspect('co-nested', `export function companion(ctx) {
      return [{ path: 'services/vendorlib/other.py', label: 'foreign-project-file' }];
    }`);
    const result = await resolveCompanionsForPair(graphN(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('infra');
  });

  it('a companion.mjs returning the nested project\'s OWN yg-config.yaml fails closed (infra)', async () => {
    writeCompanionAspect('co-nested', `export function companion(ctx) {
      return [{ path: 'services/vendorlib/.yggdrasil/yg-config.yaml', label: 'foreign-project-config' }];
    }`);
    const result = await resolveCompanionsForPair(graphN(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('infra');
  });

  it('control: a companion.mjs returning an ordinary mapped sibling still resolves ok', async () => {
    writeCompanionAspect('co-nested', `export function companion(ctx) {
      return [];
    }`);
    const result = await resolveCompanionsForPair(graphN(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.companions.promptCompanions).toEqual([]);
  });
});

/**
 * A symlink defeats the TEXTUAL nested-project check above it in
 * resolveAllowedReadPath (`isUnderAnyNestedProjectRoot(rel, ...)`, which only
 * ever inspects the pre-symlink path) unless the REAL, symlink-resolved path
 * is ALSO checked against the boundary — the same real-path re-check
 * assertRealpathContained already performs for "does this escape the repo
 * root entirely." A first-party check.mjs, companion.mjs, or a returned
 * companion descriptor naming an ordinary-looking symlink inside a mapped
 * directory must still be refused when that symlink's target is either a
 * separate project's own file or a path outside the repository altogether.
 *
 * HERMETIC: real on-disk fixtures and real symlinks under a fresh mkdtemp per
 * test, no mocking.
 */
describe('a symlink cannot smuggle a foreign read past the nested-project guard', () => {
  let projectRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-nested-symlink-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'yg-nested-symlink-outside-'));

    mkdirSync(path.join(projectRoot, 'services'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'services', 'alpha.py'), 'def alpha(): return 1\n');

    // A vendored sub-project with its own graph, nested inside the mapped directory.
    mkdirSync(path.join(projectRoot, 'services', 'vendorlib', '.yggdrasil'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'services', 'vendorlib', '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\n',
    );
    writeFileSync(
      path.join(projectRoot, 'services', 'vendorlib', 'other.py'),
      'SECRET_VENDOR_TOKEN = "not-yours"\n',
    );

    // A real, ordinary-looking symlink inside the mapped directory whose target
    // resolves INTO the nested project — the case the textual check alone misses.
    symlinkSync(
      path.join(projectRoot, 'services', 'vendorlib', 'other.py'),
      path.join(projectRoot, 'services', 'alias.py'),
    );

    // A real symlink whose target resolves OUTSIDE the repository altogether —
    // the direction the pre-existing realpath check already covers; re-checked
    // here so the new nested-boundary check cannot regress it.
    writeFileSync(path.join(outsideDir, 'secret.py'), 'OUTSIDE_TOKEN = "not-yours"\n');
    symlinkSync(
      path.join(outsideDir, 'secret.py'),
      path.join(projectRoot, 'services', 'outside-alias.py'),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  function graphN() {
    return buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['services'] }],
    });
  }

  function writeDetAspect(aspectId: string, checkBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), checkBody);
  }

  it('ctx.fs.read on a symlink resolving INTO the nested project is refused', async () => {
    writeDetAspect('read-symlink-in', `export function check(ctx) {
      ctx.fs.read('services/alias.py');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/read-symlink-in'),
        aspectId: 'read-symlink-in', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('ctx.fs.read on a symlink resolving OUTSIDE the repository is still refused (regression check)', async () => {
    writeDetAspect('read-symlink-out', `export function check(ctx) {
      ctx.fs.read('services/outside-alias.py');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/read-symlink-out'),
        aspectId: 'read-symlink-out', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('ctx.parseYaml (string-path form) on a symlink resolving INTO the nested project is refused', async () => {
    symlinkSync(
      path.join(projectRoot, 'services', 'vendorlib', '.yggdrasil', 'yg-config.yaml'),
      path.join(projectRoot, 'services', 'alias-cfg.yaml'),
    );
    writeDetAspect('parse-symlink-in', `export function check(ctx) {
      ctx.parseYaml('services/alias-cfg.yaml');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/parse-symlink-in'),
        aspectId: 'parse-symlink-in', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });

  it('control: ctx.fs.read on an ordinary (non-symlink) mapped sibling still works', async () => {
    writeDetAspect('read-ordinary-symlink-suite', `export function check(ctx) {
      const body = ctx.fs.read('services/alpha.py');
      return body.includes('alpha') ? [] : [{ message: 'missing', file: 'services/alpha.py', line: 1 }];
    }`);
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/read-ordinary-symlink-suite'),
      aspectId: 'read-ordinary-symlink-suite', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  // ── Companion resolution: the same billed, paid-reviewer-prompt path ──────

  function writeCompanionAspect(aspectId: string, companionBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule\n');
    writeFileSync(path.join(aspectDir, 'companion.mjs'), companionBody);
  }

  function makePair(): ExpectedPair {
    return {
      aspectId: 'co-nested-symlink',
      kind: 'llm',
      unitKey: nodeUnit('N'),
      nodePath: 'N',
      status: 'enforced',
      subjectFiles: ['services/alpha.py'],
    };
  }

  function makeAspect(): AspectDef {
    return {
      id: 'co-nested-symlink',
      name: 'co-nested-symlink',
      reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '# rule\n' }],
    } as unknown as AspectDef;
  }

  it('a companion.mjs naming a symlink resolving INTO the nested project fails closed (infra), never billed', async () => {
    writeCompanionAspect('co-nested-symlink', `export function companion(ctx) {
      return [{ path: 'services/alias.py', label: 'foreign-via-symlink' }];
    }`);
    const result = await resolveCompanionsForPair(graphN(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('infra');
  });

  it('a companion.mjs naming a symlink resolving OUTSIDE the repository fails closed (infra)', async () => {
    writeCompanionAspect('co-nested-symlink', `export function companion(ctx) {
      return [{ path: 'services/outside-alias.py', label: 'outside-via-symlink' }];
    }`);
    const result = await resolveCompanionsForPair(graphN(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('infra');
  });
});
