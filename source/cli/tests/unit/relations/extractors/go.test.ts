import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { goExtractor } from '../../../../src/relations/extractors/go.js';

const run = (code: string) => runExtractor(goExtractor, 'go', '.go', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

describe('go extractor — uses()', () => {
  it('detects a single `import "fmt"` as the import-path hint', async () => {
    const { uses } = await run('package main\nimport "fmt"\n');
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: 'fmt' }], kind: 'import' }),
    );
  });

  it('emits one hint per spec for a grouped import block', async () => {
    const { uses } = await run(
      'package main\nimport (\n  "a/b"\n  "c/d/e"\n)\n',
    );
    const s = specs(uses);
    expect(s).toContain('a/b');
    expect(s).toContain('c/d/e');
    expect(s).toHaveLength(2);
  });

  it('emits the package PATH for an aliased import (the alias is irrelevant)', async () => {
    const { uses } = await run('package main\nimport alias "c/d"\n');
    const s = specs(uses);
    expect(s).toContain('c/d');
    expect(s).not.toContain('alias');
  });

  it('emits the package PATH for a blank (side-effect) import `_ "drv"`', async () => {
    const { uses } = await run('package main\nimport _ "example.com/m/drv"\n');
    expect(specs(uses)).toContain('example.com/m/drv');
  });

  it('emits the package PATH for a dot-import `. "pkg"`', async () => {
    const { uses } = await run('package main\nimport . "example.com/m/pkg"\n');
    expect(specs(uses)).toContain('example.com/m/pkg');
  });

  it('handles a grouped block mixing plain / alias / blank / dot imports', async () => {
    const { uses } = await run(
      'package main\nimport (\n  "fmt"\n  pay "example.com/m/billing"\n  _ "example.com/m/driver"\n  . "example.com/m/dsl"\n)\n',
    );
    const s = specs(uses);
    expect(s).toEqual(
      expect.arrayContaining([
        'fmt',
        'example.com/m/billing',
        'example.com/m/driver',
        'example.com/m/dsl',
      ]),
    );
    expect(s).toHaveLength(4);
  });

  it('reads a raw-string (backtick) import path', async () => {
    const { uses } = await run('package main\nimport `example.com/m/raw`\n');
    expect(specs(uses)).toContain('example.com/m/raw');
  });

  it('reports the line of each import', async () => {
    const { uses } = await run('package main\n\nimport "fmt"\n');
    expect(uses[0]?.line).toBe(3);
  });

  it('emits NOTHING for an empty double-quoted import path', async () => {
    // `import ""` strips to '' — the emit guard discards an empty specifier. No edge.
    const { uses } = await run('package main\nimport ""\n');
    expect(uses).toHaveLength(0);
  });

  it('emits NOTHING for an empty backtick (raw-string) import path', async () => {
    // `import `` ` strips to '' — same empty-specifier guard, no edge.
    const { uses } = await run('package main\nimport ``\n');
    expect(uses).toHaveLength(0);
  });

  it('emits NOTHING for a degenerate (unterminated, sub-2-char) raw-string literal', async () => {
    // A truncated/mid-edit file where the raw-string literal never closes before
    // EOF: tree-sitter's ERROR recovery still yields an `import_spec` with a
    // `raw_string_literal` path node, but its `.text` is just the single opening
    // backtick (length 1) — under the 2-char delimiter-stripping floor, so the
    // path is read as '' rather than slicing into (or past) the delimiter itself.
    const { uses } = await run('package main\nimport `');
    expect(uses).toHaveLength(0);
  });

  it('deduplicates two identical import specs on the same line', async () => {
    // Two `"a/b"` specs starting on ONE line collide on the `<specifier> <line>` dedup
    // key — only one hint survives (the seen-set true-arm).
    const { uses } = await run('package main\nimport "a/b"; import "a/b"\n');
    expect(specs(uses)).toEqual(['a/b']);
  });
});

describe('go extractor — declarations()', () => {
  it('returns top-level type, function, and method names', async () => {
    const { declarations } = await run(
      'package main\ntype Foo struct{}\nfunc Bar() {}\nfunc (r Foo) Method() {}\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('Bar');
    expect(keys).toContain('Method');
  });

  it('returns each name in a grouped `type ( ... )` block', async () => {
    const { declarations } = await run(
      'package main\ntype (\n  A struct{}\n  B int\n)\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('A');
    expect(keys).toContain('B');
  });
});
