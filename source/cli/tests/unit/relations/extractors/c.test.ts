import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { cExtractor } from '../../../../src/relations/extractors/c.js';
import {
  evalPreprocessorCondition,
  deadPreprocessorLines,
} from '../../../../src/relations/extractors/c-cpp-shared.js';

const run = (code: string, ext = '.c') => runExtractor(cExtractor, 'c', ext, code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

describe('C extractor — uses()', () => {
  it('emits a path hint for a quoted #include (the header path text, no quotes)', async () => {
    const { uses } = await run('#include "db/connection.h"\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [{ kind: 'path', specifier: 'db/connection.h' }],
        kind: 'import',
      }),
    );
  });

  it('emits a path hint for a relative quoted include verbatim', async () => {
    const { uses } = await run('#include "../inc/foo.h"\n');
    expect(specs(uses)).toEqual(['../inc/foo.h']);
  });

  it('emits an angle include as `<name>` (resolved only under a compile database -I root)', async () => {
    const { uses } = await run('#include <stdio.h>\n#include <stdlib.h>\n');
    expect(specs(uses)).toEqual(['<stdio.h>', '<stdlib.h>']);
  });

  it('does NOT emit a hint for a macro include (#include HDR — no literal path)', async () => {
    const { uses } = await run('#include HDR\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('keeps quoted and angle includes apart when they are mixed', async () => {
    const { uses } = await run('#include <stdio.h>\n#include "a.h"\n#include <string.h>\n#include "b/c.h"\n');
    expect(specs(uses)).toEqual(['<stdio.h>', 'a.h', '<string.h>', 'b/c.h']);
  });

  it('reports the line of each include', async () => {
    const { uses } = await run('\n\n#include "x.h"\n');
    expect(uses[0]?.line).toBe(3);
  });

  it('also extracts includes from a .h header (the .h grammar is C)', async () => {
    const { uses } = await run('#include "shared.h"\n', '.h');
    expect(specs(uses)).toEqual(['shared.h']);
  });

  it('emits nothing for an empty quoted include (#include "") — the bare "" yields no path', async () => {
    // The `path` string_literal has no string_content child; the fallback strips the
    // two quote chars to '' (c-cpp-shared text-length>=2 branch), which the emitter
    // discards (headerPath === '').
    const { uses } = await run('#include ""\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('dedupes two identical includes that share the same source line', async () => {
    // Two `#include "a.h"` directives on ONE physical line collide on the dedup key
    // `<path> <line>` (same path, same line) → only the first is emitted (the
    // seen-set hit branch in c-cpp-shared).
    const { uses } = await run('#include "a.h" #include "a.h"\n');
    expect(specs(uses)).toEqual(['a.h']);
  });
});

describe('C extractor — declarations()', () => {
  it('returns top-level function, struct, and typedef names', async () => {
    const { declarations } = await run(
      'int do_thing(void) { return 1; }\nchar *make(void) { return 0; }\nstruct Point { int x; };\ntypedef int my_int;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('do_thing');
    expect(keys).toContain('make'); // pointer-return function: name behind pointer_declarator
    expect(keys).toContain('Point');
    expect(keys).toContain('my_int');
  });

  it('emits no symbol for a function whose declarator never reaches a function_declarator', async () => {
    // `int (void) { ... }` parses as a function_definition whose declarator chain is a
    // parenthesized_declarator that drills to null before any function_declarator — so
    // functionName() returns undefined (no name to emit) and a real, named neighbour is
    // still captured. Exercises the declarator===null branch.
    const { declarations } = await run('int (void) { return 0; }\nint named(void) { return 1; }\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('named');
    // The anonymous/abstract function produced no symbol of its own.
    expect(keys).not.toContain('void');
  });
});

describe('C extractor — header names and dead branches', () => {
  it('reads the raw header name, so backslashes are not escape sequences', async () => {
    const { uses } = await run('#include "..\\lib\\hdr\\a.h"\n');
    expect(specs(uses)).toEqual(['..\\lib\\hdr\\a.h']);
  });

  it('drops includes under constant-false conditions and keeps unknown ones', async () => {
    const src = [
      '#if (0)', '#include "a.h"', '#endif',           // 1-3 dead
      '#if 0 && FOO', '#include "b.h"', '#endif',      // 4-6 dead (short-circuit)
      '#if FOO', '#include "c.h"', '#endif',           // 7-9 live (unknown)
      '#if 1', '#else', '#include "d.h"', '#endif',    // 10-13 dead (#else of a taken #if)
      '#if defined(X) || 0', '#include "e.h"', '#endif', // 14-16 live
    ].join('\n');
    const { uses } = await run(src);
    expect(specs(uses)).toEqual(['c.h', 'e.h']);
  });

  it('falls back to the text scan when __has_include flattens the chain', async () => {
    const src = ['#if __has_include("x.h")', '#include "x.h"', '#elif 0', '#include "dead.h"', '#endif', ''].join('\n');
    const { uses } = await run(src);
    expect(specs(uses)).toEqual(['x.h']);
  });
});

describe('evalPreprocessorCondition', () => {
  it.each([
    ['0', 0], ['(0)', 0], ['false', 0], ['true', 1], ['!1', 0], ['0x0', 0], ['0UL', 0],
    ['1 + 1 == 2', 1], ['2 > 3', 0], ['0 && FOO', 0], ['FOO && 0', 0], ['1 || FOO', 1],
    ['1 ? 0 : 1', 0], ["1'000 - 1000", 0], ['010', 8], ['0b11', 3],
    ['~0 == -1', 1], ['-1 + 1', 0], ['+0', 0], ['3 | 4', 7], ['3 ^ 1', 2], ['3 & 4', 0],
    ['1 != 1', 0], ['1 < 2', 1], ['2 <= 1', 0], ['2 >= 2', 1], ['1 << 2', 4], ['8 >> 1', 4],
    ['2 * 3 - 6', 0], ['7 % 7', 0], ['6 / 3 - 2', 0], ['FOO ? 1 : 1', 1], ['0 || 0', 0],
    ['defined(A) && 0', 0], ['  0  ', 0],
  ])('%s → %s', (expr, value) => {
    expect(evalPreprocessorCondition(expr)).toBe(value);
  });

  it.each([
    'FOO', 'defined(FOO)', 'defined FOO', '__has_include("x.h")', '1 / 0', '1 % 0', 'FOO || 0', '(0', '0 0',
    "'a'", '', '   ', 'constructor', '!constructor', '1 ? 2', 'FOO ? 1 : 2', '__has_include(<x.h>', 'defined(X', '$', ')',
  ])(
    '%s → unknown',
    (expr) => {
      expect(evalPreprocessorCondition(expr)).toBeUndefined();
    },
  );
});

describe('deadPreprocessorLines', () => {
  it('marks the lines of a dead group, nested groups included', () => {
    const dead = deadPreprocessorLines(['#if 0', 'a', '#if FOO', 'b', '#endif', '#else', 'c', '#endif'].join('\n'));
    expect([...dead].sort((x, y) => x - y)).toEqual([2, 3, 4, 5]);
  });

  it('marks every group after a taken one', () => {
    const dead = deadPreprocessorLines(['#if FOO', 'a', '#elif 1', 'b', '#elifdef X', 'c', '#else', 'd', '#endif'].join('\n'));
    expect([...dead].sort((x, y) => x - y)).toEqual([6, 8]);
  });

  it('ignores directives inside comments and strings', () => {
    const dead = deadPreprocessorLines(['/*', '#if 0', '*/', 'x', 'const char *s = "#if 0";'].join('\n'));
    expect(dead.size).toBe(0);
  });

  it('joins backslash-continued directive lines', () => {
    const dead = deadPreprocessorLines(['#if 0 && \\', '  FOO', 'a', '#endif'].join('\n'));
    expect(dead.has(3)).toBe(true);
  });

  it('gives up (drops nothing) on an unbalanced structure', () => {
    expect(deadPreprocessorLines(['#if 0', 'a'].join('\n')).size).toBe(0);
    expect(deadPreprocessorLines(['#endif', '#if 0', 'a', '#endif'].join('\n')).size).toBe(0);
    expect(deadPreprocessorLines(['#else'].join('\n')).size).toBe(0);
  });
});
