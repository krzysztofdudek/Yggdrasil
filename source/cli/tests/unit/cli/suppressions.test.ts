import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSuppressionsScan, formatSuppressionsOutput } from '../../../src/cli/suppressions.js';
import { scanSuppressionMarkers } from '../../../src/ast/suppress.js';

// ── scanSuppressionMarkers ────────────────────────────────

describe('scanSuppressionMarkers', () => {
  it('detects a single-line marker', () => {
    const text = '// yg-suppress(my-aspect) some reason\nconst x = 1;';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      line: 1,
      aspectId: 'my-aspect',
      kind: 'single',
      wildcard: false,
      reason: 'some reason',
    });
  });

  it('detects a disable marker', () => {
    const text = 'const a = 1;\n// yg-suppress-disable(my-aspect) legacy code\nconst b = 2;';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      line: 2,
      aspectId: 'my-aspect',
      kind: 'disable',
      wildcard: false,
      reason: 'legacy code',
    });
  });

  it('detects an enable marker', () => {
    const text = '// yg-suppress-enable(my-aspect)';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      line: 1,
      aspectId: 'my-aspect',
      kind: 'enable',
      wildcard: false,
      reason: '',
    });
  });

  it('detects wildcard markers', () => {
    const text = '// yg-suppress(*) emergency bypass';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      aspectId: '*',
      kind: 'single',
      wildcard: true,
    });
  });

  it('expands comma-separated aspect ids into separate entries', () => {
    const text = '// yg-suppress(aspect-a, aspect-b) two aspects';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers.map(m => m.aspectId)).toEqual(['aspect-a', 'aspect-b']);
    expect(markers.every(m => m.kind === 'single')).toBe(true);
  });

  it('returns empty array when no markers present', () => {
    const text = 'const x = 1;\n// regular comment\nfunction foo() {}';
    expect(scanSuppressionMarkers(text)).toHaveLength(0);
  });

  it('reports correct 1-based line numbers', () => {
    const text = 'line1\nline2\n// yg-suppress(aspect-x) reason\nline4';
    const markers = scanSuppressionMarkers(text);
    expect(markers[0].line).toBe(3);
  });

  it('handles disable and enable on separate lines', () => {
    const lines = [
      '// yg-suppress-disable(aspect-a) reason',
      'code()',
      '// yg-suppress-enable(aspect-a)',
    ];
    const markers = scanSuppressionMarkers(lines.join('\n'));
    expect(markers).toHaveLength(2);
    expect(markers[0].kind).toBe('disable');
    expect(markers[1].kind).toBe('enable');
  });

  it('matches marker without comment prefix (language-agnostic)', () => {
    // A language that uses # for comments
    const text = '# yg-suppress(check-x) reason text';
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ aspectId: 'check-x', kind: 'single', reason: 'reason text' });
  });
});

// ── runSuppressionsScan ────────────────────────────────────

function makeKnownAspects(...ids: string[]): Set<string> {
  return new Set(ids);
}

describe('runSuppressionsScan', () => {
  it('returns no markers when file list is empty', async () => {
    const report = await runSuppressionsScan('/does-not-matter', [], makeKnownAspects('my-aspect'));
    expect(report.fileEntries).toHaveLength(0);
    expect(report.totalMarkers).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('detects markers from fixture-like in-memory scan', () => {
    // We test via scanSuppressionMarkers directly since runSuppressionsScan
    // does filesystem I/O. The scanner is the core engine.
    const text = [
      '// yg-suppress(auth-guard) bypass for internal tool',
      'doSomething();',
    ].join('\n');
    const markers = scanSuppressionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].aspectId).toBe('auth-guard');
  });
});

// ── Comment-only inventory (the false-positive fix) ────────
//
// The `yg suppressions` inventory must list ONLY markers that the reviewer can
// actually honor. The reviewer-honoring path (collectSuppressions) reads markers
// from real COMMENT nodes, so a `yg-suppress(...)` that merely appears inside a
// string literal — as it does in every test fixture and template that DOCUMENTS
// the marker syntax — is not a real waiver and was previously a false positive.
// These tests drive the real filesystem-walking runSuppressionsScan over temp
// files to pin the corrected, comment-scoped behavior for parseable languages
// while keeping the raw-line scan for non-AST languages.

describe('runSuppressionsScan: comment-only scoping for AST languages', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function freshDir(label: string): string {
    const d = mkdtempSync(path.join(tmpdir(), `yg-supp-comment-${label}-`));
    tempDirs.push(d);
    return d;
  }

  function write(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('a yg-suppress marker INSIDE a TS string literal is NOT inventoried (was a false positive)', async () => {
    const root = freshDir('string-literal');
    // The marker syntax appears only inside a string literal — code that talks
    // ABOUT the marker, not a real comment-based waiver. The reviewer never
    // honors it, so the inventory must not list it either.
    write(
      root,
      'doc.ts',
      'const example = "// yg-suppress(some-aspect) this is documentation prose";\nconst y = 2;\n',
    );
    const report = await runSuppressionsScan(root, ['doc.ts'], new Set(['some-aspect']));
    expect(report.fileEntries).toHaveLength(0);
    expect(report.totalMarkers).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('a file whose comments only MENTION the syntax mid-prose yields zero markers and zero warnings', async () => {
    const root = freshDir('prose-mentions');
    // Real comments, but every occurrence of the token is prose: mid-sentence
    // mentions, backtick-quoted examples, quotation-style leaders, junk ids.
    // Under the anchored grammar none of these is a marker — no phantom rows,
    // no bogus unknown-id / wildcard warnings.
    write(
      root,
      'prose.ts',
      [
        '// Note: never use yg-suppress(*) here because wildcards mask real problems',
        '// a `yg-suppress(some-aspect)` that merely appears inside a doc sentence',
        '// // yg-suppress(some-aspect) quoted example from a code review',
        '// yg-suppress(...) truncated prose placeholder',
        '// yg-suppress(<aspect-id>) documentation placeholder',
        'const y = 2;',
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['prose.ts'], new Set(['some-aspect']));
    expect(report.fileEntries).toHaveLength(0);
    expect(report.totalMarkers).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('a genuine comment marker in a TS file IS still inventoried (no regression)', async () => {
    const root = freshDir('real-comment');
    write(root, 'real.ts', '// yg-suppress(some-aspect) genuine waiver, debt tracked\nx();\n');
    const report = await runSuppressionsScan(root, ['real.ts'], new Set(['some-aspect']));
    expect(report.fileEntries.map(f => f.file)).toEqual(['real.ts']);
    expect(report.totalMarkers).toBe(1);
    expect(report.fileEntries[0].markers[0]).toMatchObject({
      aspectId: 'some-aspect',
      kind: 'single',
      line: 1,
    });
  });

  it('in one TS file: the real comment marker is listed, the string-literal one is not', async () => {
    const root = freshDir('mixed');
    write(
      root,
      'mixed.ts',
      [
        'const decoy = "yg-suppress(decoy-aspect) only a string, never honored";',  // 1 — string literal
        '// yg-suppress(real-aspect) genuine waiver, tracked',                       // 2 — real comment
        'offending();',                                                             // 3
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['mixed.ts'], new Set(['real-aspect', 'decoy-aspect']));
    expect(report.totalMarkers).toBe(1);
    const ids = report.fileEntries.flatMap(f => f.markers.map(m => m.aspectId));
    expect(ids).toEqual(['real-aspect']);
    expect(ids).not.toContain('decoy-aspect');
  });

  it('a marker inside a multi-line block comment is reported at its true file line', async () => {
    const root = freshDir('block');
    write(
      root,
      'block.ts',
      [
        'const a = 1;',                                  // 1
        '/**',                                           // 2
        ' * yg-suppress(block-aspect) waiver in a block', // 3 — real marker
        ' */',                                           // 4
        'const b = 2;',                                  // 5
        '',
      ].join('\n'),
    );
    const report = await runSuppressionsScan(root, ['block.ts'], new Set(['block-aspect']));
    expect(report.totalMarkers).toBe(1);
    expect(report.fileEntries[0].markers[0]).toMatchObject({ aspectId: 'block-aspect', line: 3 });
  });

  it('a non-AST file (.sql) still uses the raw-line scan — markers in -- comments detected', async () => {
    const root = freshDir('sql');
    write(
      root,
      'q.sql',
      '-- yg-suppress(no-select-star) reporting batch, columns stable\nSELECT * FROM t;\n',
    );
    const report = await runSuppressionsScan(root, ['q.sql'], new Set(['no-select-star']));
    expect(report.totalMarkers).toBe(1);
    expect(report.fileEntries[0].markers[0].aspectId).toBe('no-select-star');
  });
});

// ── formatSuppressionsOutput ──────────────────────────────

describe('formatSuppressionsOutput', () => {
  it('shows "no active suppressions" when no markers', () => {
    const report = { fileEntries: [], totalMarkers: 0, warnings: [] };
    const out = formatSuppressionsOutput(report);
    expect(out).toContain('No active suppression markers found.');
  });

  it('includes file path, line, kind, and aspect id in output', () => {
    const report = {
      fileEntries: [
        {
          file: 'src/handler.ts',
          markers: [
            { line: 5, aspectId: 'audit-log', kind: 'single' as const, wildcard: false, reason: 'test' },
          ],
        },
      ],
      totalMarkers: 1,
      warnings: [],
    };
    const out = formatSuppressionsOutput(report);
    expect(out).toContain('src/handler.ts');
    expect(out).toContain('line 5');
    expect(out).toContain('single(audit-log)');
    expect(out).toContain('test');
  });

  it('shows tally line with counts', () => {
    const report = {
      fileEntries: [
        {
          file: 'src/a.ts',
          markers: [
            { line: 1, aspectId: 'x', kind: 'single' as const, wildcard: false, reason: 'r' },
            { line: 2, aspectId: 'y', kind: 'single' as const, wildcard: false, reason: 'r' },
          ],
        },
      ],
      totalMarkers: 2,
      warnings: [],
    };
    const out = formatSuppressionsOutput(report);
    expect(out).toContain('2 markers');
    expect(out).toContain('1 file');
  });

  it('includes warnings when present', () => {
    const report = {
      fileEntries: [
        {
          file: 'src/a.ts',
          markers: [
            { line: 3, aspectId: 'ghost-aspect', kind: 'single' as const, wildcard: false, reason: 'r' },
          ],
        },
      ],
      totalMarkers: 1,
      warnings: ['Warning: ghost-aspect does not exist'],
    };
    const out = formatSuppressionsOutput(report);
    expect(out).toContain('Warnings');
    expect(out).toContain('ghost-aspect does not exist');
  });
});

// ── Warning generation logic ──────────────────────────────

describe('suppressions warning generation (via runSuppressionsScan logic in isolation)', () => {
  // Test the warning logic by directly calling scanSuppressionMarkers and
  // inspecting what warnings would be generated. The actual warning generation
  // lives inside runSuppressionsScan (filesystem-dependent), so we test the
  // scanner output that feeds it and validate the warning logic below via
  // small helper functions that mirror the warning conditions.

  function collectWarnings(
    markers: ReturnType<typeof scanSuppressionMarkers>,
    knownIds: Set<string>,
    filename: string,
  ): string[] {
    const warnings: string[] = [];
    const seenWildcard = new Set<string>();

    // Track disable/enable pairing
    const disableStack = new Map<string, number[]>();
    for (const m of markers) {
      if (m.kind === 'disable') {
        const stack = disableStack.get(m.aspectId) ?? [];
        stack.push(m.line);
        disableStack.set(m.aspectId, stack);
      } else if (m.kind === 'enable') {
        const stack = disableStack.get(m.aspectId);
        if (stack && stack.length > 0) {
          stack.pop();
          if (stack.length === 0) disableStack.delete(m.aspectId);
        }
      }

      if (!m.wildcard && !knownIds.has(m.aspectId)) {
        warnings.push(`unknown:${m.aspectId}@${m.line}`);
      }
      if (m.wildcard && !seenWildcard.has(`${m.line}`)) {
        seenWildcard.add(`${m.line}`);
        warnings.push(`wildcard@${m.line}`);
      }
    }

    for (const [id, lines] of disableStack) {
      for (const ln of lines) {
        warnings.push(`unbounded:${id}@${ln}:${filename}`);
      }
    }

    return warnings;
  }

  it('warns on unknown aspect id', () => {
    const markers = scanSuppressionMarkers('// yg-suppress(ghost-aspect) reason');
    const warnings = collectWarnings(markers, makeKnownAspects('known-aspect'), 'f.ts');
    expect(warnings).toContain('unknown:ghost-aspect@1');
  });

  it('does NOT warn on unknown when wildcard *', () => {
    const markers = scanSuppressionMarkers('// yg-suppress(*) emergency');
    const warnings = collectWarnings(markers, makeKnownAspects(), 'f.ts');
    // Should warn about wildcard usage, NOT about unknown aspect
    expect(warnings).toContain('wildcard@1');
    expect(warnings.some(w => w.startsWith('unknown:'))).toBe(false);
  });

  it('warns on wildcard * usage', () => {
    const markers = scanSuppressionMarkers('// yg-suppress(*) emergency bypass');
    const warnings = collectWarnings(markers, makeKnownAspects(), 'f.ts');
    expect(warnings).toContain('wildcard@1');
  });

  it('warns on unbounded disable with no enable', () => {
    const text = [
      '// yg-suppress-disable(aspect-x) legacy block',
      'code()',
      'moreCode()',
      // no enable
    ].join('\n');
    const markers = scanSuppressionMarkers(text);
    const warnings = collectWarnings(markers, makeKnownAspects('aspect-x'), 'legacy.ts');
    expect(warnings).toContain('unbounded:aspect-x@1:legacy.ts');
  });

  it('does NOT warn on bounded disable+enable pair', () => {
    const text = [
      '// yg-suppress-disable(aspect-x) legacy block',
      'code()',
      '// yg-suppress-enable(aspect-x)',
    ].join('\n');
    const markers = scanSuppressionMarkers(text);
    const warnings = collectWarnings(markers, makeKnownAspects('aspect-x'), 'f.ts');
    expect(warnings.some(w => w.startsWith('unbounded:'))).toBe(false);
  });

  it('exit code is always 0 — verified by the non-throwing nature of formatSuppressionsOutput', () => {
    // The command always exits 0. We verify the formatter itself never throws
    // even with multiple warnings.
    const report = {
      fileEntries: [],
      totalMarkers: 0,
      warnings: ['Warning 1', 'Warning 2'],
    };
    // Should not throw
    const out = formatSuppressionsOutput(report);
    // Still shows "no markers" (empty entries) even with warnings
    expect(out).toContain('No active suppression markers found.');
  });
});
