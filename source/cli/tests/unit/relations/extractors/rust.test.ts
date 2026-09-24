import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { rustExtractor } from '../../../../src/relations/extractors/rust.js';

const run = (code: string) => runExtractor(rustExtractor, 'rust', '.rs', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

describe('rust extractor — uses()', () => {
  it('detects a single `use crate::payments::charge;` as the crate-relative path hint', async () => {
    const { uses } = await run('use crate::payments::charge;');
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [{ kind: 'path', specifier: 'crate::payments::charge' }],
        kind: 'import',
      }),
    );
  });

  it('strips the alias of a renamed `use crate::db::Repository as Repo;`', async () => {
    const { uses } = await run('use crate::db::Repository as Repo;');
    const s = specs(uses);
    expect(s).toContain('crate::db::Repository');
    expect(s).not.toContain('Repo');
  });

  it('emits every item of a crate-rooted group `use crate::{a::Foo, b::Bar};` on its own', async () => {
    // The group prefix `crate` names no module; each item path is its own dependency
    // (rustfmt imports_granularity = "Crate" / rust-analyzer merge-imports produce this).
    const { uses } = await run('use crate::{a::Foo, b::Bar};');
    expect(specs(uses)).toEqual(['crate::a::Foo', 'crate::b::Bar']);
  });

  it('joins each item to the deeper prefix `use crate::orders::{Order, sub::Deep};`', async () => {
    // A path item (`sub::Deep`) names its own module, never the prefix module.
    const { uses } = await run('use crate::orders::{Order, sub::Deep};');
    expect(specs(uses)).toEqual(['crate::orders::Order', 'crate::orders::sub::Deep']);
  });

  it('joins a `super::`-rooted group item by item `use super::{billing::Invoice, orders::Order};`', async () => {
    const { uses } = await run('use super::{billing::Invoice, orders::Order};');
    expect(specs(uses)).toEqual(['super::billing::Invoice', 'super::orders::Order']);
  });

  it('emits the prefix module for a glob `use crate::events::*;`', async () => {
    const { uses } = await run('use crate::events::*;');
    expect(specs(uses)).toEqual(['crate::events']);
  });

  it('emits the path for a `pub use` re-export (visibility is irrelevant to the edge)', async () => {
    const { uses } = await run('pub use crate::api::Handler;');
    expect(specs(uses)).toEqual(['crate::api::Handler']);
  });

  it('keeps `super::` and `self::` roots verbatim in the specifier', async () => {
    expect(specs((await run('use super::util::X;')).uses)).toEqual(['super::util::X']);
    expect(specs((await run('use self::y::Z;')).uses)).toEqual(['self::y::Z']);
  });

  it('emits an external-crate path verbatim (the resolver, not the extractor, silences it)', async () => {
    const { uses } = await run('use std::collections::HashMap;');
    expect(specs(uses)).toEqual(['std::collections::HashMap']);
  });

  it('handles multiple use declarations in one file', async () => {
    const { uses } = await run(
      'use crate::a::A;\nuse crate::b::*;\nuse super::c::C as Cc;\n',
    );
    const s = specs(uses);
    expect(s).toEqual(
      expect.arrayContaining(['crate::a::A', 'crate::b', 'super::c::C']),
    );
    expect(s).toHaveLength(3);
  });

  it('never reaches into a macro invocation token tree (macro deps are invisible)', async () => {
    // A `crate::…` path appearing only inside a macro call is unparsed tokens, never a
    // use_declaration → zero hints.
    const { uses } = await run('fn f() {\n  println!("{}", crate::config::NAME);\n}\n');
    expect(specs(uses)).toEqual([]);
  });

  it('reports the line of each import', async () => {
    const { uses } = await run('\n\nuse crate::a::A;\n');
    expect(uses[0]?.line).toBe(3);
  });

  it('emits each leaf of a group, all on the group`s line', async () => {
    // `use crate::orders::{Order, Other};` — each leaf resolves on its own (to the module
    // file when it is an item of `crate::orders`); the pass collapses same-line edges to
    // one node into one finding.
    const { uses } = await run('use crate::orders::{Order, Other};');
    expect(specs(uses)).toEqual(['crate::orders::Order', 'crate::orders::Other']);
    expect(new Set(uses.map((u) => u.line))).toEqual(new Set([1]));
  });

  it('emits the prefix for a glob whose prefix is a PLAIN identifier `use foo::*;`', async () => {
    // The wildcard prefix `foo` is a bare `identifier` (not a `scoped_identifier`), so the
    // specifier is the node text `foo` — exercising the ELSE branch of the prefix render.
    const { uses } = await run('use foo::*;');
    expect(specs(uses)).toEqual(['foo']);
  });

  it('emits the prefix for a glob whose prefix is a `crate` keyword `use crate::*;`', async () => {
    const { uses } = await run('use crate::*;');
    expect(specs(uses)).toEqual(['crate']);
  });

  it('emits nothing for a leading-`::` absolute path `use ::foo::Bar;` (malformed prefix → silence)', async () => {
    // The leading `::` produces a scoped_identifier whose leftmost leaf has no `path`
    // field, so the path renderer cannot determine the first segment and returns nothing.
    const { uses } = await run('use ::foo::Bar;');
    expect(specs(uses)).toEqual([]);
  });

  it('falls back to emitting each list item when a group has NO common prefix `use ::{a, b};`', async () => {
    // A leading-`::` group has no usable prefix path, so the edge is preserved by emitting
    // each list item individually rather than being silently dropped.
    const { uses } = await run('use ::{a, b};');
    expect(specs(uses).sort()).toEqual(['a', 'b']);
  });

  it('dedups identical list items emitted from the prefix-less group fallback `use ::{a, a};`', async () => {
    // Both items render to `a` on the same line; the second is deduped (specifier+line key).
    const { uses } = await run('use ::{a, a};');
    expect(specs(uses)).toEqual(['a']);
    expect(uses).toHaveLength(1);
  });

  it('emits nothing when the group prefix is an unrenderable scoped path `use ::foo::{Bar, Baz};`', async () => {
    // `::foo` renders to undefined (no leftmost segment). Emitting the items bare (`Bar`,
    // `Baz`) would re-root them at the top level, where a bare name can match an in-repo
    // path dependency the code never named → silence over a guess.
    const { uses } = await run('use ::foo::{Bar, Baz};');
    expect(specs(uses)).toEqual([]);
  });

  it('emits nothing for a glob whose prefix is an unrenderable scoped path `use ::foo::*;`', async () => {
    // The wildcard prefix `::foo` is a scoped_identifier that renders to undefined, so no
    // specifier is emitted (silence over a guess).
    const { uses } = await run('use ::foo::*;');
    expect(specs(uses)).toEqual([]);
  });

  it('resolves a renamed import via its `path` field only `use a as b;`', async () => {
    // The alias `b` is a local binding; the emitted specifier is the real path `a`.
    const { uses } = await run('use a as b;');
    expect(specs(uses)).toEqual(['a']);
  });

  it('emits nothing for a renamed import whose path is an unrenderable scoped path `use ::foo as bar;`', async () => {
    const { uses } = await run('use ::foo as bar;');
    expect(specs(uses)).toEqual([]);
  });

  it('emits the prefix module for the `self` item of a group `use crate::a::{self, B};`', async () => {
    // The `self` leaf means the prefix module itself; `B` resolves on its own.
    const { uses } = await run('use crate::a::{self, B};');
    expect(specs(uses)).toEqual(['crate::a', 'crate::a::B']);
  });

  it('emits a bare top-level identifier import `use foo;`', async () => {
    // A non-grouped, non-scoped argument at the top level: empty prefix → the tail itself.
    const { uses } = await run('use foo;');
    expect(specs(uses)).toEqual(['foo']);
  });

  it('emits nothing for a glob with no prefix path `use ::*;`', async () => {
    // The wildcard has no prefix node (bare `*`), so there is nothing to emit.
    const { uses } = await run('use ::*;');
    expect(specs(uses)).toEqual([]);
  });

  it('ignores a bare top-level brace list with no prefix `use {a, b};`', async () => {
    // A bare `use {a, b};` parses with the brace list as the argument node directly; it is
    // not a recognised argument shape, so nothing is emitted (unhandled-argument case).
    const { uses } = await run('use {a, b};');
    expect(specs(uses)).toEqual([]);
  });

  it('descends a nested group with the accumulated prefix `use crate::a::{b::{C, D}, e};`', async () => {
    const { uses } = await run('use crate::a::{b::{C, D}, e};');
    expect(specs(uses)).toEqual(['crate::a::b::C', 'crate::a::b::D', 'crate::a::e']);
  });

  it('strips the raw-identifier prefix from every segment (`mod r#gen;`, `crate::r#gen::X`)', async () => {
    const { uses } = await run('mod r#gen;\nuse crate::r#gen::r#try::X;\n');
    expect(specs(uses)).toEqual(['self::gen', 'crate::gen::try::X']);
  });

  it('emits the crate name of `extern crate name as alias;` and drops the alias', async () => {
    const { uses } = await run('extern crate core_lib as cl;\nextern crate self as me;\n');
    expect(specs(uses)).toEqual(['core_lib']);
  });
});

describe('rust extractor — inline modules rebase self/super to the file module', () => {
  it('`use super::*` inside one inline `mod tests` is the file module itself (`self`)', async () => {
    const { uses } = await run('mod tests {\n    use super::*;\n    use super::place as p;\n}\n');
    expect(specs(uses)).toEqual(['self', 'self::place']);
  });

  it('`super::super::x` inside one inline module climbs once from the file module', async () => {
    const { uses } = await run('mod tests {\n    use super::super::x::Y;\n}\n');
    expect(specs(uses)).toEqual(['super::x::Y']);
  });

  it('`super` inside two nested inline modules pops one and keeps the outer one', async () => {
    const { uses } = await run('mod outer {\n    mod inner {\n        use super::z::Z;\n    }\n}\n');
    expect(specs(uses)).toEqual(['self::outer::z::Z']);
  });

  it('`self::` and a file-backed `mod x;` inside an inline module splice the inline path in', async () => {
    const { uses } = await run('mod outer {\n    mod inner;\n    use self::inner::Deep;\n}\n');
    expect(specs(uses)).toEqual(['self::outer::inner', 'self::outer::inner::Deep']);
  });

  it('`crate::` inside an inline module is unaffected', async () => {
    const { uses } = await run('mod tests {\n    use crate::a::B;\n}\n');
    expect(specs(uses)).toEqual(['crate::a::B']);
  });

  it('relative paths under a `#[path]`-relocated inline module are silenced', async () => {
    const { uses } = await run('#[path = "elsewhere"]\nmod outer {\n    mod inner;\n    use super::x::Y;\n    use crate::a::B;\n}\n');
    expect(specs(uses)).toEqual(['crate::a::B']);
  });
});

describe('rust extractor — declarations()', () => {
  it('returns top-level struct / enum / trait / fn / mod names', async () => {
    const { declarations } = await run(
      'pub struct Order { id: u32 }\nenum E { A }\ntrait T {}\nfn f() {}\nmod m;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toEqual(expect.arrayContaining(['Order', 'E', 'T', 'f', 'm']));
  });

  it('does not descend into an inline `mod { … }` for nested items', async () => {
    const { declarations } = await run('mod inline { fn g() {} struct Inner {} }\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('inline');
    expect(keys).not.toContain('g');
    expect(keys).not.toContain('Inner');
  });

  it('ignores top-level items that are not struct/enum/trait/fn/mod (impl, const, static, use)', async () => {
    // Only the five named item kinds become declarations; an `impl` (no name), a `const`,
    // a `static`, and a `use` are all skipped by the item-type filter.
    const { declarations } = await run(
      'use crate::a;\nstruct S {}\nimpl S {}\nconst X: u32 = 1;\nstatic Y: u32 = 2;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toEqual(['S']);
  });

  it('reports the line of a top-level declaration', async () => {
    const { declarations } = await run('\nstruct Order {}\n');
    expect(declarations[0]?.symbolKey).toBe('Order');
    expect(declarations[0]?.line).toBe(2);
  });
});
