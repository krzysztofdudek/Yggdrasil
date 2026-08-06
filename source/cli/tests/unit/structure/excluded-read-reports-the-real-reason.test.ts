/**
 * `ctx.fs`, `ctx.parsers`, and companion resolution all funnel a rejected read
 * through the SAME `resolveAllowedReadPath` (structure/ctx-fs.ts). A path this
 * graph excludes (a `coverage.excluded` root, or a nested project's own
 * boundary) must never be reported the same way as a path that is merely
 * undeclared: no relation or mapping change can ever satisfy a read of an
 * excluded path, so telling an agent to "add a relation" sends it in a loop.
 * These tests drive all three consumers directly against real on-disk
 * fixtures and assert the excluded-specific message, never a mocked collaborator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import type { StructureUnit } from '../../../src/structure/runner.js';
import { resolveCompanionsForPair } from '../../../src/core/companion-resolve.js';
import { nodeUnit } from '../../../src/model/lock.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import type { AspectDef, YggConfig } from '../../../src/model/graph.js';

describe('an excluded path read through ctx.fs, ctx.parsers, or a companion is reported as excluded, never as "add a relation"', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-excl-read-reason-'));
    mkdirSync(path.join(projectRoot, 'specs'), { recursive: true });
    mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'specs', 'a.md'), '# spec\n');
    writeFileSync(path.join(projectRoot, 'lib', 'gen.ts'), 'export const gen = 1;\n');
    writeFileSync(path.join(projectRoot, 'lib', 'kept.ts'), 'export const kept = 1;\n');
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    cleanupTestGraphs();
  });

  const excludeGenTs: YggConfig = { coverage: { required: [], excluded: ['lib/gen.ts'], typeLevel: false } };

  // `spec` DECLARES a relation to `lib` — the relation the old, undifferentiated
  // message would have told an agent to "add" is already there, so any test
  // reaching that wording would prove the advice is a dead loop.
  function graphWithDeclaredRelation() {
    return buildTestGraphForStructure({
      nodes: [
        { path: 'spec', type: 'module', mapping: ['specs'], relations: [{ type: 'uses', target: 'lib' }] },
        { path: 'lib', type: 'module', mapping: ['lib'] },
      ],
      config: excludeGenTs,
    });
  }

  function writeDetAspect(aspectId: string, checkBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), checkBody);
  }

  async function catchStructureError(params: Parameters<typeof runStructureAspect>[0]): Promise<StructureRunnerError> {
    try {
      await runStructureAspect(params);
    } catch (e) {
      expect(e).toBeInstanceOf(StructureRunnerError);
      return e as StructureRunnerError;
    }
    throw new Error('expected runStructureAspect to throw');
  }

  it('ctx.fs.read of the excluded path reports it excluded, not a relation to add — a declared relation already exists', async () => {
    writeDetAspect('detread', `export function check(ctx) {
      ctx.fs.read('lib/gen.ts');
      return [];
    }`);
    const err = await catchStructureError({
      aspectDir: path.join('.yggdrasil/aspects/detread'),
      aspectId: 'detread', unit: { kind: 'node', nodePath: 'spec' }, graph: graphWithDeclaredRelation(), projectRoot,
    });
    expect(err.code).toBe('STRUCTURE_UNDECLARED_FS_READ');
    expect(err.messageData.what).toContain('excluded from graph coverage by design');
    expect(err.messageData.next).not.toContain('Add a relation');
  });

  it('control: ctx.fs.read of the NON-excluded sibling in the same package still succeeds', async () => {
    writeDetAspect('detread-kept', `export function check(ctx) {
      const body = ctx.fs.read('lib/kept.ts');
      return body.includes('kept') ? [] : [{ message: 'missing', file: 'lib/kept.ts', line: 1 }];
    }`);
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/detread-kept'),
      aspectId: 'detread-kept', unit: { kind: 'node', nodePath: 'spec' }, graph: graphWithDeclaredRelation(), projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('ctx.parseYaml(path) (string-path form) of the excluded path reports it excluded too — the same throw, the same fix', async () => {
    writeDetAspect('detparse', `export function check(ctx) {
      ctx.parseYaml('lib/gen.ts');
      return [];
    }`);
    const err = await catchStructureError({
      aspectDir: path.join('.yggdrasil/aspects/detparse'),
      aspectId: 'detparse', unit: { kind: 'node', nodePath: 'spec' }, graph: graphWithDeclaredRelation(), projectRoot,
    });
    expect(err.code).toBe('STRUCTURE_UNDECLARED_FS_READ');
    expect(err.messageData.what).toContain('excluded from graph coverage by design');
    expect(err.messageData.next).not.toContain('Add a relation');
  });

  it('a nodeless (file-kind) unit reading the excluded path also reports it excluded, not a type relation to widen', async () => {
    writeDetAspect('detread-nodeless', `export function check(ctx) {
      ctx.fs.read('lib/gen.ts');
      return [];
    }`);
    const unit: StructureUnit = { kind: 'file', file: 'specs/a.md', typeId: 'spec', allowedReads: ['specs/a.md', 'lib/gen.ts'] };
    const err = await catchStructureError({
      aspectDir: path.join('.yggdrasil/aspects/detread-nodeless'),
      aspectId: 'detread-nodeless', unit, graph: buildTestGraphForStructure({ nodes: [], config: excludeGenTs }), projectRoot,
    });
    expect(err.code).toBe('STRUCTURE_UNDECLARED_FS_READ');
    expect(err.messageData.what).toContain('excluded from graph coverage by design');
    expect(err.messageData.next).not.toContain('Allow');
  });

  // ── Companion resolution: a companion.mjs that READS the excluded path itself ──

  function writeCompanionAspect(aspectId: string, companionBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule\n');
    writeFileSync(path.join(aspectDir, 'companion.mjs'), companionBody);
  }

  function makePair(): ExpectedPair {
    return {
      aspectId: 'co-excl',
      kind: 'llm',
      unitKey: nodeUnit('spec'),
      nodePath: 'spec',
      status: 'enforced',
      subjectFiles: ['specs/a.md'],
    };
  }

  function makeAspect(): AspectDef {
    return {
      id: 'co-excl',
      name: 'co-excl',
      reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '# rule\n' }],
    } as unknown as AspectDef;
  }

  it('a companion.mjs that itself calls ctx.fs.read on the excluded path fails closed with the excluded reason, never "declare a relation"', async () => {
    writeCompanionAspect('co-excl', `export function companion(ctx) {
      ctx.fs.read('lib/gen.ts');
      return [];
    }`);
    const result = await resolveCompanionsForPair(graphWithDeclaredRelation(), projectRoot, makePair(), makeAspect());
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.messageData.what).toContain('excluded from graph coverage by design');
    expect(result.messageData.next.toLowerCase()).not.toContain('declare a relation');
  });

  // ── Companion resolution: a companion.mjs that RETURNS the excluded path ──

  it('a companion.mjs that RETURNS the excluded path fails closed with the excluded reason and names which source matched', async () => {
    writeCompanionAspect('co-excl-return', `export function companion(ctx) {
      return [{ path: 'lib/gen.ts', label: 'generated' }];
    }`);
    const result = await resolveCompanionsForPair(graphWithDeclaredRelation(), projectRoot, {
      ...makePair(),
      aspectId: 'co-excl-return',
    }, { ...makeAspect(), id: 'co-excl-return' });
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.messageData.what).toContain('excluded from graph coverage by design');
    // Names WHICH source matched (a coverage.excluded root here) instead of
    // asking the reader to check both sources themselves.
    expect(result.messageData.why).toContain('coverage.excluded root');
    expect(result.messageData.why).not.toContain('own boundary … or matches');
  });

  it('control: a companion.mjs returning the excluded path when the source is a NESTED PROJECT names that source instead', async () => {
    mkdirSync(path.join(projectRoot, 'specs', 'vendored', '.yggdrasil'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'specs', 'vendored', '.yggdrasil', 'yg-config.yaml'), 'version: "5.2.0"\n');
    writeFileSync(path.join(projectRoot, 'specs', 'vendored', 'other.md'), '# vendored\n');
    writeCompanionAspect('co-nested-return', `export function companion(ctx) {
      return [{ path: 'specs/vendored/other.md', label: 'vendored' }];
    }`);
    const graph = buildTestGraphForStructure({
      nodes: [
        { path: 'spec', type: 'module', mapping: ['specs'], relations: [{ type: 'uses', target: 'lib' }] },
        { path: 'lib', type: 'module', mapping: ['lib'] },
      ],
    });
    const result = await resolveCompanionsForPair(graph, projectRoot, {
      ...makePair(),
      aspectId: 'co-nested-return',
    }, { ...makeAspect(), id: 'co-nested-return' });
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.messageData.what).toContain('excluded from graph coverage by design');
    expect(result.messageData.why).toContain("separate project's own boundary");
    expect(result.messageData.why).not.toContain('coverage.excluded root');
  });
});

// ---------------------------------------------------------------------------
// A symlink INSIDE a node's own mapping (textually allowed) whose REAL target
// resolves under a `coverage.excluded` root. The lexical checks in
// resolveAllowedReadPath only see the symlink's own, allowed-looking path;
// only the realpath re-check (assertRealpathContained) sees where it actually
// points. The excluded-specific message must survive that second check too.
// ---------------------------------------------------------------------------
describe('a symlink resolving into a coverage.excluded location is refused with the excluded reason, not treated as an ordinary allowed read', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-excl-symlink-'));
    mkdirSync(path.join(projectRoot, 'specs'), { recursive: true });
    mkdirSync(path.join(projectRoot, 'vendor'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'specs', 'a.md'), '# spec\n');
    writeFileSync(path.join(projectRoot, 'vendor', 'secret.ts'), 'export const secret = 1;\n');
    writeFileSync(path.join(projectRoot, 'vendor', 'shared.ts'), 'export const shared = 1;\n');
    // specs/alias.ts LOOKS like an ordinary file inside the node's own mapping;
    // its real target lives under the excluded vendor/ root.
    symlinkSync(path.join(projectRoot, 'vendor', 'secret.ts'), path.join(projectRoot, 'specs', 'alias.ts'));
    // The control symlink's target is under vendor/ too, but vendor/shared.ts
    // is NOT excluded — only vendor/secret.ts is.
    symlinkSync(path.join(projectRoot, 'vendor', 'shared.ts'), path.join(projectRoot, 'specs', 'alias-ok.ts'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function graph() {
    return buildTestGraphForStructure({
      nodes: [{ path: 'spec', type: 'module', mapping: ['specs'] }],
      config: { coverage: { required: [], excluded: ['vendor/secret.ts'], typeLevel: false } },
    });
  }

  function writeDetAspect(aspectId: string, checkBody: string): void {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), checkBody);
  }

  it('ctx.fs.read on the symlink is refused as excluded, naming the real reason', async () => {
    writeDetAspect('readalias', `export function check(ctx) {
      ctx.fs.read('specs/alias.ts');
      return [];
    }`);
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/readalias'),
        aspectId: 'readalias', unit: { kind: 'node', nodePath: 'spec' }, graph: graph(), projectRoot,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    const err = caught as StructureRunnerError;
    expect(err.code).toBe('STRUCTURE_UNDECLARED_FS_READ');
    expect(err.messageData.what).toContain('excluded from graph coverage by design');
  });

  it('control: ctx.fs.read on a symlink whose target is NOT excluded still succeeds', async () => {
    writeDetAspect('readalias-ok', `export function check(ctx) {
      const body = ctx.fs.read('specs/alias-ok.ts');
      return body.includes('shared') ? [] : [{ message: 'missing', file: 'specs/alias-ok.ts', line: 1 }];
    }`);
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/readalias-ok'),
      aspectId: 'readalias-ok', unit: { kind: 'node', nodePath: 'spec' }, graph: graph(), projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});
