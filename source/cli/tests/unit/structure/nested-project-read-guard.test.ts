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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
