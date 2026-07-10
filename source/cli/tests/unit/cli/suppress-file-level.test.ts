import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runSuppressionsScan,
  formatSuppressionsOutput,
} from '../../../src/cli/suppressions.js';
import { collectSuppressions } from '../../../src/ast/suppress.js';
import { resolveSuppressedRangesForPrompt } from '../../../src/structure/suppress-ranges.js';

// ===========================================================================
// RZ-12 — File-level suppress taxonomy.
//
// An unclosed `yg-suppress-disable(<id>)` whose marker sits within the FIRST 5
// NON-EMPTY lines of the file is the sanctioned whole-file waiver: the inventory
// classifies it `file-level` and does NOT emit the "Unbounded range" warning. An
// unclosed disable anywhere LATER keeps today's "Unbounded" warning.
//
// THE CRITICAL INVARIANT: this is an inventory-CLASSIFICATION change only. The
// resolved waiver LINE RANGES that the reviewers honor are byte-identical before
// and after — a bare disable still runs from disable-line+1 to EOF regardless of
// where it sits. The tests below pin BOTH: the classification differs, the honored
// ranges do not.
// ===========================================================================

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDir(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `yg-supp-filelevel-${label}-`));
  tempDirs.push(d);
  return d;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('RZ-12: file-level classification for a top-of-file bare disable', () => {
  it('(a) a bare disable on line 1 is classified `file-level` with ZERO warnings', async () => {
    const root = freshDir('top');
    write(
      root,
      'whole.ts',
      [
        '// yg-suppress-disable(rz12-rule) whole file is generated, do not edit',
        'export const a = 1;',
        'export const b = 2;',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['whole.ts'], new Set(['rz12-rule']));
    const out = formatSuppressionsOutput(report);

    // The marker is still inventoried, but rendered as the sanctioned file-level form.
    expect(out).toContain('file-level(rz12-rule)');
    expect(out).not.toContain('disable(rz12-rule)');
    // No "Unbounded range" (and no other) warning for the sanctioned whole-file form.
    expect(report.warnings).toHaveLength(0);
    expect(out).not.toContain('Unbounded');
  });

  it('(a2) a bare disable is still file-level when preceded only by blank/whitespace lines', async () => {
    // "Non-empty" line counting: leading blank lines do not consume the window, so
    // a marker after a shebang/blank preamble is still at the file head.
    const root = freshDir('blank-preamble');
    write(
      root,
      'blank.ts',
      [
        '',
        '   ',
        '// yg-suppress-disable(rz12-rule) generated preamble skipped',
        'export const a = 1;',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['blank.ts'], new Set(['rz12-rule']));
    const out = formatSuppressionsOutput(report);
    expect(out).toContain('file-level(rz12-rule)');
    expect(report.warnings).toHaveLength(0);
  });

  it('(boundary) disable on the 5th non-empty line is file-level; on the 6th it is unbounded', async () => {
    const root = freshDir('boundary');
    // 4 code lines, then the disable => marker on the 5th NON-EMPTY line => file-level.
    write(
      root,
      'fifth.ts',
      [
        'export const l1 = 1;',
        'export const l2 = 2;',
        'export const l3 = 3;',
        'export const l4 = 4;',
        '// yg-suppress-disable(rz12-rule) fifth non-empty line, still file head',
        'export const tail = 9;',
        '',
      ].join('\n'),
    );
    const fifth = await runSuppressionsScan(root, ['fifth.ts'], new Set(['rz12-rule']));
    expect(formatSuppressionsOutput(fifth)).toContain('file-level(rz12-rule)');
    expect(fifth.warnings).toHaveLength(0);

    // 5 code lines, then the disable => marker on the 6th NON-EMPTY line => unbounded.
    const root2 = freshDir('boundary6');
    write(
      root2,
      'sixth.ts',
      [
        'export const l1 = 1;',
        'export const l2 = 2;',
        'export const l3 = 3;',
        'export const l4 = 4;',
        'export const l5 = 5;',
        '// yg-suppress-disable(rz12-rule) sixth non-empty line, genuinely unbounded',
        'export const tail = 9;',
        '',
      ].join('\n'),
    );
    const sixth = await runSuppressionsScan(root2, ['sixth.ts'], new Set(['rz12-rule']));
    expect(formatSuppressionsOutput(sixth)).toContain('disable(rz12-rule)');
    expect(sixth.warnings.some(w => w.startsWith('Unbounded yg-suppress-disable("rz12-rule") at sixth.ts:6'))).toBe(true);
  });
});

describe('RZ-12: a mid-file bare disable keeps the Unbounded warning (regression guard)', () => {
  it('(b) the same marker after 20 lines of code still warns "Unbounded"', async () => {
    const root = freshDir('mid');
    const codeLines = Array.from({ length: 20 }, (_, i) => `export const l${i + 1} = ${i + 1};`);
    write(
      root,
      'mid.ts',
      [
        ...codeLines,
        '// yg-suppress-disable(rz12-rule) mid file, no closing enable',
        'export const tail = 99;',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['mid.ts'], new Set(['rz12-rule']));
    const out = formatSuppressionsOutput(report);

    expect(out).toContain('disable(rz12-rule)');
    expect(out).not.toContain('file-level(rz12-rule)');
    // Marker sits on line 21 (the 21st non-empty line) → unbounded warning as today.
    expect(report.warnings.some(w => w.startsWith('Unbounded yg-suppress-disable("rz12-rule") at mid.ts:21'))).toBe(true);
  });
});

describe('RZ-12: honored ranges are byte-identical regardless of classification (invariant)', () => {
  // The reviewers (LLM and deterministic) both derive their honored ranges from
  // collectSuppressions. A bare disable runs from disable-line+1 to EOF whether or
  // not the inventory calls it "file-level". These assertions pin that the honored
  // range is untouched by the taxonomy — only the position of the marker shifts it,
  // exactly as before this change.

  it('(c-LLM) file-head vs mid-file bare disable → same EOF-spanning range shape (LLM projection)', async () => {
    // File-head: disable on line 1 of a 3-line file → waives lines 2..3.
    const head = [
      '// yg-suppress-disable(rz12-rule) whole file generated',
      'export const a = 1;',
      'export const b = 2;',
    ].join('\n');
    const headResult = await resolveSuppressedRangesForPrompt(
      [{ path: 'head.ts', bytes: Buffer.from(head, 'utf8') }],
      'rz12-rule',
    );
    expect(headResult.byFile).toHaveLength(1);
    expect(headResult.byFile[0].ranges).toEqual([{ startLine: 2, endLine: 3 }]);

    // Mid-file: disable on line 3 of a 4-line file → waives line 4..EOF. Same
    // disable-line+1..EOF semantics, only position-shifted — NOT altered by the
    // taxonomy.
    const mid = [
      'export const a = 1;',
      'export const b = 2;',
      '// yg-suppress-disable(rz12-rule) mid file, unbounded',
      'export const c = 3;',
    ].join('\n');
    const midResult = await resolveSuppressedRangesForPrompt(
      [{ path: 'mid.ts', bytes: Buffer.from(mid, 'utf8') }],
      'rz12-rule',
    );
    expect(midResult.byFile).toHaveLength(1);
    expect(midResult.byFile[0].ranges).toEqual([{ startLine: 4, endLine: 4 }]);
  });

  it('(c-deterministic) collectSuppressions yields the same file-head range (deterministic honoring)', () => {
    // Non-grammar (.sql) file → no tree; collectSuppressions raw-scans the content.
    // This is the exact range a deterministic check.mjs honors via isLineSuppressed.
    const sql = [
      '-- yg-suppress-disable(rz12-rule) whole reporting script waived',
      'SELECT 1;',
      'SELECT 2;',
    ].join('\n');
    const ranges = collectSuppressions(undefined, 'report.sql', 3, sql);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startLine).toBe(2);
    expect(ranges[0].endLine).toBe(3);
    expect(ranges[0].isWildcard).toBe(false);
    expect([...ranges[0].aspectIds]).toEqual(['rz12-rule']);
  });
});
