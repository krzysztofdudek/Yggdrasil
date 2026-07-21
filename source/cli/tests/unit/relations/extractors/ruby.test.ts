import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { rubyExtractor } from '../../../../src/relations/extractors/ruby.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { DetectedDep } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFiles, type ParseSpec } from '../../helpers/with-parsed-files.js';

const run = (code: string) => runExtractor(rubyExtractor, 'ruby', '.rb', code);

const symbolKeys = (uses: DetectedDep[]): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'symbol' ? [u.candidates[0].symbolKey] : []));
const pathSpecs = (uses: DetectedDep[]): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

/** A Ruby (path, code) pair as a withParsedFiles spec. */
const rb = (path: string, code: string): ParseSpec => ({ path, code, language: 'ruby' });

describe('ruby extractor — uses() emits PATH hints (require_relative)', () => {
  it('emits a path hint with the literal string for require_relative', async () => {
    const { uses } = await run("require_relative '../services/order_service'\n");
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [{ kind: 'path', specifier: '../services/order_service' }],
        kind: 'import',
      }),
    );
  });

  it('carries a 1-based line number for the require_relative hint', async () => {
    const { uses } = await run("\n\nrequire_relative './helper'\n");
    const hint = uses.find((u) => u.candidates[0].kind === 'path');
    expect(hint?.line).toBe(3);
  });

  it('SKIPS a plain `require` of a gem (only require_relative is a path link)', async () => {
    const { uses } = await run("require 'json'\nrequire 'order/processor'\n");
    // Neither is a require_relative → no path hint at all.
    expect(pathSpecs(uses)).toHaveLength(0);
  });

  it('SKIPS require_relative with an interpolated / dynamic argument', async () => {
    const { uses } = await run('require_relative "../#{name}"\nrequire_relative File.join("a", "b")\n');
    expect(pathSpecs(uses)).toHaveLength(0);
  });

  it('SKIPS require_relative of an EMPTY string `\'\'` (no string_content → no literal)', async () => {
    // An empty string literal has no `string_content` child, so literalStringArg
    // returns undefined and no path hint is emitted.
    const { uses } = await run("require_relative ''\n");
    expect(pathSpecs(uses)).toHaveLength(0);
  });

  it('SKIPS a bare `require_relative` with NO argument (args field is null)', async () => {
    const { uses } = await run('require_relative\n');
    expect(pathSpecs(uses)).toHaveLength(0);
    expect(uses).toHaveLength(0);
  });

  it('DEDUPES two identical require_relative on the SAME line (path symbol+line key)', async () => {
    // `require_relative 'a'; require_relative 'a'` — same specifier, same line → one hint.
    const { uses } = await run("require_relative 'a'; require_relative 'a'\n");
    expect(pathSpecs(uses).filter((s) => s === 'a')).toHaveLength(1);
  });
});

describe('ruby extractor — uses() emits SYMBOL hints (constants)', () => {
  it('emits the superclass constant for `class C < Base`', async () => {
    const { uses } = await run('class OrderService < BaseService\nend\n');
    expect(symbolKeys(uses)).toContain('BaseService');
    // The class\'s OWN name is a definition, never a dependency.
    expect(symbolKeys(uses)).not.toContain('OrderService');
  });

  it('emits a scope_resolution superclass key, stripping a leading `::`', async () => {
    const { uses } = await run('class A < Reporting::Base\nend\nclass B < ::Top::Base\nend\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('Reporting::Base');
    expect(keys).toContain('Top::Base'); // leading `::` stripped
    expect(keys.every((k) => !k.startsWith('::'))).toBe(true);
  });

  it('emits a symbol per `include` / `extend` / `prepend` module argument', async () => {
    const { uses } = await run(
      ['class C', '  include Loggable', '  extend Forwardable', '  prepend Tracing::Hook', 'end', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('Loggable');
    expect(keys).toContain('Forwardable');
    expect(keys).toContain('Tracing::Hook');
  });

  it('emits both constants for `include A, B` (multiple modules per call)', async () => {
    const { uses } = await run('class C\n  include A, B\nend\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('A');
    expect(keys).toContain('B');
  });

  it('emits a scope_resolution used as a value (`Foo::Bar`)', async () => {
    const { uses } = await run('x = Payments::Gateway\n');
    expect(symbolKeys(uses)).toContain('Payments::Gateway');
  });

  it('emits a bare constant used as a value (`x = Helper`)', async () => {
    const { uses } = await run('x = Helper\n');
    expect(symbolKeys(uses)).toContain('Helper');
  });

  it('emits the receiver constant of a qualified call (`Payments::Gateway.charge`)', async () => {
    const { uses } = await run('Payments::Gateway.charge(amount)\n');
    expect(symbolKeys(uses)).toContain('Payments::Gateway');
  });

  it('does NOT emit a symbol for a local-receiver call (`helper.run`, `@repo.save`)', async () => {
    const { uses } = await run('helper.run\n@repo.save(x)\nfoo.bar.baz\n');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('does NOT double-count the inner constants of a scope_resolution', async () => {
    const { uses } = await run('x = A::B::C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('A::B::C');
    // The qualifier segments A and A::B must NOT each surface as their own hint.
    expect(keys).not.toContain('A');
    expect(keys).not.toContain('A::B');
    expect(keys.filter((k) => k === 'A::B::C')).toHaveLength(1);
  });

  it('a `class C` with NO superclass emits NO use (only its own definition)', async () => {
    // The `superclass` field is null → the superclass branch is skipped entirely.
    const { uses } = await run('class Foo\nend\n');
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(uses).toHaveLength(0);
  });

  it('emits NO use for a DYNAMIC superclass expression (e.g. `Struct.new(:x)`) — not a constant name', async () => {
    // A common real-world idiom: the superclass is a method-call RESULT, not a
    // constant-name node, so constantKey(expr) is undefined and the (unguarded)
    // emitSymbol call at the superclass site must no-op rather than emit a
    // hint keyed on 'undefined' or crash.
    const { uses } = await run('class C < Struct.new(:x)\nend\n');
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(uses).toHaveLength(0);
  });

  it('DEDUPES the same constant referenced twice on ONE line (symbol+line key)', async () => {
    // `x = Helper; y = Helper` references `Helper` twice on the same line. The
    // emit dedup key is symbol+line, so the second occurrence is suppressed.
    const { uses } = await run('x = Helper; y = Helper\n');
    const helpers = symbolKeys(uses).filter((k) => k === 'Helper');
    expect(helpers).toHaveLength(1);
  });

  it('SKIPS an `include` whose argument is a method call (non-constant → constantKey undefined)', async () => {
    // `include some_method` — the argument is an identifier/call, not a constant, so
    // constantKey returns undefined and nothing is emitted.
    const { uses } = await run('class C\n  include some_method\nend\n');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('SKIPS an `include` whose argument is a string literal (non-constant)', async () => {
    const { uses } = await run('class C\n  include "str"\nend\n');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('does NOT emit the `name` field constant of a module declaration as a use', async () => {
    // `module App` — the `App` constant is the module name (a definition), never a use.
    const { uses, declarations } = await run('module App\nend\n');
    expect(symbolKeys(uses)).not.toContain('App');
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(declarations.map((d) => d.symbolKey)).toContain('App');
  });

  it('does NOT emit the scoped `name` of a `class A::B` declaration as a use', async () => {
    // The class name is a scope_resolution (`A::B`); it is the name field, so skipped
    // as a use while still recorded as a definition.
    const { uses, declarations } = await run('class A::B\nend\n');
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(declarations.map((d) => d.symbolKey)).toContain('A::B');
  });
});

describe('ruby extractor — declarations() build FQNs from nesting', () => {
  it('builds App::Services::OrderService from module nesting', async () => {
    const { declarations } = await run(
      ['module App', '  module Services', '    class OrderService', '    end', '  end', 'end', ''].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('App');
    expect(keys).toContain('App::Services');
    expect(keys).toContain('App::Services::OrderService');
  });

  it('records a top-level constant assignment as a definition', async () => {
    const { declarations } = await run('MAX = 5\nMyAlias = OriginalClass\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('MAX');
    expect(keys).toContain('MyAlias');
  });

  it('qualifies a constant assignment NESTED in a module into a FQN (M::X)', async () => {
    // `X = 1` inside `module M` is reached via generic descent under the module body
    // with a non-empty nsStack, so it gets the FQN prefix.
    const { declarations } = await run('module M\n  X = 1\nend\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('M');
    expect(keys).toContain('M::X');
  });

  it('does NOT record a SCOPED constant assignment (`Foo::BAR = 1`) as a definition', async () => {
    // The `left` field is a scope_resolution, not a bare `constant`, so it is not indexed
    // as a node-defining declaration (only bare top-level constants are).
    const { declarations } = await run('Foo::BAR = 1\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).not.toContain('Foo::BAR');
    expect(keys).toHaveLength(0);
  });

  it('carries 1-based line numbers', async () => {
    const { declarations } = await run('\nclass Foo\nend\n');
    expect(declarations.find((d) => d.symbolKey === 'Foo')?.line).toBe(2);
  });

  it('a REOPENED class produces TWO definitions of the same FQN (no dedupe)', async () => {
    const { declarations } = await run('class Foo\nend\nclass Foo\nend\n');
    const fooDefs = declarations.filter((d) => d.symbolKey === 'Foo');
    expect(fooDefs).toHaveLength(2);
    // Different lines — two distinct definition sites of the same constant.
    expect(new Set(fooDefs.map((d) => d.line)).size).toBe(2);
  });
});

describe('ruby SYMBOL-TABLE resolution — unique resolves, reopened silences', () => {
  it('a UNIQUE constant resolves through the table to its defining file', async () => {
    ensureLoaderRegistered();
    await withParsedFiles(
      [
        rb('src/a/base_service.rb', 'class BaseService\nend\n'),
        rb('src/b/order_service.rb', 'class OrderService < BaseService\nend\n'),
      ],
      ([fileA, consumer]) => {
        const st = new SymbolTable();
        for (const d of rubyExtractor.declarations(fileA)) st.declare('ruby', d.symbolKey, fileA.path);

        expect(st.resolveUnique('ruby', 'BaseService')).toBe('src/a/base_service.rb');

        const importHint = rubyExtractor.uses(consumer).find((u) => u.candidates[0].kind === 'symbol')!;
        expect(importHint.candidates[0]).toEqual({ kind: 'symbol', symbolKey: 'BaseService' });

        const ownerIndex = { ownerOf: (f: string) => (f === 'src/a/base_service.rb' ? 'a' : undefined) };
        const resolver = makeResolver({
          ownerIndex: ownerIndex as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        expect(resolver.resolve(importHint.candidates[0], consumer.path, 'ruby')).toEqual({
          ownerNode: 'a',
          resolvedFile: 'src/a/base_service.rb',
        });
      },
    );
  });

  it('a REOPENED (ambiguous) constant silences — resolveUnique undefined, no flag', async () => {
    ensureLoaderRegistered();
    // Two files each define `Widget` (reopening / same name across nodes) → ambiguous.
    await withParsedFiles(
      [
        rb('src/x/widget.rb', 'class Widget\nend\n'),
        rb('src/y/widget.rb', 'class Widget\nend\n'),
        rb('src/z/use.rb', 'x = Widget\n'),
      ],
      ([fileX, fileY, consumer]) => {
        const st = new SymbolTable();
        for (const f of [fileX, fileY]) {
          for (const d of rubyExtractor.declarations(f)) st.declare('ruby', d.symbolKey, f.path);
        }

        expect(st.resolveUnique('ruby', 'Widget')).toBeUndefined();

        const ownerIndex = { ownerOf: () => 'someNode' };
        const resolver = makeResolver({
          ownerIndex: ownerIndex as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        const hint = rubyExtractor.uses(consumer).find((u) => u.candidates[0].kind === 'symbol')!;
        expect(resolver.resolve(hint.candidates[0], consumer.path, 'ruby')).toBeUndefined();
      },
    );
  });
});

describe('ruby extractor — registry wiring', () => {
  it('declares the ruby language', () => {
    expect(rubyExtractor.languages.has('ruby')).toBe(true);
  });
});

describe('ruby extractor — C1: bare constants inside a namespace are suppressed (zero-FP)', () => {
  it('SUPPRESSES a bare unqualified constant used inside a module body', async () => {
    // `Helper` inside `module App` lexically resolves to App::Helper (or a top-level
    // Helper) — never to a uniquely-defined top-level Helper owned by another node.
    const { uses } = await run(['module App', '  x = Helper', 'end', ''].join('\n'));
    expect(symbolKeys(uses)).not.toContain('Helper');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('SUPPRESSES a bare unqualified superclass inside a nested namespace', async () => {
    // `class Widget < Base` nested in module App — `Base` is bare → suppressed.
    const { uses } = await run(
      ['module App', '  class Widget < Base', '  end', 'end', ''].join('\n'),
    );
    expect(symbolKeys(uses)).not.toContain('Base');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('SUPPRESSES a bare mixin argument inside a module body', async () => {
    const { uses } = await run(
      ['module App', '  class C', '    include Loggable', '  end', 'end', ''].join('\n'),
    );
    expect(symbolKeys(uses)).not.toContain('Loggable');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  // ---- PAIRED POSITIVES: do NOT over-silence real cross-node references ----

  it('STILL emits a ::-rooted absolute constant used inside a namespace (key stripped)', async () => {
    const { uses } = await run(['module App', '  x = ::TopHelper', 'end', ''].join('\n'));
    // The ::-prefix makes it a complete top-level path — no lexical shadowing risk.
    expect(symbolKeys(uses)).toContain('TopHelper');
  });

  it('STILL emits a ::-qualified (dotted) constant used inside a namespace', async () => {
    const { uses } = await run(['module App', '  x = Payments::Gateway', 'end', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Payments::Gateway');
  });

  it('STILL emits a bare constant used at TOP LEVEL (no enclosing namespace)', async () => {
    // Regression guard: the existing top-level behavior is unchanged.
    const { uses } = await run('x = Helper\n');
    expect(symbolKeys(uses)).toContain('Helper');
  });

  it('STILL emits a top-level superclass and a top-level mixin (depth 0)', async () => {
    const { uses } = await run(
      ['class OrderService < BaseService', '  include Loggable', 'end', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('BaseService');
    expect(keys).toContain('Loggable');
  });

  it('SUPPRESSES a bare value-use constant inside a (top-level) class body', async () => {
    // A class IS a constant namespace in Ruby: a bare `Helper` inside `class Order`
    // lexically resolves to Order::Helper (if defined) or top-level Helper — never
    // reliably to a uniquely-defined top-level Helper in another node. Zero-FP.
    const { uses } = await run(['class Order', '  def run', '    Helper.go', '  end', 'end', ''].join('\n'));
    expect(symbolKeys(uses)).not.toContain('Helper');
  });

  it('STILL emits a ::-rooted reference inside a class body (complete path, no shadow risk)', async () => {
    const { uses } = await run(['class Order', '  def run', '    ::TopHelper.go', '  end', 'end', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('TopHelper');
  });
});
