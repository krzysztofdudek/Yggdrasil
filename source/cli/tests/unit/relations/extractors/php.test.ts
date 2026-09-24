import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { phpExtractor } from '../../../../src/relations/extractors/php.js';

const run = (code: string) => runExtractor(phpExtractor, 'php', '.php', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

describe('php extractor — uses()', () => {
  it('emits the FQN for a simple use import', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\Gateway;\nclass C {}\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [{ kind: 'path', specifier: 'App\\Payment\\Gateway' }],
        kind: 'import',
      }),
    );
  });

  it('expands a grouped use into one FQN per imported class', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
  });

  it('records the real FQN, not the alias, for an aliased import', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\Gateway as G;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s).not.toContain('G');
    expect(s).not.toContain('App\\Payment\\G');
  });

  it('records the real FQN, not the alias, for an aliased clause in a grouped use', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund as R};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
    expect(s).not.toContain('App\\Payment\\R');
  });

  it('strips a leading backslash from a fully-qualified use', async () => {
    const { uses } = await run('<?php\nuse \\App\\Payment\\Gateway;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s.every((x) => !x.startsWith('\\'))).toBe(true);
  });

  it('skips function and const imports (not class dependencies)', async () => {
    const { uses } = await run(
      [
        '<?php',
        'use function App\\Util\\format;',
        'use const App\\Util\\MAX;',
        'class C {}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });

  it('emits a vendor/external import FQN unchanged (silencing is the resolver job)', async () => {
    const { uses } = await run('<?php\nuse Psr\\Log\\LoggerInterface;\nclass C {}\n');
    expect(specs(uses)).toContain('Psr\\Log\\LoggerInterface');
  });

  it('collects every import in a multi-import file', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace App\\App;',
        'use App\\A\\Alpha;',
        'use App\\B\\Beta;',
        'class C {}',
        '',
      ].join('\n'),
    );
    const s = specs(uses);
    expect(s).toContain('App\\A\\Alpha');
    expect(s).toContain('App\\B\\Beta');
  });

  it('handles a multi-clause single use (`use A\\X as P, B\\Y as Q;`) — both FQNs, no aliases', async () => {
    const { uses } = await run('<?php\nuse App\\A\\Alpha as X, App\\B\\Beta as Y;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\A\\Alpha');
    expect(s).toContain('App\\B\\Beta');
    expect(s).not.toContain('App\\A\\X');
    expect(s).not.toContain('App\\B\\Y');
  });

  it('resolves a nested qualified_name segment inside a grouped use (`{Inner\\Deep, Plain}`)', async () => {
    const { uses } = await run('<?php\nuse App\\Sub\\{Inner\\Deep, Plain};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Sub\\Inner\\Deep');
    expect(s).toContain('App\\Sub\\Plain');
  });

  it('skips a grouped function import (`use function Base\\{a, b};`)', async () => {
    // The `function` token sits as a DIRECT child of the declaration here, not on
    // the clause — the whole grouped declaration imports functions, not classes.
    const { uses } = await run('<?php\nuse function App\\Util\\{format, trim};\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('drops only the function clause in a mixed grouped use, keeping the class (`{function format, Gateway}`)', async () => {
    // Per-clause `function` token: the group mixes a function import and a class
    // import. Only the class is a dependency edge; the function must be silenced
    // without taking the class down with it.
    const { uses } = await run('<?php\nuse App\\Pkg\\{function format, Gateway};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\format');
    expect(s).toHaveLength(1);
  });

  it('drops the function clause regardless of its position in the group (`{Gateway, function format}`)', async () => {
    // Class-first ordering — guard must be evaluated per clause, not by position.
    const { uses } = await run('<?php\nuse App\\Pkg\\{Gateway, function format};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\format');
    expect(s).toHaveLength(1);
  });

  it('drops only the const clause in a mixed grouped use, keeping the class (`{const MAX, Gateway}`)', async () => {
    // Per-clause `const` token — same rule as `function`.
    const { uses } = await run('<?php\nuse App\\Pkg\\{const MAX, Gateway};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\MAX');
    expect(s).toHaveLength(1);
  });

  it('keeps both classes in a per-clause-typed group with no function/const clause (positive guard)', async () => {
    // POSITIVE / anti-over-silencing: a perfectly ordinary grouped class import
    // must still emit BOTH class hints. The per-clause guard must not silence
    // clauses that carry no function/const token.
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
    expect(s).toHaveLength(2);
  });

  it('deduplicates a class repeated in one grouped use on the same line (`{Foo, Foo}`)', async () => {
    const { uses } = await run('<?php\nuse App\\Pkg\\{Foo, Foo};\nclass C {}\n');
    // Same FQN, same line → one hint, not two.
    expect(specs(uses).filter((x) => x === 'App\\Pkg\\Foo')).toHaveLength(1);
  });

  it('emits nothing for a use whose only name is a bare backslash (`use \\;`)', async () => {
    // qualified_name text is "\\"; stripping the single leading backslash leaves the
    // empty string, which the emit guard rejects.
    const { uses } = await run('<?php\nuse \\;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('skips a trailing-comma error clause in a grouped use, keeping the valid one', async () => {
    // `use App\\{Foo, };` parses the dangling comma as an ERROR node that appears as a
    // named child of the group alongside the real clause; the non-clause child is skipped.
    const { uses } = await run('<?php\nuse App\\Grp\\{Foo, };\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Grp\\Foo');
    expect(s).toHaveLength(1);
  });

  it('emits inline LEADING-BACKSLASH class references in class-autoload positions (extends/implements/trait-use/new/static)', async () => {
    // A leading-`\` FQN is absolute (resolved from the global namespace, shadow-free), so an
    // inline reference in a class-autoload position is a real, zero-false-positive edge. The
    // resolver maps the FQN to a file by PSR-4 exactly as for an import.
    const { uses } = await run(
      [
        '<?php',
        'namespace App\\App;',
        'class C extends \\App\\Base\\Base implements \\App\\Flow\\Flowable {',
        '  use \\App\\Mixin\\Timestamps;',
        '  function m() {',
        '    $o = new \\App\\Metrics\\Timer();',
        '    \\App\\Audit\\AuditLog::record("x");',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const s = specs(uses);
    expect(s).toContain('App\\Base\\Base'); // extends
    expect(s).toContain('App\\Flow\\Flowable'); // implements
    expect(s).toContain('App\\Mixin\\Timestamps'); // in-body trait use
    expect(s).toContain('App\\Metrics\\Timer'); // new
    expect(s).toContain('App\\Audit\\AuditLog'); // static call scope
    expect(s).toHaveLength(5);
  });

  it('resolves a backslash-LESS (namespace-relative) class name from the current namespace', async () => {
    // PHP has no global fallback for class names, so `new Sub\\Rel()` in `namespace App\\App`
    // is App\\App\\Sub\\Rel — decided from the file alone; the resolver still needs the file.
    const { uses } = await run(
      ['<?php', 'namespace App\\App;', 'class C { function m() { $o = new Sub\\Rel(); } }', ''].join('\n'),
    );
    expect(specs(uses)).toEqual(['App\\App\\Sub\\Rel']);
  });

  it('translates a qualified name\'s first segment through a class import (case-insensitive)', async () => {
    const { uses } = await run(
      ['<?php', 'namespace App\\F1;', 'use App\\Model as M;', 'class C { function f(m\\Id $id) {} }', ''].join('\n'),
    );
    expect(specs(uses)).toEqual(['App\\Model', 'App\\Model\\Id']);
  });

  it('resolves `namespace\\X` against the current namespace', async () => {
    const { uses } = await run(['<?php', 'namespace App;', 'function f(): namespace\\Sub\\X {}', ''].join('\n'));
    expect(specs(uses)).toEqual(['App\\Sub\\X']);
  });

  it('skips imported unqualified names, keywords and built-in types, and global results', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace App\\Http;',
        'use App\\Model\\Id;',
        'class C extends Base {',
        '  function f(Id $a, self $b, mixed $c): static { return new Id(); }',
        '}',
        'namespace Other { }',
        '',
      ].join('\n'),
    );
    // The import carries Id; `Base` is App\\Http\\Base; self/mixed/static are not classes.
    expect(specs(uses)).toEqual(['App\\Model\\Id', 'App\\Http\\Base']);
    const global = await run(['<?php', 'class C extends Exception { function f() { new Sub\\X(); } }', ''].join('\n'));
    // In the global namespace an unqualified name may be a built-in → dropped; a qualified one is kept.
    expect(specs(global.uses)).toEqual(['Sub\\X']);
  });

  it('reads only the class operand of `::` and instanceof, never member names or functions', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace App;',
        'function g($x) { Foo::bar(); $a = Foo::BAR; $b = $x instanceof Sub\\Y; helper(); Sub\\helper(); $c = CONST_X; }',
        '',
      ].join('\n'),
    );
    expect(specs(uses)).toEqual(['App\\Foo', 'App\\Sub\\Y']);
  });

  it('skips a bare `namespace\\` and imports of functions or constants in the alias table', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace App;',
        'use function Lib\\helper;',
        'use Lib\\{function f, const C, Klass};',
        'class A extends helper\\X { function g(): Klass\\Y {} }',
        '',
      ].join('\n'),
    );
    // `helper` and `f` are function imports, so `helper\\X` is namespace-relative (App\\helper\\X);
    // `Klass` is a class import, so `Klass\\Y` translates through it.
    expect(specs(uses)).toEqual(['Lib\\Klass', 'App\\helper\\X', 'Lib\\Klass\\Y']);
  });

  it('keeps one import table per bracketed namespace block', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace A { use X\\Lib; class C extends Lib\\Base {} }',
        'namespace B { class D extends Lib\\Base {} }',
        '',
      ].join('\n'),
    );
    expect(specs(uses)).toEqual(['X\\Lib', 'X\\Lib\\Base', 'B\\Lib\\Base']);
  });

  it('emits a file-relative path for statically file-relative require/include', async () => {
    const { uses } = await run(
      [
        '<?php',
        "require_once __DIR__ . '/../lib/a.php';",
        'include dirname(__FILE__) . "/b.php";',
        "require dirname(__DIR__, 2) . '/c.php';",
        "include_once(dirname(__FILE__, 2) . '/d.php');",
        "require __dir__ . '/e.php';",
        '',
      ].join('\n'),
    );
    expect(specs(uses)).toEqual(['./../lib/a.php', './b.php', './../../c.php', './../d.php', './e.php']);
  });

  it('does NOT emit runtime-resolved or dynamic require paths', async () => {
    const { uses } = await run(
      [
        '<?php',
        "require 'lib/a.php';",
        "require __DIR__ . 'a.php';",
        'require __DIR__ . "/$name.php";',
        "require $base . '/a.php';",
        "require plugin_dir_path(__FILE__) . '/a.php';",
        "require dirname(__DIR__, $n) . '/a.php';",
        "require __DIR__ . '/a' . '/b.php';",
        "require __DIR__ . $x;",
        "require __DIR__ + '/a.php';",
        "require __DIR__ . '/a\\\\b.php';",
        "require dirname(__DIR__, 2, 3) . '/a.php';",
        "require dirname() . '/a.php';",
        "require dirname(__DIR__, 'x') . '/a.php';",
        "require dirname(__LINE__) . '/a.php';",
        "require dirname2(__DIR__) . '/a.php';",
        "require __FILE__ . '/a.php';",
        '',
      ].join('\n'),
    );
    expect(specs(uses)).toEqual([]);
  });

  it('does NOT emit a leading-backslash FUNCTION call or bare constant (not class autoloading)', async () => {
    // `\\App\\Util\\format()` is a function call and `\\App\\C\\FOO` a bare constant; PHP keeps
    // functions/constants in separate namespaces resolved at call time, never PSR-4 class files,
    // so emitting them could bind an unrelated class file — excluded for zero false positives.
    const { uses } = await run(
      ['<?php', 'namespace App\\App;', 'function m() { \\App\\Util\\format(); $x = \\App\\C\\FOO; }', ''].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });
});

describe('php extractor — declarations()', () => {
  it('returns class / interface / trait / enum names', async () => {
    const { declarations } = await run(
      [
        '<?php',
        'class Foo {}',
        'interface Bar {}',
        'trait Baz {}',
        'enum Qux {}',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('Bar');
    expect(keys).toContain('Baz');
    expect(keys).toContain('Qux');
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('<?php\n\nclass OnLineThree {}\n');
    const foo = declarations.find((d) => d.symbolKey === 'OnLineThree');
    expect(foo?.line).toBe(3);
  });
});
