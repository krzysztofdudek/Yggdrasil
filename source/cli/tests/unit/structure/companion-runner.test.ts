import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCompanionHook } from '../../../src/structure/hook-loader.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runCompanionHook', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-companion-runner-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const y = 2;');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  /** Write a companion.mjs (beside where content.md would live) for an aspect. */
  function writeCompanion(aspectId: string, companionBody: string): string {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    // A real LLM aspect ships content.md alongside companion.mjs; write it too so
    // the on-disk layout matches production (the loader only imports companion.mjs).
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule\n');
    writeFileSync(path.join(aspectDir, 'companion.mjs'), `// cb=${cbCounter}\n${companionBody}`);
    return aspectDir;
  }

  function graphN() {
    return buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
  }

  it('async companion resolves (awaited, no async error)', async () => {
    writeCompanion('async-ok', `export async function companion(ctx) {
      await Promise.resolve();
      return [{ path: 'src/a.ts', label: 'subject' }];
    }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/async-ok'),
      aspectId: 'async-ok', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.descriptors).toEqual([{ path: 'src/a.ts', label: 'subject' }]);
  });

  it('sync companion resolves', async () => {
    writeCompanion('sync-ok', `export function companion(ctx) {
      return [{ path: 'src/a.ts' }];
    }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/sync-ok'),
      aspectId: 'sync-ok', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.descriptors).toEqual([{ path: 'src/a.ts' }]);
  });

  it('[] resolves → ok with empty list', async () => {
    writeCompanion('empty-ok', `export function companion(ctx) { return []; }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/empty-ok'),
      aspectId: 'empty-ok', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.descriptors).toEqual([]);
  });

  it('companion throws → infra (never a Violation)', async () => {
    writeCompanion('throw-infra', `export function companion(ctx) { throw new Error('boom'); }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/throw-infra'),
      aspectId: 'throw-infra', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/threw/i);
    // No Violation shape leaks: an infra result carries only messageData.
    expect((r as Record<string, unknown>).descriptors).toBeUndefined();
  });

  it('async companion rejects → infra (awaited rejection, not a hard throw)', async () => {
    writeCompanion('async-reject', `export async function companion(ctx) { throw new Error('async boom'); }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/async-reject'),
      aspectId: 'async-reject', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/threw/i);
  });

  it('thenable return does NOT throw STRUCTURE_CHECK_ASYNC (await-allow policy)', async () => {
    // The deterministic path hard-rejects a thenable; the companion path awaits it.
    writeCompanion('thenable-ok', `export function companion(ctx) {
      return Promise.resolve([{ path: 'src/a.ts' }]);
    }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/thenable-ok'),
      aspectId: 'thenable-ok', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.descriptors).toEqual([{ path: 'src/a.ts' }]);
  });

  it('bad shape (not array) → infra', async () => {
    writeCompanion('bad-nonarray', `export function companion(ctx) { return 'oops'; }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/bad-nonarray'),
      aspectId: 'bad-nonarray', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/array/i);
  });

  it('bad shape (entry without string path) → infra', async () => {
    writeCompanion('bad-entry', `export function companion(ctx) { return [{ notPath: 'x' }]; }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/bad-entry'),
      aspectId: 'bad-entry', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/path/i);
  });

  it('bad shape (non-string label) → infra', async () => {
    writeCompanion('bad-label', `export function companion(ctx) { return [{ path: 'src/a.ts', label: 42 }]; }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/bad-label'),
      aspectId: 'bad-label', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/label/i);
  });

  it('declared-read error (undeclared fs read) → infra, NOT a Violation', async () => {
    writeCompanion('undeclared-fs', `export function companion(ctx) {
      ctx.fs.read('src/not-allowed.ts');
      return [];
    }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/undeclared-fs'),
      aspectId: 'undeclared-fs', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/undeclared/i);
    // The hook never judges — no Violation kind leaks into the result.
    expect((r as Record<string, unknown>).descriptors).toBeUndefined();
  });

  it('declared-read error (undeclared graph read) → infra', async () => {
    writeCompanion('undeclared-graph', `export function companion(ctx) {
      ctx.graph.node('Other');
      return [];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'Other', type: 'module', mapping: [] },
      ],
    });
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/undeclared-graph'),
      aspectId: 'undeclared-graph', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/undeclared/i);
  });

  it('parseAst on non-prewarmed file → infra (declared-read class, not a Violation)', async () => {
    writeCompanion('parseast-infra', `export function companion(ctx) {
      ctx.parseAst({ path: 'src/not-prewarmed.ts', content: 'const x = 1;' }, 'typescript');
      return [];
    }`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/parseast-infra'),
      aspectId: 'parseast-infra', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/undeclared/i);
  });

  it('missing companion.mjs → infra', async () => {
    // Aspect dir exists but no companion.mjs file.
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'no-companion');
    mkdirSync(aspectDir, { recursive: true });
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/no-companion'),
      aspectId: 'no-companion', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/companion\.mjs/i);
  });

  it('companion export is not a function → infra', async () => {
    writeCompanion('not-fn', `export const companion = 42;`);
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/not-fn'),
      aspectId: 'not-fn', unit: { kind: 'node', nodePath: 'N' }, graph: graphN(), projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/companion/i);
  });

  it('missing node → infra (STRUCTURE_NODE_MISSING mapped)', async () => {
    writeCompanion('node-missing', `export function companion(ctx) { return []; }`);
    const g = buildTestGraphForStructure({ nodes: [] });
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/node-missing'),
      aspectId: 'node-missing', unit: { kind: 'node', nodePath: 'nonexistent' }, graph: g, projectRoot,
    });
    expect(r.kind).toBe('infra');
    if (r.kind !== 'infra') return;
    expect(r.messageData.what).toMatch(/not in graph/i);
  });

  it('records out-of-subject reads as observations + touched', async () => {
    // src/b.ts is an own-node sibling but NOT the per:file subject (subjectScope =
    // src/a.ts), so a read folds a read: observation and appears in touched.
    writeCompanion('records', `export function companion(ctx) {
      ctx.fs.read('src/b.ts');
      return [{ path: 'src/b.ts', label: 'sibling' }];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/b.ts'] }],
    });
    const r = await runCompanionHook({
      aspectDir: path.join('.yggdrasil/aspects/records'),
      aspectId: 'records', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
      subjectScope: ['src/a.ts'],
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.touchedFiles).toContain('src/b.ts');
    expect(r.observations.some(([k]) => k === 'read:src/b.ts')).toBe(true);
    expect(r.observationsTainted).toBe(false);
  });
});
