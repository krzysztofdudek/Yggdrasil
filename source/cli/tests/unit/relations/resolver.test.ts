import { describe, it, expect } from 'vitest';
import { makeResolver } from '../../../src/relations/resolver.js';
import { SymbolTable } from '../../../src/relations/symbol-table.js';

const owner = { ownerOf: (f: string) => (f === 'src/b.cs' ? 'b' : undefined) };

describe('resolver', () => {
  it('resolves a unique same-language symbol to a mapped owner', () => {
    const st = new SymbolTable(); st.declare('csharp', 'Foo.Bar', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Foo.Bar' }, 'src/a.cs', 'csharp')).toEqual({ ownerNode: 'b', resolvedFile: 'src/b.cs' });
  });
  it('SILENCES a symbol whose only same-name decl is in ANOTHER language', () => {
    // owner.ownerOf maps src/b.cs → 'b'; but the decl is keyed under 'cpp', the use is 'ruby'.
    const st = new SymbolTable(); st.declare('cpp', 'Connection', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Connection' }, 'src/a.rb', 'ruby')).toBeUndefined();
  });
  it('returns undefined for an unmapped symbol target (D7 coverage layering)', () => {
    const st = new SymbolTable(); st.declare('csharp', 'X.Y', 'vendor/x.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'X.Y' }, 'src/a.cs', 'csharp')).toBeUndefined();
  });
  it('returns undefined for an ambiguous symbol', () => {
    const st = new SymbolTable(); st.declare('csharp', 'A', 'src/b.cs'); st.declare('csharp', 'A', 'src/c.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'A' }, 'src/a.cs', 'csharp')).toBeUndefined();
  });
  it('resolves a path hint via the injected resolver', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => 'src/b.cs' });
    expect(r.resolve({ kind: 'path', specifier: './b' }, 'src/a.cs', 'csharp')).toEqual({ ownerNode: 'b', resolvedFile: 'src/b.cs' });
  });
});

// The tri-state probe is the load-bearing addition: it lets the ordered walk distinguish a
// nearer AMBIGUOUS candidate (stop with silence) from an ABSENT one (continue). For a
// one-element group the outcome is byte-equivalent to `resolve` (resolved → edge; ambiguous
// or absent → no edge), but the classification itself MUST be three-valued.
describe('resolver.classify — tri-state (resolved / ambiguous / absent)', () => {
  it('symbol: a UNIQUE mapped definition is `resolved` with its owner + file', () => {
    const st = new SymbolTable(); st.declare('csharp', 'Foo.Bar', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'Foo.Bar' }, 'src/a.cs', 'csharp')).toEqual({
      kind: 'resolved', ownerNode: 'b', resolvedFile: 'src/b.cs',
    });
  });
  it('symbol: 2+ definitions is `ambiguous` (the case `resolveUnique` collapsed to undefined)', () => {
    const st = new SymbolTable(); st.declare('csharp', 'A', 'src/b.cs'); st.declare('csharp', 'A', 'src/c.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'A' }, 'src/a.cs', 'csharp')).toEqual({ kind: 'ambiguous' });
  });
  it('symbol: no definition is `absent`', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'Nope' }, 'src/a.cs', 'csharp')).toEqual({ kind: 'absent' });
  });
  it('symbol: a UNIQUE but UNMAPPED definition is `absent` (D7 non-event — continue, never ambiguous)', () => {
    const st = new SymbolTable(); st.declare('csharp', 'X.Y', 'vendor/x.cs'); // ownerOf(vendor/x.cs) = undefined
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'X.Y' }, 'src/a.cs', 'csharp')).toEqual({ kind: 'absent' });
  });
  it('path: a mapped file is `resolved`; the path axis never yields `ambiguous`', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => 'src/b.cs' });
    expect(r.classify({ kind: 'path', specifier: './b' }, 'src/a.cs', 'csharp')).toEqual({
      kind: 'resolved', ownerNode: 'b', resolvedFile: 'src/b.cs',
    });
  });
  it('path: an unresolved specifier is `absent`', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'path', specifier: './nope' }, 'src/a.cs', 'csharp')).toEqual({ kind: 'absent' });
  });
  it('path: a resolved-but-UNMAPPED file is `absent` (D7)', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => 'vendor/x.cs' });
    expect(r.classify({ kind: 'path', specifier: './x' }, 'src/a.cs', 'csharp')).toEqual({ kind: 'absent' });
  });
});

// Ruby root-anchoring: a multi-segment constant `A::B::C` resolves to an in-repo
// declaration ONLY when its ROOT `A` is itself a declared in-repo symbol. A compact
// reopening of an external constant (`module Rack::Handler` with no in-repo `Rack`) is thus
// silenced — the zero-FP fix for the sinatra `defined?(Rackup::Handler)` mis-binding.
describe('resolver — Ruby root-anchoring (multi-segment resolves only when its ROOT is in-repo)', () => {
  const rbOwner = { ownerOf: (f: string) => (f === 'lib/x.rb' ? 'x' : undefined) };
  const rubyTable = (...decls: [string, string][]): SymbolTable => {
    const st = new SymbolTable();
    for (const [k, f] of decls) st.declare('ruby', k, f);
    return st;
  };

  it('classify: a compact constant whose ROOT is NOT in-repo is `absent` (reopened-external)', () => {
    const st = rubyTable(['Rackup::Handler', 'lib/x.rb']); // only the compact key; `Rackup` unanchored
    const r = makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'Rackup::Handler' }, 'lib/a.rb', 'ruby')).toEqual({ kind: 'absent' });
  });
  it('resolve: a root-unanchored compact constant does not resolve', () => {
    const st = rubyTable(['Rackup::Handler', 'lib/x.rb']);
    const r = makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Rackup::Handler' }, 'lib/a.rb', 'ruby')).toBeUndefined();
  });
  it('classify: when the ROOT is anchored in-repo (a bare `module Rackup`), the constant resolves', () => {
    const st = rubyTable(['Rackup', 'lib/x.rb'], ['Rackup::Handler', 'lib/x.rb']);
    const r = makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'Rackup::Handler' }, 'lib/a.rb', 'ruby')).toEqual({
      kind: 'resolved', ownerNode: 'x', resolvedFile: 'lib/x.rb',
    });
  });
  it('resolve: a root-anchored constant resolves to its owner', () => {
    const st = rubyTable(['Rackup', 'lib/x.rb'], ['Rackup::Handler', 'lib/x.rb']);
    const r = makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Rackup::Handler' }, 'lib/a.rb', 'ruby')).toEqual({
      ownerNode: 'x', resolvedFile: 'lib/x.rb',
    });
  });
  it('a single-segment Ruby constant is its own root → not subject to the guard', () => {
    const st = rubyTable(['Helper', 'lib/x.rb']);
    const r = makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'Helper' }, 'lib/a.rb', 'ruby')).toEqual({
      kind: 'resolved', ownerNode: 'x', resolvedFile: 'lib/x.rb',
    });
  });
  it('RUBY-ONLY: a C# `A.B` resolves even though its root `A` is not a standalone symbol', () => {
    const st = new SymbolTable(); st.declare('csharp', 'A.B', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.classify({ kind: 'symbol', symbolKey: 'A.B' }, 'src/a.cs', 'csharp')).toEqual({
      kind: 'resolved', ownerNode: 'b', resolvedFile: 'src/b.cs',
    });
  });
});

// SymbolTable defCount/has — the count accessors the tri-state probe is built on.
describe('SymbolTable.defCount / has', () => {
  it('counts distinct defining files and reports presence', () => {
    const st = new SymbolTable();
    expect(st.defCount('csharp', 'A')).toBe(0);
    expect(st.has('csharp', 'A')).toBe(false);
    st.declare('csharp', 'A', 'src/b.cs');
    expect(st.defCount('csharp', 'A')).toBe(1);
    expect(st.has('csharp', 'A')).toBe(true);
    st.declare('csharp', 'A', 'src/c.cs');
    expect(st.defCount('csharp', 'A')).toBe(2);
    expect(st.has('csharp', 'A')).toBe(true);
    // resolveUnique is unchanged: exactly-one-or-undefined.
    expect(st.resolveUnique('csharp', 'A')).toBeUndefined();
  });
});

describe('resolver — Ruby lexical gates and external roots', () => {
  const rbOwner = { ownerOf: (f: string) => (f.startsWith('lib/') ? f.split('/')[1] : undefined) };
  const table = (...decls: [string, string][]): SymbolTable => {
    const st = new SymbolTable();
    for (const [k, f] of decls) st.declare('ruby', k, f);
    return st;
  };
  const resolverFor = (st: SymbolTable) =>
    makeResolver({ ownerIndex: rbOwner as any, symbolTable: st, resolvePathToFile: () => undefined });

  it('a core class reopened in-repo is external: absent, even as the only declaration', () => {
    const r = resolverFor(table(['String', 'lib/coreext/string.rb']));
    expect(r.classify({ kind: 'symbol', symbolKey: 'String' }, 'lib/a/x.rb', 'ruby')).toEqual({ kind: 'absent' });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'String' }, 'lib/a/x.rb', 'ruby')).toBeUndefined();
    expect(r.resolveFile({ kind: 'symbol', symbolKey: 'String' }, 'lib/a/x.rb', 'ruby')).toBeUndefined();
  });

  it('a framework namespace reopened by a nested module is external', () => {
    const r = resolverFor(table(['ActiveRecord', 'lib/init/ar.rb'], ['ActiveRecord::Base', 'lib/init/ar.rb']));
    expect(r.classify({ kind: 'symbol', symbolKey: 'ActiveRecord::Base' }, 'lib/a/x.rb', 'ruby')).toEqual({ kind: 'absent' });
  });

  it('rubyAnchor: the first segment exists but the member does not → ambiguous (stop, never fall through)', () => {
    const r = resolverFor(table(['Shop', 'lib/shop/s.rb'], ['Shop::Billing', 'lib/shop/s.rb']));
    const hint = { kind: 'symbol' as const, symbolKey: 'Shop::Billing::Invoice', rubyAnchor: 'Shop::Billing' };
    expect(r.classify(hint, 'lib/a/x.rb', 'ruby')).toEqual({ kind: 'ambiguous' });
    expect(r.resolve(hint, 'lib/a/x.rb', 'ruby')).toBeUndefined();
  });

  it('rubyAnchor: the first segment does not exist either → absent (continue outward)', () => {
    const r = resolverFor(table(['Shop', 'lib/shop/s.rb']));
    const hint = { kind: 'symbol' as const, symbolKey: 'Shop::Billing::Invoice', rubyAnchor: 'Shop::Billing' };
    expect(r.classify(hint, 'lib/a/x.rb', 'ruby')).toEqual({ kind: 'absent' });
  });

  it('rubyInheritGuard: a same-named nested constant anywhere silences the top-level fallback', () => {
    const r = resolverFor(table(['Order', 'lib/models/order.rb'], ['Admin', 'lib/admin/o.rb'], ['Admin::Order', 'lib/admin/o.rb']));
    const guarded = { kind: 'symbol' as const, symbolKey: 'Order', rubyInheritGuard: 'Order' };
    expect(r.classify(guarded, 'lib/a/x.rb', 'ruby')).toEqual({ kind: 'ambiguous' });
    const r2 = resolverFor(table(['Order', 'lib/models/order.rb']));
    expect(r2.classify(guarded, 'lib/a/x.rb', 'ruby')).toEqual({
      kind: 'resolved', ownerNode: 'models', resolvedFile: 'lib/models/order.rb',
    });
  });
});
