/**
 * Fix 3d — AST-walking checks must not crash on non-AST files.
 *
 * Directory expansion feeds all files (including .md, .sh, .json) to checks.
 * A check that dereferences file.ast.rootNode without a guard throws TypeError
 * on the first non-AST file. The guard `if (!file.ast) continue;` prevents
 * the crash and lets the check still flag violations in parseable files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runStructureAspect — non-AST files in mapping (fix 3d)', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-nonast-'));
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

  it('3d: AST-walking check over a mapping with a .md file does NOT crash', async () => {
    // A parseable .ts file — AST will be available
    writeFileSync(
      path.join(projectRoot, 'src/handler.ts'),
      'export function run() { BANNED(); }\n',
    );
    // A non-parseable file (.md) — file.ast will be undefined for this one
    writeFileSync(
      path.join(projectRoot, 'src/README.md'),
      '# README\nThis is documentation.\n',
    );

    // An AST-walking check guarded with `if (!file.ast) continue`.
    // Uses the raw tree-sitter API (descendantsOfType) without any external imports,
    // matching the pattern used by the runner's own test fixtures.
    await writeAspect(
      'no-banned-call-guarded',
      `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;  // guard: skip non-parseable files
    for (const node of file.ast.rootNode.descendantsOfType('call_expression')) {
      const fn = node.childForFieldName('function');
      if (fn && fn.text === 'BANNED') {
        violations.push({
          message: 'BANNED call detected',
          file: file.path,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
  }
  return violations;
}`,
    );

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/no-banned-call-guarded'),
      aspectId: 'no-banned-call-guarded',
      unit: { kind: 'node', nodePath: 'N' },
      graph: g,
      projectRoot,
    });

    // Must not crash (would throw STRUCTURE_CHECK_THROWN if unguarded)
    expect(r.succeeded).toBe(true);
    // Must still flag the violation in the .ts file
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toBe('BANNED call detected');
    expect(r.violations[0].file).toMatch(/handler\.ts$/);
  });

  it('3d: unguarded AST-walking check crashes on non-AST file (documents the pre-fix behaviour)', async () => {
    writeFileSync(
      path.join(projectRoot, 'src/handler.ts'),
      'export function run() { ok(); }\n',
    );
    // The .md file triggers the crash — file.ast is undefined, accessing .rootNode throws TypeError
    writeFileSync(
      path.join(projectRoot, 'src/README.md'),
      '# README\n',
    );

    // A check WITHOUT the guard — directly dereferences file.ast.rootNode
    await writeAspect(
      'no-banned-call-unguarded',
      `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // intentionally no guard — this is the pre-fix pattern that crashes on non-AST files
    for (const node of file.ast.rootNode.descendantsOfType('call_expression')) {
      violations.push({
        message: 'call detected',
        file: file.path,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  return violations;
}`,
    );

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });

    // The unguarded check should throw STRUCTURE_CHECK_THROWN (TypeError from file.ast being undefined)
    await expect(
      runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects/no-banned-call-unguarded'),
        aspectId: 'no-banned-call-unguarded',
        unit: { kind: 'node', nodePath: 'N' },
        graph: g,
        projectRoot,
      }),
    ).rejects.toThrow(/STRUCTURE_CHECK_THROWN/);
  });

  it('3d: content/regex check iterates all files including non-AST and still works', async () => {
    writeFileSync(
      path.join(projectRoot, 'src/handler.ts'),
      'export function run() { /* clean */ }\n',
    );
    writeFileSync(
      path.join(projectRoot, 'src/README.md'),
      '# README\nTODO: fix this\n',
    );

    // A content/regex check — does NOT touch file.ast, needs no guard.
    // Content-based checks must iterate all files including non-parseable ones.
    await writeAspect(
      'no-todo-comments',
      `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // content-based check: no file.ast access, iterates all files including .md
    if (file.content.includes('TODO')) {
      violations.push({ message: 'TODO comment found', file: file.path, line: 1, column: 0 });
    }
  }
  return violations;
}`,
    );

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/no-todo-comments'),
      aspectId: 'no-todo-comments',
      unit: { kind: 'node', nodePath: 'N' },
      graph: g,
      projectRoot,
    });

    expect(r.succeeded).toBe(true);
    // The .md file contains 'TODO' — content check should catch it
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].file).toMatch(/README\.md$/);
  });

  it('#12: a yg-suppress marker in a non-AST file (.sql) waives a content-check violation', async () => {
    // Two SQL files (no registered grammar, so no parse tree). One carries a
    // suppress marker on the line before the offending statement; the other does
    // not. Suppression is found by scanning the raw file content, so only the
    // unmarked file is flagged.
    writeFileSync(
      path.join(projectRoot, 'src/report.sql'),
      '-- yg-suppress(no-select-star) legacy report, column set is frozen\nSELECT * FROM orders;\n',
    );
    writeFileSync(
      path.join(projectRoot, 'src/ad_hoc.sql'),
      'SELECT * FROM customers;\n',
    );

    // Content-only check: flags any line containing `SELECT *`. Never touches file.ast.
    await writeAspect(
      'no-select-star',
      `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('SELECT *')) {
        violations.push({ message: 'SELECT * banned', file: file.path, line: i + 1, column: 0 });
      }
    }
  }
  return violations;
}`,
    );

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/no-select-star'),
      aspectId: 'no-select-star',
      unit: { kind: 'node', nodePath: 'N' },
      graph: g,
      projectRoot,
    });

    expect(r.succeeded).toBe(true);
    // report.sql's violation is suppressed by its marker; ad_hoc.sql's is not.
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].file).toMatch(/ad_hoc\.sql$/);
  });
});
