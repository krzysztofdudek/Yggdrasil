// =============================================================================
// Unit — the `yg-suppressions/1` machine document.
//
// `yg suppressions --json` is a second view over one scan, beside the prose
// listing next door. `buildSuppressionsJson` is pure — no disk, no scan — so a
// literal `SuppressionsReport` is the whole input; these tests build one by
// hand and assert the document says exactly what the report says, plus the two
// facts the prose deliberately drops: a disable's own resolved span (`range`),
// and a warning's own code and subject aspect (`warningRecords`, alongside the
// unchanged rendered `warnings` strings).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { formatSuppressionsJson, SUPPRESSIONS_JSON_SCHEMA } from '../../../src/formatters/suppressions-json.js';
import { buildSuppressionsJson } from '../../../src/cli/suppressions.js';
import type { SuppressionsReport } from '../../../src/portal/api/suppress-scan.js';
import type { SuppressionMarkerInfo } from '../../../src/ast/suppress.js';

/** One marker, single-line by default — override for disable/enable/wildcard/etc. */
function marker(overrides: Partial<SuppressionMarkerInfo> = {}): SuppressionMarkerInfo {
  return {
    line: 1,
    aspectId: 'no-todo',
    kind: 'single',
    wildcard: false,
    reason: 'tracked in TICKET-1',
    ...overrides,
  };
}

/** An empty report — every case below starts here and adds one fact. */
function report(overrides: Partial<SuppressionsReport> = {}): SuppressionsReport {
  return {
    fileEntries: [],
    totalMarkers: 0,
    warnings: [],
    ...overrides,
  };
}

describe('buildSuppressionsJson — schema + empty report', () => {
  it('an empty report yields empty markers/warnings and zeroed totals, under the right schema', () => {
    const doc = buildSuppressionsJson(report());
    expect(doc.schema).toBe(SUPPRESSIONS_JSON_SCHEMA);
    expect(doc.schema).toBe('yg-suppressions/1');
    expect(doc.markers).toEqual([]);
    expect(doc.warnings).toEqual([]);
    expect(doc.totals).toEqual({ markers: 0, files: 0, fileLevel: 0 });
  });
});

describe('buildSuppressionsJson — one marker, kind and range', () => {
  it('a single marker: kind "single", range null', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src/a.ts', markers: [marker({ kind: 'single', line: 3 })] }],
        totalMarkers: 1,
      }),
    );
    expect(doc.markers).toHaveLength(1);
    expect(doc.markers[0]).toMatchObject({ kind: 'single', line: 3, range: null });
  });

  it('a single marker naming the wildcard "*" is still kind "single", with wildcard: true', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src/a.ts', markers: [marker({ kind: 'single', aspectId: '*', wildcard: true })] }],
        totalMarkers: 1,
      }),
    );
    expect(doc.markers[0]).toMatchObject({ kind: 'single', aspect: '*', wildcard: true, range: null });
  });

  it('a closed disable/enable pair: the disable carries the real {from,to}, the enable carries range: null', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [
          {
            file: 'src/b.ts',
            markers: [
              marker({ kind: 'disable', line: 5 }),
              marker({ kind: 'enable', line: 9, reason: '' }),
            ],
          },
        ],
        totalMarkers: 2,
        ranges: [{ file: 'src/b.ts', aspect: 'no-todo', from: 5, to: 9 }],
      }),
    );
    const [disable, enable] = doc.markers;
    expect(disable).toMatchObject({ kind: 'disable', line: 5, range: { from: 5, to: 9 } });
    expect(enable).toMatchObject({ kind: 'enable', line: 9, range: null });
  });

  it('an unclosed disable outside the file head: range {from, to: null}, kind stays "disable"', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src/c.ts', markers: [marker({ kind: 'disable', line: 12, atFileHead: false })] }],
        totalMarkers: 1,
        ranges: [{ file: 'src/c.ts', aspect: 'no-todo', from: 12, to: null }],
        // fileLevelKeys present but does NOT contain this marker's key.
        fileLevelKeys: new Set(),
      }),
    );
    expect(doc.markers[0]).toMatchObject({ kind: 'disable', line: 12, range: { from: 12, to: null } });
  });

  it('an unclosed disable whose key IS in fileLevelKeys: kind "file-level", range still {from, to: null}', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src/whole.ts', markers: [marker({ kind: 'disable', line: 1, atFileHead: true })] }],
        totalMarkers: 1,
        ranges: [{ file: 'src/whole.ts', aspect: 'no-todo', from: 1, to: null }],
        fileLevelKeys: new Set(['src/whole.ts:1']),
      }),
    );
    expect(doc.markers[0]).toMatchObject({ kind: 'file-level', line: 1, range: { from: 1, to: null } });
    expect(doc.totals.fileLevel).toBe(1);
  });
});

describe('buildSuppressionsJson — reason normalization', () => {
  it('an empty-string reason becomes null (never an empty string in the document)', () => {
    const doc = buildSuppressionsJson(
      report({ fileEntries: [{ file: 'src/a.ts', markers: [marker({ reason: '' })] }], totalMarkers: 1 }),
    );
    expect(doc.markers[0].reason).toBeNull();
  });

  it('a reason carrying unicode and a double quote passes through with only ordinary JSON escaping', () => {
    const reason = 'legacy "hack" — tracked in TICKET-łódź 🚀';
    const doc = buildSuppressionsJson(
      report({ fileEntries: [{ file: 'src/a.ts', markers: [marker({ reason })] }], totalMarkers: 1 }),
    );
    expect(doc.markers[0].reason).toBe(reason);
    // Round-trips through the actual renderer without any extra escaping beyond JSON's own.
    const parsed = JSON.parse(formatSuppressionsJson(doc)) as typeof doc;
    expect(parsed.markers[0].reason).toBe(reason);
  });
});

describe('buildSuppressionsJson — fileLevelKeys absent', () => {
  it('an absent fileLevelKeys (legacy literal report) yields zero file-level markers, no exception', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src/a.ts', markers: [marker({ kind: 'disable', line: 1, atFileHead: true })] }],
        totalMarkers: 1,
        // fileLevelKeys intentionally omitted.
      }),
    );
    expect(() => doc).not.toThrow();
    expect(doc.markers[0].kind).toBe('disable');
    expect(doc.totals.fileLevel).toBe(0);
  });
});

describe('buildSuppressionsJson — totals arithmetic', () => {
  it('totals.markers/files/fileLevel match the report on three files and seven markers', () => {
    const rep = report({
      fileEntries: [
        {
          file: 'src/a.ts',
          markers: [marker({ line: 1 }), marker({ line: 2, aspectId: 'no-console' })],
        },
        {
          file: 'src/b.ts',
          markers: [
            marker({ kind: 'disable', line: 1, atFileHead: true }),
            marker({ kind: 'disable', line: 10, aspectId: 'no-console', atFileHead: false }),
            marker({ kind: 'enable', line: 20, aspectId: 'no-console', reason: '' }),
          ],
        },
        {
          file: 'src/c.ts',
          markers: [marker({ line: 1, aspectId: '*', wildcard: true }), marker({ line: 2 })],
        },
      ],
      totalMarkers: 7,
      fileLevelKeys: new Set(['src/b.ts:1']),
      ranges: [
        { file: 'src/b.ts', aspect: 'no-todo', from: 1, to: null },
        { file: 'src/b.ts', aspect: 'no-console', from: 10, to: 20 },
      ],
    });
    const doc = buildSuppressionsJson(rep);
    expect(doc.markers).toHaveLength(7);
    expect(doc.totals).toEqual({ markers: 7, files: 3, fileLevel: 1 });
  });
});

describe('buildSuppressionsJson — warnings', () => {
  it('each of the four warning codes produces exactly one warningRecord entry, aspect null only on wildcard', () => {
    const rep = report({
      fileEntries: [{ file: 'src/a.ts', markers: [marker()] }],
      totalMarkers: 1,
      warnings: ['unknown msg', 'wildcard msg', 'unbounded msg', 'under msg'],
      warningRecords: [
        { code: 'unknown-aspect', file: 'src/a.ts', line: 1, aspect: 'ghost', message: 'unknown msg' },
        { code: 'wildcard', file: 'src/a.ts', line: 2, aspect: null, message: 'wildcard msg' },
        { code: 'unbounded-range', file: 'src/a.ts', line: 3, aspect: 'no-todo', message: 'unbounded msg' },
        { code: 'waives-under', file: 'src/a.ts', line: 4, aspect: 'no-console', message: 'under msg' },
      ],
    });
    const doc = buildSuppressionsJson(rep);
    expect(doc.warnings).toHaveLength(4);
    expect(doc.warnings.map((w) => w.code)).toEqual(['unknown-aspect', 'wildcard', 'unbounded-range', 'waives-under']);
    expect(doc.warnings[1].aspect).toBeNull();
    expect(doc.warnings[0].aspect).toBe('ghost');
    expect(doc.warnings[2].aspect).toBe('no-todo');
    expect(doc.warnings[3].aspect).toBe('no-console');
    expect(doc.warnings.map((w) => w.message)).toEqual(['unknown msg', 'wildcard msg', 'unbounded msg', 'under msg']);
  });

  it('an absent warningRecords (legacy literal report) yields an empty warnings array, no exception', () => {
    const doc = buildSuppressionsJson(
      report({ fileEntries: [], totalMarkers: 0, warnings: ['some prose warning'] }),
    );
    expect(doc.warnings).toEqual([]);
  });
});

describe('buildSuppressionsJson — path normalization', () => {
  it('a backslash path in the report literal renders POSIX in the document', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [{ file: 'src\\windows\\legacy.ts', markers: [marker({ kind: 'disable', line: 1 })] }],
        totalMarkers: 1,
        ranges: [{ file: 'src\\windows\\legacy.ts', aspect: 'no-todo', from: 1, to: null }],
      }),
    );
    expect(doc.markers[0].file).toBe('src/windows/legacy.ts');
    // The range lookup itself still resolves — normalization is only an OUTPUT
    // transform, matched consistently between fileEntries and ranges above.
    expect(doc.markers[0].range).toEqual({ from: 1, to: null });
  });

  it('a path with a space and unicode is left unchanged (already POSIX)', () => {
    const file = 'src/legacy módule/plik z spacją.ts';
    const doc = buildSuppressionsJson(
      report({ fileEntries: [{ file, markers: [marker()] }], totalMarkers: 1 }),
    );
    expect(doc.markers[0].file).toBe(file);
  });
});

describe('formatSuppressionsJson', () => {
  it('ends with exactly one trailing newline and parses back via JSON.parse', () => {
    const doc = buildSuppressionsJson(report());
    const out = formatSuppressionsJson(doc);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(out)).toEqual(doc);
  });

  it('a document cannot come out without a schema — it is always present, first, and equal to yg-suppressions/1', () => {
    const doc = buildSuppressionsJson(report());
    expect(Object.keys(doc)[0]).toBe('schema');
    const out = formatSuppressionsJson(doc);
    expect(out.startsWith('{\n  "schema": "yg-suppressions/1"')).toBe(true);
  });
});

describe('buildSuppressionsJson — nested same-aspect disable/enable pairs LIFO', () => {
  // Resolves the one open question the task spec flagged before `ranges` could
  // enter the contract: does the existing disable/enable stack (which already
  // decides UNBOUNDED-ness) pair a NESTED same-aspect disable/enable correctly
  // enough to also carry a per-marker (from,to) span? Closing binds to the most
  // recently opened marker — standard bracket-matching semantics, the only
  // sensible reading for nested ranges of the same aspect — so the inner pair
  // and the outer pair each resolve to their own correct, non-overlapping span.
  it('an inner disable/enable pair binds to its own nearer enable; the outer pair binds to the later, outer enable', () => {
    const doc = buildSuppressionsJson(
      report({
        fileEntries: [
          {
            file: 'src/nested.ts',
            markers: [
              marker({ kind: 'disable', line: 1 }), // outer open
              marker({ kind: 'disable', line: 5 }), // inner open (same aspect)
              marker({ kind: 'enable', line: 10, reason: '' }), // closes inner (LIFO)
              marker({ kind: 'enable', line: 15, reason: '' }), // closes outer
            ],
          },
        ],
        totalMarkers: 4,
        ranges: [
          { file: 'src/nested.ts', aspect: 'no-todo', from: 5, to: 10 },
          { file: 'src/nested.ts', aspect: 'no-todo', from: 1, to: 15 },
        ],
      }),
    );
    const disables = doc.markers.filter((m) => m.kind === 'disable');
    expect(disables.find((m) => m.line === 1)?.range).toEqual({ from: 1, to: 15 });
    expect(disables.find((m) => m.line === 5)?.range).toEqual({ from: 5, to: 10 });
  });
});
