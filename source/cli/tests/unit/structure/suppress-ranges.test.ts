/**
 * Unit tests for src/structure/suppress-ranges.ts — resolveSuppressedRangesForPrompt.
 *
 * These exercise the resolver DIRECTLY (in-process, no spawn, no LLM) so the two
 * parse strategies are pinned:
 *   - a non-grammar file (.sql / .md) takes the raw-line content-scan fallback
 *     (the `hasGrammar === false` branch — no tree-sitter parse), and a marker on
 *     its lines must still resolve to a suppressed range;
 *   - a grammar file (.ts) is parsed and its comment-node markers resolve;
 *   - a file with no applicable marker contributes no `byFile` entry, keeping the
 *     prompt byte-identical to the no-suppress case.
 */
import { describe, it, expect } from 'vitest';
import { resolveSuppressedRangesForPrompt } from '../../../src/structure/suppress-ranges.js';

describe('resolveSuppressedRangesForPrompt', () => {
  it('resolves a marker in a NON-grammar file via the raw-line content scan (.sql)', async () => {
    // .sql has no registered tree-sitter grammar → hasGrammar is false → the
    // resolver never calls parseFile and scans the raw lines instead. A
    // single-line marker on line 1 suppresses line 2.
    const sql = [
      '-- yg-suppress(my-rule) deliberate waiver for test',
      'SELECT * FROM users;',
      'SELECT 1;',
    ].join('\n');
    const result = await resolveSuppressedRangesForPrompt(
      [{ path: 'db/query.sql', bytes: Buffer.from(sql, 'utf8') }],
      'my-rule',
    );
    expect(result.byFile).toHaveLength(1);
    expect(result.byFile[0].path).toBe('db/query.sql');
    // Single-line marker on line 1 → waives line 2.
    expect(result.byFile[0].ranges).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  it('resolves a marker in another NON-grammar file (.md) via the content scan', async () => {
    const md = [
      '<!-- yg-suppress(doc-rule) waiver -->',
      'some content',
    ].join('\n');
    const result = await resolveSuppressedRangesForPrompt(
      [{ path: 'README.md', bytes: Buffer.from(md, 'utf8') }],
      'doc-rule',
    );
    expect(result.byFile).toHaveLength(1);
    expect(result.byFile[0].ranges).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  it('resolves a marker in a GRAMMAR file (.ts) via the parsed comment nodes', async () => {
    // .ts HAS a grammar → hasGrammar is true → parseFile runs and the marker is
    // read from the comment node, not the raw line.
    const ts = [
      '// yg-suppress(ts-rule) deliberate waiver for test',
      'export const a = 1;',
      'export const b = 2;',
    ].join('\n');
    const result = await resolveSuppressedRangesForPrompt(
      [{ path: 'src/svc.ts', bytes: Buffer.from(ts, 'utf8') }],
      'ts-rule',
    );
    expect(result.byFile).toHaveLength(1);
    expect(result.byFile[0].ranges).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  it('produces NO byFile entry for a file whose marker names a different aspect', async () => {
    // Marker scoped to other-rule; resolving for my-rule yields nothing → an empty
    // byFile (no <suppressed-ranges> block, prompt stays byte-identical).
    const sql = [
      '-- yg-suppress(other-rule) waiver',
      'SELECT 1;',
    ].join('\n');
    const result = await resolveSuppressedRangesForPrompt(
      [{ path: 'db/query.sql', bytes: Buffer.from(sql, 'utf8') }],
      'my-rule',
    );
    expect(result.byFile).toHaveLength(0);
  });

  it('honors a wildcard marker in a non-grammar file', async () => {
    // A `yg-suppress(*)` waives every aspect on the next line — resolving for an
    // arbitrary aspect id must include it.
    const sql = [
      '-- yg-suppress(*) blanket waiver',
      'SELECT 1;',
    ].join('\n');
    const result = await resolveSuppressedRangesForPrompt(
      [{ path: 'db/query.sql', bytes: Buffer.from(sql, 'utf8') }],
      'any-rule',
    );
    expect(result.byFile).toHaveLength(1);
    expect(result.byFile[0].ranges).toEqual([{ startLine: 2, endLine: 2 }]);
  });
});
