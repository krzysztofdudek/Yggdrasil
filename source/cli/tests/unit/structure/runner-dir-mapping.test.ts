/**
 * Fix 3b — directory-mapped nodes must expand to constituent files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runStructureAspect — directory-mapped nodes (fix 3b)', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-dir-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('3b: directory-mapped node exposes constituent files in ctx.files', async () => {
    // Node maps the entire 'src' directory; the check inspects ctx.files.
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const y = 2;');

    await writeAspect('dir1', `export function check(ctx) {
      const paths = ctx.files.map(f => f.path);
      const violations = [];
      if (!paths.some(p => p.includes('a.ts'))) {
        violations.push({ message: 'a.ts missing from ctx.files' });
      }
      if (!paths.some(p => p.includes('b.ts'))) {
        violations.push({ message: 'b.ts missing from ctx.files' });
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir1'),
      aspectId: 'dir1', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('3b: per-file violation detected when node maps directory', async () => {
    // The check flags any file whose first line contains "BAD".
    writeFileSync(path.join(projectRoot, 'src/good.ts'), 'export const ok = true;');
    writeFileSync(path.join(projectRoot, 'src/bad.ts'), '// BAD\nexport const bad = true;');

    await writeAspect('dir2', `export function check(ctx) {
      const violations = [];
      for (const f of ctx.files) {
        if (f.content.startsWith('// BAD')) {
          violations.push({ message: 'file starts with BAD', file: f.path, line: 1 });
        }
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir2'),
      aspectId: 'dir2', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toBe('file starts with BAD');
  });

  it('3b: binary files are excluded from ctx.files when directory-mapped', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    // Write a file with a known binary extension — it should be skipped
    writeFileSync(path.join(projectRoot, 'src/image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await writeAspect('dir3', `export function check(ctx) {
      const violations = [];
      for (const f of ctx.files) {
        if (f.path.endsWith('.png')) {
          violations.push({ message: 'binary file should not appear in ctx.files', file: f.path });
        }
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir3'),
      aspectId: 'dir3', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
    // ctx.files must contain the .ts but not the .png
    // We can verify by checking touchedFiles doesn't include .png
    expect(r.touchedFiles.some(f => f.endsWith('.png'))).toBe(false);
  });

  it('3b: child-mapped files are still carved out when node maps a directory', async () => {
    // Parent maps 'src'; child maps 'src/sub/child.ts'
    // The parent's ctx.files must NOT include src/sub/child.ts
    mkdirSync(path.join(projectRoot, 'src/sub'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/sub/child.ts'), 'export const c = 99;');

    await writeAspect('dir4', `export function check(ctx) {
      const violations = [];
      for (const f of ctx.files) {
        if (f.path.includes('child.ts')) {
          violations.push({ message: 'child-owned file must not appear in parent ctx.files', file: f.path });
        }
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'Parent', type: 'module', mapping: ['src'] },
        { path: 'Parent/Child', type: 'module', mapping: ['src/sub/child.ts'], parent: 'Parent' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir4'),
      aspectId: 'dir4', unit: { kind: 'node', nodePath: 'Parent' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('3b: gitignored files inside a directory mapping are excluded', async () => {
    // Write a .gitignore that ignores 'src/ignored.ts'
    writeFileSync(path.join(projectRoot, '.gitignore'), 'src/ignored.ts\n');
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    writeFileSync(path.join(projectRoot, 'src/ignored.ts'), '// GITIGNORED FILE');

    await writeAspect('dir5', `export function check(ctx) {
      const violations = [];
      for (const f of ctx.files) {
        if (f.path.includes('ignored.ts')) {
          violations.push({ message: 'gitignored file must not appear in ctx.files', file: f.path });
        }
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir5'),
      aspectId: 'dir5', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('3b: a nested separate project inside a directory mapping never appears in ctx.files / ctx.node.files', async () => {
    // A vendored sub-project with its own graph, nested inside the mapped directory.
    // Its files (including its own yg-config.yaml) must never reach ctx.files or
    // ctx.node.files as though they belonged to this node — that is the content-leak
    // this same check.mjs sees would otherwise fold a foreign body into the review.
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    mkdirSync(path.join(projectRoot, 'src/vendor/.yggdrasil'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/vendor/.yggdrasil/yg-config.yaml'), 'version: "5.2.0"\n');
    writeFileSync(path.join(projectRoot, 'src/vendor/foreign.ts'), 'export const SECRET = 1;');

    await writeAspect('dir6', `export function check(ctx) {
      const violations = [];
      const allPaths = [...ctx.files.map(f => f.path), ...ctx.node.files.map(f => f.path)];
      for (const p of allPaths) {
        if (p.startsWith('src/vendor/')) {
          violations.push({ message: 'nested project file must not appear in ctx.files/ctx.node.files', file: p });
        }
      }
      return violations;
    }`);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/dir6'),
      aspectId: 'dir6', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
    // Belt-and-suspenders: the nested files were never even read off disk for this run.
    expect(r.touchedFiles.some((f) => f.startsWith('src/vendor/'))).toBe(false);
  });
});
