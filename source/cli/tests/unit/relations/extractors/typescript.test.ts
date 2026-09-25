import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { typescriptExtractor, sfcScriptView } from '../../../../src/relations/extractors/typescript.js';

const run = (code: string, ext = '.ts', lang = 'typescript') =>
  runExtractor(typescriptExtractor, lang, ext, code);

describe('typescript extractor — uses()', () => {
  it('detects relative ESM imports as path hints', async () => {
    const { uses } = await run(`import { svc } from './svc';\nimport * as u from '../util/u';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './svc' }], kind: 'import' }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: '../util/u' }] }),
    );
  });
  it('drops scheme specifiers (node builtins, URLs) and hands bare ones to the resolver', async () => {
    // A bare specifier may be a tsconfig alias or an in-repo workspace package, so the
    // resolver decides; a `node:`/`https:` specifier never names a repository file.
    const { uses } = await run(`import path from 'node:path';\nimport { z } from 'zod';\nimport u from 'https://x.dev/u.js';`);
    expect(uses.map((u) => u.candidates[0])).toEqual([{ kind: 'path', specifier: 'zod' }]);
  });
  it('gives whole-statement import type its edge (a type-only import is a dependency)', async () => {
    const { uses } = await run(`import type { T } from './t';\nimport { a } from './ab';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './t' }], line: 1 }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ab' }] }),
    );
  });
  it('detects re-exports with a source (not local exports)', async () => {
    const { uses } = await run(
      `export { re } from './reexp';\nexport * from './star';\nexport const local = 1;`,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './reexp' }] }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './star' }] }),
    );
    expect(uses).toHaveLength(2);
  });
  it('detects require() and import-equals-require', async () => {
    const { uses } = await run(`const a = require('./a');\nimport b = require('./b');`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './a' }] }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './b' }] }),
    );
  });
  it('detects literal dynamic import, skips non-literal', async () => {
    const { uses } = await run(
      "const d = import('./d');\nconst e = import(`./x-${v}`);\nconst f = import(v);",
    );
    expect(uses.filter((u) => u.candidates[0].kind === 'path')).toHaveLength(1);
    expect(uses[0].candidates[0]).toEqual({ kind: 'path', specifier: './d' });
  });
  it('detects a no-substitution template-literal dynamic import() and require(), still skips interpolated', async () => {
    // A backtick specifier with no `${…}` is static and statically resolvable — TS/esbuild/Node
    // treat it identically to a quoted string — so it must yield an edge. An INTERPOLATED
    // template literal stays non-static and skipped.
    const { uses } = await run(
      'const a = import(`./a`);\nconst b = require(`./b`);\nconst c = import(`./x-${v}`);',
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './a' }] }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './b' }] }),
    );
    expect(uses.filter((u) => u.candidates[0].kind === 'path')).toHaveLength(2);
  });
  it('javascript: detects require + import, no crash on no-type-syntax', async () => {
    const { uses } = await run(`import x from './x';\nconst y = require('./y');`, '.js', 'javascript');
    expect(uses).toHaveLength(2);
  });
  it('gives a whole-statement namespace type import its edge (`import type * as T from ...`)', async () => {
    const { uses } = await run(`import type * as T from './t';\nimport { a } from './ab';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './t' }], line: 1 }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ab' }] }),
    );
  });
  it('keeps an inline-type import that still has a runtime binding (`import { type A, b }`)', async () => {
    // The `type` modifier sits inside the specifier, not as a statement-level token,
    // so the statement is NOT a whole-statement type import and must be kept.
    const { uses } = await run(`import { type A, b } from './m';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './m' }] }),
    );
  });

  it('gives a whole-statement export type re-export its edge (`export type { X } from`)', async () => {
    // `export type { X } from './m'` republishes a type of ./m: this module's surface
    // depends on it, so it is a dependency like a value re-export.
    const { uses } = await run(`export type { X } from './typeonly';\nexport { v } from './value';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './typeonly' }], line: 1 }),
    );
    // The value re-export on the next line is unaffected.
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './value' }] }),
    );
  });

  it('gives an all-inline-type named import its edge (`import { type A, type B } from`)', async () => {
    const { uses } = await run(`import { type A, type B } from './alltype';`);
    expect(uses.map((u) => u.candidates[0])).toEqual([{ kind: 'path', specifier: './alltype' }]);
  });

  it('gives an all-inline-type named export its edge (`export { type A, type B } from`)', async () => {
    const { uses } = await run(`export { type A, type B } from './alltype';`);
    expect(uses.map((u) => u.candidates[0])).toEqual([{ kind: 'path', specifier: './alltype' }]);
  });

  it('gives `export type * from` and `export type * as ns from` their edges', async () => {
    const { uses } = await run(`export type * from './a';\nexport type * as ns from './b';`);
    expect(uses.map((u) => [u.candidates[0], u.line])).toEqual([
      [{ kind: 'path', specifier: './a' }, 1],
      [{ kind: 'path', specifier: './b' }, 2],
    ]);
  });

  it('KEEPS a mixed inline-type export re-export (`export { type A, b } from`)', async () => {
    // `b` is a runtime re-export → exactly one edge survives.
    const { uses } = await run(`export { type A, b } from './mixed';`);
    expect(
      uses.filter((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './mixed'),
    ).toHaveLength(1);
  });

  it('KEEPS an all-inline-type import that still has a default binding (`import def, { type A } from`)', async () => {
    // The default `def` is a runtime binding even though every named specifier is type-only.
    const { uses } = await run(`import def, { type A } from './withdefault';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './withdefault' }] }),
    );
  });

  it('KEEPS a namespace export re-export (`export * as ns from`) — never type-only', async () => {
    // `export type * as` is not valid TS; a namespace re-export is always a runtime edge.
    const { uses } = await run(`export * as ns from './ns';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ns' }] }),
    );
  });

  it('KEEPS an empty re-export clause (`export {} from`) — not provably type-only', async () => {
    // Zero specifiers: not provably a type-only construct, so the edge is conservatively kept.
    const { uses } = await run(`export {} from './empty';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './empty' }] }),
    );
  });

  it('deduplicates two require() calls for the same module on one line', async () => {
    const { uses } = await run(`const a = require('./a'); const b = require('./a');`);
    expect(
      uses.filter((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './a'),
    ).toHaveLength(1);
  });
  it('ignores ordinary calls and member calls that merely take a string argument', async () => {
    // `foo('./x')` (plain identifier callee, not `require`) and `obj.method('./x')`
    // (member-expression callee) are neither dynamic import nor require → no edge.
    const { uses } = await run(`foo('./x');\nobj.method('./y');`);
    expect(uses).toHaveLength(0);
  });
  it('emits nothing for a dynamic import of the empty string literal', async () => {
    // `import('')` yields an empty specifier (the string node has no string_fragment);
    // the emit guard drops the empty / non-relative specifier.
    const { uses } = await run(`const d = import('');`);
    expect(uses).toHaveLength(0);
  });
  it('emits nothing for a require with no arguments', async () => {
    // `require()` has an empty argument list → firstArgument is null → no edge.
    const { uses } = await run(`const x = require();`);
    expect(uses).toHaveLength(0);
  });
});

describe('typescript extractor — one type-only rule, new forms, grammar recovery', () => {
  it('gives `import type X = require()` and an import() in any type position an edge, like value positions', async () => {
    const { uses } = await run(
      [
        `import type B = require('./b');`,
        `type M = typeof import('./m');`,
        `let v: import('./t').T;`,
        `const w = {} as import('./t2').T;`,
        `const s = x satisfies import('./t3').T;`,
        `const f = vi.fn<() => typeof import('./t4')>();`,
        `function g<T extends import('./t5').T = import('./t6').T>() {}`,
        `const d = import('./value');`,
        `const e = (await import('./value2')) as import('./t7').T;`,
        `import C = require('./c');`,
      ].join('\n'),
    );
    expect(uses.map((u) => [(u.candidates[0] as { specifier: string }).specifier, u.line]).sort()).toEqual(
      [
        ['./b', 1],
        ['./m', 2],
        ['./t', 3],
        ['./t2', 4],
        ['./t3', 5],
        ['./t4', 6],
        ['./t5', 7],
        ['./t6', 7],
        ['./value', 8],
        ['./value2', 9],
        ['./t7', 9],
        ['./c', 10],
      ].sort(),
    );
  });

  it('a module augmentation names its module: relative always, bare only in a module file, never a wildcard', async () => {
    // Script file (no top-level import/export): a bare `declare module` is an ambient declaration.
    const script = await run(`declare module './m' { interface X { a: 1 } }\ndeclare module 'pkg' {}\ndeclare module '*.css';`);
    expect(script.uses.map((u) => [u.candidates[0], u.line])).toEqual([[{ kind: 'path', specifier: './m' }, 1]]);
    // Module file: a bare name is an augmentation of that module.
    const mod = await run(`declare module './m' { interface X { a: 1 } }\ndeclare module 'pkg' {}\ndeclare module '*.css';\nexport {};`);
    expect(mod.uses.map((u) => [u.candidates[0], u.line])).toEqual([
      [{ kind: 'path', specifier: './m' }, 1],
      [{ kind: 'path', specifier: 'pkg' }, 2],
    ]);
  });

  it('emits `new URL(lit, import.meta.url)` only for a literal import.meta.url base; a bare name is made relative', async () => {
    const { uses } = await run(
      `new URL('./a.wasm', import.meta.url);\nnew URL('b.js', import.meta.url);\nnew URL('./c.js', base);\nnew URL('https://x.dev/', import.meta.url);\nnew URL(\`./d-\${n}.js\`, import.meta.url);`,
    );
    expect(uses.map((u) => u.candidates[0])).toEqual([
      { kind: 'path', specifier: './a.wasm' },
      { kind: 'path', specifier: './b.js' },
    ]);
  });

  it('recovers re-exports with attributes, which the shipped grammar turns into ERROR, at their own lines', async () => {
    const { uses } = await run(
      `import { A } from './a';\nexport {\n  B,\n} from './b' with { type: 'json' };\nexport * from './star' with { type: 'json' };\nimport C = require('./c');`,
    );
    expect(uses.map((u) => [u.candidates[0], u.line])).toEqual(
      expect.arrayContaining([
        [{ kind: 'path', specifier: './a' }, 1],
        [{ kind: 'path', specifier: './b' }, 2],
        [{ kind: 'path', specifier: './star' }, 5],
        [{ kind: 'path', specifier: './c' }, 6],
      ]),
    );
    expect(uses).toHaveLength(4);
  });

  it('recovery keeps the type-only rule: a recovered `export type` or all-`type` clause gives its edge', async () => {
    const { uses } = await run(
      `export type { B } from './b' with { type: 'json' };\nexport { type C, type D } from './cd' with { type: 'json' };\nexport { type F, g } from './fg' with { type: 'json' };`,
    );
    expect(uses.map((u) => u.candidates[0])).toEqual([
      { kind: 'path', specifier: './b' },
      { kind: 'path', specifier: './cd' },
      { kind: 'path', specifier: './fg' },
    ]);
  });

  it('recovery reads only line-anchored statement text: a commented import inside an ERROR region is not one', async () => {
    // The ERROR region spans all four rows; row 2 is a comment. The clause text of the
    // export itself holds a comment too, so the recovery pattern (which admits only
    // clause characters) does not guess across it: a missed edge, never a wrong one.
    const { uses } = await run(`export {\n  // import { A } from './commented';\n  a,\n} from './real' with { type: 'json' };`);
    expect(uses.some((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './commented')).toBe(false);
  });

  it('a clean parse never runs recovery (no ERROR rows)', async () => {
    // A template literal holding a line-anchored import is not re-read when the tree is clean.
    const { uses } = await run('const s = `\nimport z from \'./tpl\'\n`;');
    expect(uses).toHaveLength(0);
  });
});

describe('sfcScriptView', () => {
  it('blanks everything outside script bodies, keeps line numbers, picks the grammar from lang', () => {
    const vue = sfcScriptView('c/P.vue', '<template>\n  <a/>\n</template>\n<script setup lang="ts">\nimport x from \'./x\';\n</script>\n');
    expect(vue?.language).toBe('typescript');
    expect(vue?.parsePath).toBe('c/P.vue.ts');
    expect(vue?.content.split('\n')[4]).toBe("import x from './x';");
    expect(vue?.content.split('\n')).toHaveLength(7);
    expect(vue?.content).not.toContain('template');
    expect(sfcScriptView('c/B.svelte', '<script>\nimport a from "./a";\n</script>')?.language).toBe('javascript');
    expect(sfcScriptView('c/T.vue', '<script lang="tsx">\n</script><script>\n</script>')?.language).toBe('tsx');
    expect(sfcScriptView('c/N.vue', '<template><a/></template>')).toBeNull();
    expect(sfcScriptView('c/x.ts', '<script></script>')).toBeNull();
  });
});

describe('typescript extractor — declarations()', () => {
  it('returns top-level class/interface/function names', async () => {
    const { declarations } = await run(`export class Foo {}\ninterface Bar {}\nfunction baz(){}`);
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('Bar');
    expect(keys).toContain('baz');
  });
  it('does NOT return a class nested inside a function body', async () => {
    const { declarations } = await run(`function outer(){ class Inner {} }`);
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('outer');
    expect(keys).not.toContain('Inner');
  });
  it('does NOT return a class exported inside a namespace block (not program top level)', async () => {
    // The class is wrapped in an export_statement whose parent is the namespace body,
    // not `program` — isTopLevel rejects it via the grandparent check.
    const { declarations } = await run(`namespace N { export class Inner {} }`);
    expect(declarations.map((d) => d.symbolKey)).not.toContain('Inner');
  });
});
