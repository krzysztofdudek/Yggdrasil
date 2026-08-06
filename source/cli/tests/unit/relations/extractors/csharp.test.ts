import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { csharpExtractor } from '../../../../src/relations/extractors/csharp.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFiles } from '../../helpers/with-parsed-files.js';

const run = (code: string) => runExtractor(csharpExtractor, 'csharp', '.cs', code);

/** Every symbol key across EVERY candidate of EVERY detected reference. Each C# reference is
 *  now ONE ordered DetectedDep carrying its whole candidate group (nearest binding first,
 *  verbatim/top-level last), so a key may sit at any position in the group. */
const symbolKeys = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => u.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : [])));

/** The ordered symbol-key group for the reference whose group CONTAINS `key` (anywhere). */
const groupContaining = (
  uses: Awaited<ReturnType<typeof run>>['uses'],
  key: string,
): string[] | undefined => {
  const dep = uses.find((u) =>
    u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key),
  );
  return dep?.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : []));
};

/** Resolve a detected reference exactly as `pass.ts` does: walk its ordered candidate group
 *  and take the FIRST candidate that resolves to a unique mapped owner (stop), silence on a
 *  present-but-ambiguous nearer candidate, continue past absent ones. Returns the bound owner
 *  node, or undefined (silence). `dep` is the reference whose group contains `key`. */
const walkResolve = (
  uses: Awaited<ReturnType<typeof run>>['uses'],
  key: string,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
): string | undefined => {
  const dep = uses.find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key));
  if (dep === undefined) return undefined;
  for (const cand of dep.candidates) {
    const outcome = resolver.classify(cand, fromFile, 'csharp');
    if (outcome.kind === 'resolved') return outcome.ownerNode; // first bind wins, stop
    if (outcome.kind === 'ambiguous') return undefined; // nearer ambiguity silences the group
    // absent → continue
  }
  return undefined;
};

/** Parse one or more C# source strings under chosen repo-rel paths, keeping every Tree alive
 *  for the callback's duration (withParsedFiles guarantees each is deleted afterward). */
function parseAll<T>(
  specs: Array<{ path: string; code: string }>,
  fn: (files: ParsedFile[]) => T,
): Promise<T> {
  ensureLoaderRegistered();
  return withParsedFiles(
    specs.map((s) => ({ path: s.path, code: s.code, language: 'csharp' })),
    fn,
  );
}

describe('csharp extractor — declarations() produce <Namespace>.<Type> FQN keys', () => {
  it('qualifies every type kind with a FILE-SCOPED namespace (namespace Foo.Bar;)', async () => {
    const { declarations } = await run(
      [
        'namespace Foo.Bar;',
        'public class C { }',
        'public interface IThing { }',
        'public struct S { }',
        'public record Money(decimal A);',
        'public enum E { X }',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo.Bar.C');
    expect(keys).toContain('Foo.Bar.IThing');
    expect(keys).toContain('Foo.Bar.S');
    expect(keys).toContain('Foo.Bar.Money');
    expect(keys).toContain('Foo.Bar.E');
  });

  it('qualifies with a BLOCK namespace and concatenates NESTED namespaces', async () => {
    const { declarations } = await run(
      ['namespace Outer {', '  namespace Inner {', '    class C { }', '  }', '}', ''].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Outer.Inner.C');
  });

  it('uses the BARE type name when the type is at FILE SCOPE (no namespace)', async () => {
    const { declarations } = await run('class Loose { }\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Loose');
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('namespace N;\n\npublic class OnLineThree { }\n');
    const found = declarations.find((d) => d.symbolKey === 'N.OnLineThree');
    expect(found?.line).toBe(3);
  });
});

describe('csharp extractor — declarations() key NESTED types with the reflection `+` separator', () => {
  it('keys a nested type `Outer+Inner` (and deeper `Outer+Obj+Deep`), NOT the bare simple name', async () => {
    const { declarations } = await run(
      [
        'namespace App;',
        'class Outer {',
        '  class Inner { }',
        '  class Obj { class Deep { } }',
        '}',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('App.Outer'); // top-level type unchanged
    expect(keys).toContain('App.Outer+Inner'); // nested → `+` reflection FQN
    expect(keys).toContain('App.Outer+Obj'); // nested
    expect(keys).toContain('App.Outer+Obj+Deep'); // doubly nested
    // D-N5: a nested type emits ONLY its `+` key, never also the bare simple name — that
    // removes the collision that would let a nested `Inner` silence a top-level `App.Inner`.
    expect(keys).not.toContain('App.Inner');
    expect(keys).not.toContain('App.Deep');
    expect(keys).not.toContain('App.Obj');
  });

  it('keys a file-scope nested type `Outer+Inner` with no namespace prefix', async () => {
    const { declarations } = await run(['class Outer { class Inner { } }', ''].join('\n'));
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Outer');
    expect(keys).toContain('Outer+Inner');
    expect(keys).not.toContain('Inner');
  });
});

describe('csharp extractor — uses() emits SYMBOL hints (never path hints)', () => {
  it('emits a FULLY-QUALIFIED `new Foo.Bar.Baz()` as the FQN candidate', async () => {
    const { uses } = await run(
      ['class C { void M() { var o = new Foo.Bar.Baz(); } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
    expect(uses.every((u) => u.candidates[0].kind === 'symbol')).toBe(true);
  });

  it('inside a namespace, emits BOTH the enclosing-namespace expansion AND the verbatim form for a multi-segment qualified base type', async () => {
    // `Foo.Bar.Base` written inside `namespace App;` could bind to `App.Foo.Bar.Base`
    // (enclosing-namespace lookup) OR top-level `Foo.Bar.Base`. We emit BOTH candidates;
    // resolveUnique keeps only one if exactly one resolves, and silences if both resolve
    // to different files.
    const { uses } = await run(['namespace App;', 'class C : Foo.Bar.Base { }', ''].join('\n'));
    const keys = symbolKeys(uses);
    expect(keys).toContain('App.Foo.Bar.Base'); // enclosing-namespace expansion
    expect(keys).toContain('Foo.Bar.Base'); // verbatim fallback
  });

  it('emits a FULLY-QUALIFIED field type as the FQN candidate', async () => {
    const { uses } = await run(['class C { Foo.Bar.Dep _d; }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Dep');
  });

  it('qualifies a BARE base type via the using scope (`using Foo.Bar; ... : Baz`)', async () => {
    const { uses } = await run(['using Foo.Bar;', 'class C : Baz { }', ''].join('\n'));
    // Candidate FQN = <using prefix>.<bare name>.
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('qualifies a BARE `new Baz()` against EVERY using prefix (multiple candidates are safe)', async () => {
    const { uses } = await run(
      ['using Foo.Bar;', 'using Other.Ns;', 'class C { void M() { var x = new Baz(); } }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    // Both candidates emitted — resolveUnique keeps only the one that actually resolves.
    expect(keys).toContain('Foo.Bar.Baz');
    expect(keys).toContain('Other.Ns.Baz');
  });

  it('resolves a BARE name through an ALIAS (`using Gw = Foo.Bar.IGateway;`) — alias expansion is the NEAREST candidate', async () => {
    const { uses } = await run(
      ['using Gw = Foo.Bar.IGateway;', 'class C { void M() { var x = new Gw(); } }', ''].join('\n'),
    );
    // The aliased FQN is the dependency and sits FIRST in the ordered group (the alias is a
    // hard local override, nearest binding). The bare alias name `Gw` is only the harmless
    // verbatim last candidate — it resolves to nothing, so the alias FQN is what binds.
    const group = groupContaining(uses, 'Foo.Bar.IGateway');
    expect(group?.[0]).toBe('Foo.Bar.IGateway');
    expect(group?.[group.length - 1]).toBe('Gw');
  });

  it('`using static X;` records NO namespace prefix — it imports a TYPE\'s members, not a namespace', async () => {
    const { uses } = await run(
      ['using static Foo.Bar.Calc;', 'class C : Baz { }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    // No plain namespace prefix recorded → the bare base `Baz` yields NO `Foo.Bar.Baz` candidate.
    // (The static-using TARGET `Foo.Bar.Calc` IS emitted as its own fully-qualified dependency,
    // but it never expands into a sibling-namespace candidate for `Baz`.)
    expect(keys).not.toContain('Foo.Bar.Baz');
    expect(keys.some((k) => k.endsWith('.Baz'))).toBe(false);
  });

  it('does NOT honor `global using` from another file: a bare name with no in-file using stays SILENT at resolution', async () => {
    // No `using` directive and no namespace in THIS file → the only candidate for a bare base
    // type is its verbatim top-level form (`SomeGlobalType`), the harmless last candidate. With
    // no in-graph file declaring that bare top-level type, it resolves to nothing → SILENCE.
    const { uses } = await run(['class C : SomeGlobalType { }', ''].join('\n'));
    expect(symbolKeys(uses)).toEqual(['SomeGlobalType']);
    const st = new SymbolTable(); // empty table — `global using` declared elsewhere is invisible here
    const resolver = makeResolver({
      ownerIndex: { ownerOf: () => 'someNode' } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(resolver.resolve({ kind: 'symbol', symbolKey: 'SomeGlobalType' }, 'src/c/Use.cs', 'csharp')).toBeUndefined();
  });

  it('every hint is a SYMBOL hint (csharp resolves through the SymbolTable, never a path)', async () => {
    const { uses } = await run(
      ['using Foo.Bar;', 'class C : Baz { Foo.Bar.Dep _d; }', ''].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((u) => u.candidates[0].kind === 'symbol')).toBe(true);
  });

  it('honors `global using Foo.Bar;` as a plain namespace prefix for a bare base type', async () => {
    // `global using` declared in THIS file is treated as a namespace import for this
    // file's scope, so a bare base type qualifies via the prefix.
    const { uses } = await run(['global using Foo.Bar;', 'class C : Baz { }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('honors `global using Foo.Bar;` as a prefix for a bare `new Baz()` too', async () => {
    const { uses } = await run(
      ['global using Foo.Bar;', 'class C { void M() { var x = new Baz(); } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('resolves a bare name through a `global using Alias = Foo.Bar.IGateway;` alias — alias expansion is NEAREST', async () => {
    const { uses } = await run(
      ['global using Gw = Foo.Bar.IGateway;', 'class C { void M() { var x = new Gw(); } }', ''].join('\n'),
    );
    const group = groupContaining(uses, 'Foo.Bar.IGateway');
    expect(group?.[0]).toBe('Foo.Bar.IGateway'); // alias expansion is the first/nearest candidate
    expect(group?.[group.length - 1]).toBe('Gw'); // bare alias name only as harmless last
  });

  it('emits a QUALIFIED base type (`: Foo.Bar.Base`) even with NO using directive', async () => {
    // A qualified_name in a base_list is emitted as-is (not via the bare prefix path).
    const { uses } = await run(['class C : Foo.Bar.Base { }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Base');
  });

  it('SKIPS a GENERIC base type (`: List<int>`) — not a bare identifier, no candidate', async () => {
    // A `generic_name` is neither a bare identifier nor a qualified_name, so bareTypeName
    // returns undefined and emitBare is skipped.
    const { uses } = await run(['using Foo.Bar;', 'class C : List<int> { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('handles a base_list with MULTIPLE entries (qualified bare base + bare interface)', async () => {
    // Two base entries on one line: a bare base and a bare interface, each qualified by
    // the using prefix; a third generic entry is skipped.
    const { uses } = await run(
      ['using N;', 'class C : MyBase, IFoo<int> { }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('N.MyBase'); // bare base qualified
    expect(keys.every((k) => !k.includes('IFoo'))).toBe(true); // generic skipped
  });

  it('does NOT emit the namespace HEADER of a block `namespace Foo.Bar { }` as a use', async () => {
    // The qualified_name `Foo.Bar` is the namespace declaration name, not a dependency.
    const { uses, declarations } = await run(['namespace Foo.Bar { class C { } }', ''].join('\n'));
    expect(symbolKeys(uses)).not.toContain('Foo.Bar');
    expect(symbolKeys(uses)).toHaveLength(0);
    // The type is still declared with the namespace prefix.
    expect(declarations.map((d) => d.symbolKey)).toContain('Foo.Bar.C');
  });

  it('does NOT emit NESTED block namespace headers as uses (namespace A.B { namespace C.D { } })', async () => {
    const { uses, declarations } = await run(
      ['namespace A.B { namespace C.D { class X { } } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(declarations.map((d) => d.symbolKey)).toContain('A.B.C.D.X');
  });

  it('DEDUPES the SAME candidate key WITHIN one reference group (`: Foo.Bar, Foo.Bar`)', async () => {
    // Each base entry is its own reference → its own ordered group. The dedup is now
    // WITHIN a group: a group never lists the same candidate key twice. (Two distinct base
    // entries legitimately produce two groups — each a clean single-candidate `[Foo.Bar]`.)
    const { uses } = await run(['class C : Foo.Bar, Foo.Bar { }', ''].join('\n'));
    for (const u of uses) {
      const keys = u.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : []));
      expect(new Set(keys).size).toBe(keys.length); // no duplicate key inside any one group
    }
  });

  it('DEDUPES a duplicate candidate produced by a REPEATED using prefix WITHIN the group', async () => {
    // Two identical `using A;` directives yield the same prefix; the bare base `Baz` would
    // produce `A.Baz` twice in the same ordered group, but within-group dedup collapses it
    // to a single candidate (order preserved).
    const { uses } = await run(['using A;', 'using A;', 'class C : Baz { }', ''].join('\n'));
    const group = groupContaining(uses, 'A.Baz');
    expect(group?.filter((k) => k === 'A.Baz')).toHaveLength(1);
  });

  it('inside a namespace, expands a multi-segment qualified ref against EACH using prefix too', async () => {
    // `new Models.Order()` inside `namespace App;` with `using Domain;` could mean
    // App.Models.Order, Domain.Models.Order, or top-level Models.Order — emit all three.
    const { uses } = await run(
      ['using Domain;', 'namespace App;', 'class C { void M() { var o = new Models.Order(); } }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('App.Models.Order'); // enclosing-namespace expansion
    expect(keys).toContain('Domain.Models.Order'); // using-prefix expansion
    expect(keys).toContain('Models.Order'); // verbatim fallback
  });

  it('inside a namespace with a using, expands a qualified BASE type the same way', async () => {
    const { uses } = await run(
      ['using Domain;', 'namespace App.Sub;', 'class C : Models.Base { }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('App.Sub.Models.Base'); // enclosing block namespace expansion
    expect(keys).toContain('Domain.Models.Base'); // using-prefix expansion
    expect(keys).toContain('Models.Base'); // verbatim fallback
  });

  it('at FILE SCOPE (no namespace, no using), keeps a multi-segment qualified ref VERBATIM only', async () => {
    // No enclosing namespace and no using prefix → `Foo.Bar.Baz` can ONLY mean top-level
    // Foo.Bar.Baz. It is unambiguous, so it stays a verbatim candidate (no expansion noise).
    const { uses } = await run(['class C { void M() { var o = new Foo.Bar.Baz(); } }', ''].join('\n'));
    const keys = symbolKeys(uses);
    expect(keys).toContain('Foo.Bar.Baz');
    // No spurious namespace/using expansion exists to emit.
    expect(keys).toEqual(['Foo.Bar.Baz']);
  });

  it('ORDERED GROUP: nearest expansion FIRST, verbatim LAST — and the verbatim binds when nothing nearer does (recall)', async () => {
    // Inside `namespace App;`, `Models.Order` is ONE ordered group: the enclosing-namespace
    // expansion `App.Models.Order` (nearest) THEN the verbatim `Models.Order` (last). When only
    // the top-level form is declared, the walk skips the absent nearest and binds the verbatim
    // — the real dependency is found, not over-silenced. (This replaces the C5-era false-green
    // assertion that treated an independent verbatim hint as a hit regardless of order.)
    await parseAll(
      [{ path: 'src/c/Use.cs', code: 'namespace App;\nclass C { void M() { var o = new Models.Order(); } }\n' }],
      ([consumer]) => {
        const group = groupContaining(csharpExtractor.uses(consumer), 'Models.Order');
        expect(group).toEqual(['App.Models.Order', 'Models.Order']); // nearest first, verbatim last

        const st = new SymbolTable();
        st.declare('csharp', 'Models.Order', 'src/m/Order.cs'); // ONLY the top-level form exists
        const resolver = makeResolver({
          ownerIndex: { ownerOf: (f: string) => (f === 'src/m/Order.cs' ? 'm' : undefined) } as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        // The nearest expansion is ABSENT (continue); the verbatim then RESOLVES → the binding.
        expect(resolver.classify({ kind: 'symbol', symbolKey: 'App.Models.Order' }, consumer.path, 'csharp')).toEqual({ kind: 'absent' });
        expect(resolver.classify({ kind: 'symbol', symbolKey: 'Models.Order' }, consumer.path, 'csharp')).toEqual({
          kind: 'resolved', ownerNode: 'm', resolvedFile: 'src/m/Order.cs',
        });
      },
    );
  });

  it('DECISIVE FP (extractor/resolver level): a nearer using-relative split binds and the verbatim is NEVER reached', async () => {
    // The decisive false-positive case for this resolution order, at the candidate-walk
    // level. n1 owns
    // `App.Data.Models+Order` (nested) intra-node; n2 owns top-level `Models.Order`. The
    // consumer in `namespace App.Services; using App.Data;` writes `new Models.Order()`.
    // The ordered group [App.Services.Models.Order, App.Data.Models.Order, Models.Order] binds
    // the nearest that resolves — `App.Data.Models.Order` splits at the declared type
    // `App.Data.Models` to `App.Data.Models+Order` → n1 — and STOPS. The verbatim
    // `Models.Order` (which would resolve to n2) is never reached → no n1→n2 edge.
    await parseAll(
      [{ path: 'src/n1/Order.cs', code: 'namespace App.Services;\nusing App.Data;\npublic class C { void M() { var o = new Models.Order(); } }\n' }],
      ([consumer]) => {
        const st = new SymbolTable();
        st.declare('csharp', 'App.Data.Models', 'src/n1/Data.cs'); // the enclosing nested TYPE
        st.declare('csharp', 'App.Data.Models+Order', 'src/n1/Data.cs'); // the nested Order (n1)
        st.declare('csharp', 'Models.Order', 'src/n2/Order.cs'); // top-level Order (n2)
        const resolver = makeResolver({
          ownerIndex: {
            ownerOf: (f: string) => (f === 'src/n1/Data.cs' ? 'n1' : f === 'src/n2/Order.cs' ? 'n2' : undefined),
          } as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        const group = groupContaining(csharpExtractor.uses(consumer), 'Models.Order');
        // Enclosing-ns chain innermost→outermost (App.Services, App), then the using prefix
        // (App.Data), then the verbatim LAST.
        expect(group).toEqual([
          'App.Services.Models.Order',
          'App.Models.Order',
          'App.Data.Models.Order',
          'Models.Order',
        ]);
        // Walk the group in order: first resolved wins and stops.
        const outcomes = group!.map((k) => resolver.classify({ kind: 'symbol', symbolKey: k }, consumer.path, 'csharp'));
        expect(outcomes[0]).toEqual({ kind: 'absent' }); // App.Services.Models.Order — absent
        expect(outcomes[1]).toEqual({ kind: 'absent' }); // App.Models.Order — absent
        // App.Data.Models.Order splits at the declared type App.Data.Models → App.Data.Models+Order → n1.
        expect(outcomes[2]).toEqual({ kind: 'resolved', ownerNode: 'n1', resolvedFile: 'src/n1/Data.cs' }); // binds n1, stop
        // outcomes[3] (verbatim Models.Order → n2) is NEVER reached by the walk, so n2 is never flagged.
        expect(walkResolve(csharpExtractor.uses(consumer), 'Models.Order', resolver, consumer.path)).toBe('n1');
      },
    );
  });
});

describe('csharp SYMBOL-TABLE resolution — the half this language validates', () => {
  it("builds a SymbolTable from two files' declarations() and resolves a third file's qualified use to the right file", async () => {
    await parseAll(
      [
        { path: 'src/a/Gateway.cs', code: 'namespace MyApp.Payments;\npublic class Gateway { }\n' },
        { path: 'src/b/Audit.cs', code: 'namespace MyApp.Audit;\npublic class AuditLog { }\n' },
        { path: 'src/c/Order.cs', code: 'namespace MyApp.Orders;\nclass Order { void M() { var g = new MyApp.Payments.Gateway(); } }\n' },
      ],
      ([fileA, fileB, consumer]) => {
        // Build the shared SymbolTable exactly as pass.ts step 4 does.
        const st = new SymbolTable();
        for (const f of [fileA, fileB]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }

        // The consumer's qualified `new` resolves to fileA. The group is
        // [MyApp.Orders.MyApp.Payments.Gateway (enclosing-ns, absent), MyApp.Payments.Gateway
        // (verbatim, binds)] — the ordered walk skips the absent nearest and binds the verbatim.
        const uses = csharpExtractor.uses(consumer);
        // Enclosing-ns chain innermost→outermost (MyApp.Orders, MyApp), then the verbatim LAST.
        expect(groupContaining(uses, 'MyApp.Payments.Gateway')).toEqual([
          'MyApp.Orders.MyApp.Payments.Gateway',
          'MyApp.MyApp.Payments.Gateway',
          'MyApp.Payments.Gateway',
        ]);
        expect(st.resolveUnique('csharp', 'MyApp.Payments.Gateway')).toBe('src/a/Gateway.cs');

        // And the full resolver wires symbol → owner node (mirrors resolver.ts + the pass walk).
        const ownerIndex = {
          ownerOf: (f: string) =>
            f === 'src/a/Gateway.cs' ? 'a' : f === 'src/b/Audit.cs' ? 'b' : undefined,
        };
        const resolver = makeResolver({
          ownerIndex: ownerIndex as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        expect(walkResolve(uses, 'MyApp.Payments.Gateway', resolver, consumer.path)).toBe('a');
      },
    );
  });

  it('BARE name resolves through the using scope to the right file', async () => {
    await parseAll(
      [
        { path: 'src/a/Gateway.cs', code: 'namespace MyApp.Payments;\npublic class Gateway { }\n' },
        {
          path: 'src/c/Order.cs',
          code: 'using MyApp.Payments;\nnamespace MyApp.Orders;\nclass Order { void M() { var g = new Gateway(); } }\n',
        },
      ],
      ([fileA, consumer]) => {
        const st = new SymbolTable();
        for (const d of csharpExtractor.declarations(fileA)) st.declare('csharp', d.symbolKey, fileA.path);

        // The bare `new Gateway()` group puts the using-prefix expansion `MyApp.Payments.Gateway`
        // ahead of the bare-last `Gateway`; the walk binds it to fileA.
        const uses = csharpExtractor.uses(consumer);
        expect(groupContaining(uses, 'MyApp.Payments.Gateway')).toBeDefined();
        expect(st.resolveUnique('csharp', 'MyApp.Payments.Gateway')).toBe('src/a/Gateway.cs');
        const resolver = makeResolver({
          ownerIndex: { ownerOf: (f: string) => (f === 'src/a/Gateway.cs' ? 'a' : undefined) } as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        expect(walkResolve(uses, 'MyApp.Payments.Gateway', resolver, consumer.path)).toBe('a');
      },
    );
  });

  it('AMBIGUITY: two files declaring the SAME FQN → a use of it resolves to undefined (silence, no flag)', async () => {
    await parseAll(
      [
        { path: 'src/x/Thing.cs', code: 'namespace MyApp.Dup;\npublic class Thing { }\n' },
        { path: 'src/y/Thing.cs', code: 'namespace MyApp.Dup;\npublic class Thing { }\n' },
        { path: 'src/z/Use.cs', code: 'namespace MyApp.Z;\nclass Use { void M() { var t = new MyApp.Dup.Thing(); } }\n' },
      ],
      ([fileX, fileY, consumer]) => {
        const st = new SymbolTable();
        for (const f of [fileX, fileY]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }

        // resolveUnique returns undefined for the ambiguous FQN.
        expect(st.resolveUnique('csharp', 'MyApp.Dup.Thing')).toBeUndefined();

        // Through the ordered walk the use resolves to nothing — the verbatim `MyApp.Dup.Thing`
        // is present-but-ambiguous (2 defs) → the group silences; never a flag.
        const ownerIndex = { ownerOf: () => 'someNode' };
        const resolver = makeResolver({
          ownerIndex: ownerIndex as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        const uses = csharpExtractor.uses(consumer);
        expect(resolver.classify({ kind: 'symbol', symbolKey: 'MyApp.Dup.Thing' }, consumer.path, 'csharp')).toEqual({ kind: 'ambiguous' });
        expect(walkResolve(uses, 'MyApp.Dup.Thing', resolver, consumer.path)).toBeUndefined();
      },
    );
  });
});

describe('csharp anti-FALSE-POSITIVE — the silence list (D8 gate)', () => {
  // Each case must resolve to nothing flaggable. We assert at the resolution layer:
  // every emitted hint resolves to undefined (no in-graph owner) given a SymbolTable
  // that knows only the consumer's own/family types.
  const resolveAll = (
    uses: Awaited<ReturnType<typeof run>>['uses'],
    st: SymbolTable,
    ownerOf: (f: string) => string | undefined,
  ): Array<string | undefined> => {
    const resolver = makeResolver({
      ownerIndex: { ownerOf } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    // Walk each reference's WHOLE ordered group exactly as pass.ts does: the bound owner is
    // the first candidate that resolves (stop), or undefined if a nearer candidate is
    // ambiguous or nothing binds. A silence case must yield undefined for every group.
    return uses.map((u) => {
      for (const cand of u.candidates) {
        const outcome = resolver.classify(cand, 'src/c/Use.cs', 'csharp');
        if (outcome.kind === 'resolved') return outcome.ownerNode;
        if (outcome.kind === 'ambiguous') return undefined;
      }
      return undefined;
    });
  };

  it('DI-container registration emits NO cross-node flag (services.AddScoped<IFoo, Foo>())', async () => {
    const { uses } = await run(
      [
        'using Microsoft.Extensions.DependencyInjection;',
        'class Startup {',
        '  void Configure(IServiceCollection services) {',
        '    services.AddScoped<IFoo, Foo>();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // IFoo / Foo are bare type args → candidates Microsoft.Extensions.DependencyInjection.IFoo etc.
    // None is declared in a symbol table that maps to a node → all undefined.
    const owners = resolveAll(uses, new SymbolTable(), () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('REFLECTION emits NO flag (Type.GetType / Activator.CreateInstance with string names)', async () => {
    const { uses } = await run(
      [
        'using System;',
        'class R {',
        '  void M() {',
        '    var t = Type.GetType("MyApp.Payments.Gateway");',
        '    var o = Activator.CreateInstance(t);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // The FQN is a STRING literal — never a qualified_name node. No symbol hint can
    // resolve to MyApp.Payments.Gateway even if that type is in the table.
    const st = new SymbolTable();
    st.declare('csharp', 'MyApp.Payments.Gateway', 'src/pay/Gateway.cs');
    const owners = resolveAll(uses, st, (f) => (f === 'src/pay/Gateway.cs' ? 'pay' : undefined));
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('EXTENSION METHOD call emits NO flag (order.Validate() — receiver type unknown)', async () => {
    const { uses } = await run(
      ['class C { void M(object order) { order.Validate(); } }', ''].join('\n'),
    );
    // No qualified_name, no base_list, no `new` of a named type → no hints at all.
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('SOURCE-GENERATED / partial type emits NO flag (partial class, no base/new)', async () => {
    const { uses } = await run(['namespace App;', 'partial class Gen { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('`using static X;` emits the fully-qualified TARGET as a sole candidate, NO namespace-prefix expansion', async () => {
    const { uses } = await run(
      ['using static MyApp.Math.Calc;', 'class C { void M() { var r = Compute(); } }', ''].join('\n'),
    );
    // The static-using TARGET `MyApp.Math.Calc` IS a real, fully-qualified type dependency: it is
    // emitted as a ONE-candidate group (no enclosing-ns / using-prefix expansion), so it resolves
    // only when MyApp.Math.Calc is in-graph (external here → silence). Crucially the directive adds
    // NO namespace prefix: `Compute()` (a bare invocation) yields no hint, and no sibling
    // `MyApp.Math.<other>` candidate is ever invented.
    const target = uses.find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === 'MyApp.Math.Calc'));
    expect(target).toBeDefined();
    expect(target!.candidates).toHaveLength(1); // sole verbatim/FQN candidate, no expansion
    // The ONLY `MyApp.Math.*` key is the target itself — never a sibling-namespace expansion.
    expect(symbolKeys(uses).filter((k) => k.startsWith('MyApp.Math'))).toEqual(['MyApp.Math.Calc']);
  });

  it('`global using` from ANOTHER file is invisible: a bare type stays SILENT at resolution', async () => {
    // No using/namespace in this file; the bare base type's only candidate is its verbatim
    // top-level form (`RepositoryBase`, the harmless last candidate). A `global using` declared
    // elsewhere is invisible here, so nothing maps that bare name to a node → SILENCE.
    const { uses } = await run(['class C : RepositoryBase { }', ''].join('\n'));
    expect(symbolKeys(uses)).toEqual(['RepositoryBase']);
    const owners = resolveAll(uses, new SymbolTable(), () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('EXTERNAL/BCL type resolves to NO node (System.* → external, never a violation)', async () => {
    const { uses } = await run(
      ['class C { System.Text.StringBuilder _sb; void M() { var x = new System.Collections.Generic.List<int>(); } }', ''].join('\n'),
    );
    // Candidates like System.Text.StringBuilder are emitted, but the symbol table /
    // owner index never map them to a node → undefined.
    const owners = resolveAll(uses, new SymbolTable(), () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('dependency onto an UNMAPPED type (declared in table, file owned by NO node) → undefined', async () => {
    const { uses } = await run(
      ['class C { void M() { var x = new Foo.Bar.Baz(); } }', ''].join('\n'),
    );
    const st = new SymbolTable();
    st.declare('csharp', 'Foo.Bar.Baz', 'src/unmapped/Baz.cs');
    // ownerOf returns undefined for the unmapped file → resolver yields undefined (D7).
    const owners = resolveAll(uses, st, () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('INTRA-NODE / family reference: resolves to a file, but to the consumer\'s OWN node (no flag at verify layer)', async () => {
    // This case shows the hint DOES resolve — the self/ancestor filtering is the
    // verifier's job (computeBasis), proven by the e2e round-trip. Here we only assert
    // the resolution points to the consumer's own node, which the verifier never flags.
    const { uses } = await run(
      ['namespace App;', 'class C { void M() { var x = new App.Sibling(); } }', ''].join('\n'),
    );
    const st = new SymbolTable();
    st.declare('csharp', 'App.Sibling', 'src/c/Sibling.cs'); // same node as the consumer
    const owners = resolveAll(uses, st, (f) => (f === 'src/c/Sibling.cs' ? 'c' : undefined));
    // It resolves to node 'c' — the consumer's own node — which is never an undeclared
    // cross-node dependency (the verifier's self/family filter handles it).
    expect(owners).toContain('c');
  });
});

describe('csharp NESTED-TYPE resolution + the tri-state / split over-silence guards', () => {
  /** Resolve a reference whose group contains `key`, via the ordered first-unique-match walk. */
  const walk = (
    uses: Awaited<ReturnType<typeof run>>['uses'],
    key: string,
    st: SymbolTable,
    ownerOf: (f: string) => string | undefined,
    fromFile: string,
  ): string | undefined => {
    const resolver = makeResolver({ ownerIndex: { ownerOf } as never, symbolTable: st, resolvePathToFile: () => undefined });
    return walkResolve(uses, key, resolver, fromFile);
  };

  it('RECALL: a cross-node use of `Outer.Inner` resolves to the declaring node via the guarded `+`-split', async () => {
    // Declaration side keys the nested type `App.Outer+Inner`. The use writes `Outer.Inner`
    // (here fully qualified `App.Outer.Inner`); the resolver splits at the declared type
    // `App.Outer` → `App.Outer+Inner` and binds the declaring node.
    await parseAll(
      [
        { path: 'src/a/Nested.cs', code: 'namespace App;\nclass Outer { class Inner { } }\n' },
        { path: 'src/c/Use.cs', code: 'namespace Other;\nclass C { void M() { var x = new App.Outer.Inner(); } }\n' },
      ],
      ([decl, consumer]) => {
        const st = new SymbolTable();
        for (const d of csharpExtractor.declarations(decl)) st.declare('csharp', d.symbolKey, decl.path);
        expect(st.has('csharp', 'App.Outer')).toBe(true); // declared TYPE → the split guard fires
        expect(st.resolveUnique('csharp', 'App.Outer+Inner')).toBe('src/a/Nested.cs');
        const owners = csharpExtractor.uses(consumer);
        expect(walk(owners, 'App.Outer.Inner', st, (f) => (f === 'src/a/Nested.cs' ? 'a' : undefined), consumer.path)).toBe('a');
      },
    );
  });

  it('COLLISION HEALED: a nested `App.Outer+Inner` no longer shadows a top-level `App.Inner` (D-N5)', async () => {
    // A nested Inner (node a) and a top-level Inner (node b) of the same simple name. Because
    // the nested type is keyed `App.Outer+Inner` (not `App.Inner`), a use of the TOP-LEVEL
    // `App.Inner` resolves cleanly to node b — the collateral silencing is gone.
    await parseAll(
      [
        { path: 'src/a/Nested.cs', code: 'namespace App;\nclass Outer { class Inner { } }\n' },
        { path: 'src/b/Inner.cs', code: 'namespace App;\nclass Inner { }\n' },
        { path: 'src/c/Use.cs', code: 'namespace Other;\nclass C { void M() { var x = new App.Inner(); } }\n' },
      ],
      ([nested, topLevel, consumer]) => {
        const st = new SymbolTable();
        for (const f of [nested, topLevel]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }
        expect(st.resolveUnique('csharp', 'App.Inner')).toBe('src/b/Inner.cs'); // exactly one def now
        const owners = csharpExtractor.uses(consumer);
        expect(walk(owners, 'App.Inner', st, (f) => (f === 'src/b/Inner.cs' ? 'b' : undefined), consumer.path)).toBe('b');
      },
    );
  });

  it('GUARD HOLDS: a namespace-`Foo` type-`Bar` use is NOT re-read as nested `Foo+Bar` even if one coincidentally exists', async () => {
    // `Foo` is a NAMESPACE (no `Foo` type declared), so the `Foo.Bar` use is not split at
    // `Foo`. A coincidental nested `Foo+Bar` in another node must NOT be matched → silence,
    // even though `Foo.Bar` (top-level dotted) maps to node x.
    await parseAll(
      [
        { path: 'src/y/Coin.cs', code: 'namespace App;\nclass Foo { class Bar { } }\n' }, // App.Foo+Bar
        { path: 'src/x/Bar.cs', code: 'namespace Foo;\nclass Bar { }\n' }, // Foo.Bar (namespace Foo)
        { path: 'src/c/Use.cs', code: 'namespace Other;\nclass C { void M() { var x = new Foo.Bar(); } }\n' },
      ],
      ([coincidental, real, consumer]) => {
        const st = new SymbolTable();
        for (const f of [coincidental, real]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }
        // `Foo` is NOT a declared type (only the namespace), so no split of `Foo.Bar` at `Foo`.
        expect(st.has('csharp', 'Foo')).toBe(false);
        const owners = csharpExtractor.uses(consumer);
        // `Foo.Bar` (verbatim) binds the real top-level `Foo.Bar` in node x; the coincidental
        // `App.Foo+Bar` is NEVER produced for this use. So it resolves to x (the legitimate dotted
        // top-level type), NOT ambiguously to y.
        expect(walk(owners, 'Foo.Bar', st, (f) => (f === 'src/x/Bar.cs' ? 'x' : f === 'src/y/Coin.cs' ? 'y' : undefined), consumer.path)).toBe('x');
      },
    );
  });

  it('SPLIT AMBIGUITY SILENCES: two mapped files both declaring `App.Outer+Inner` → silence, not a flag', async () => {
    await parseAll(
      [
        { path: 'src/a/Nested.cs', code: 'namespace App;\nclass Outer { class Inner { } }\n' },
        { path: 'src/b/Nested.cs', code: 'namespace App;\nclass Outer { class Inner { } }\n' },
        { path: 'src/c/Use.cs', code: 'namespace Other;\nclass C { void M() { var x = new App.Outer.Inner(); } }\n' },
      ],
      ([a, b, consumer]) => {
        const st = new SymbolTable();
        for (const f of [a, b]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }
        const owners = csharpExtractor.uses(consumer);
        // `App.Outer` is declared in two files (defCount 2) — the split guard `has` still fires,
        // but the split key `App.Outer+Inner` maps to two files → ≥2 distinct → ambiguous → silence.
        expect(walk(owners, 'App.Outer.Inner', st, () => 'someNode', consumer.path)).toBeUndefined();
      },
    );
  });

  it('USING-LEVEL CS0104: two usings each defining `Widget` → the using tier is AMBIGUOUS → SILENCE (never the foreign verbatim either)', async () => {
    // `using L1; using L2;` both declare `Widget`; a stray top-level `Widget` also exists in
    // node d. The bare base `Widget`'s ordered group is the enclosing-ns level, then the
    // code-point-sorted using prefixes (L1.Widget, L2.Widget), then the verbatim `Widget` LAST.
    // The using-prefix expansions form ONE binding level (a CS0104 set): both L1.Widget and
    // L2.Widget resolve, to DIFFERENT nodes → the simple name is genuinely ambiguous per the C#
    // spec → the whole group SILENCES. It binds NEITHER an arbitrary import NOR the foreign
    // top-level `Widget` in node d. Zero edge, zero false positive.
    await parseAll(
      [
        { path: 'src/a/W.cs', code: 'namespace L1;\nclass Widget { }\n' },
        { path: 'src/b/W.cs', code: 'namespace L2;\nclass Widget { }\n' },
        { path: 'src/d/W.cs', code: 'class Widget { }\n' }, // top-level `Widget` — must NEVER bind
        { path: 'src/c/Use.cs', code: 'using L1;\nusing L2;\nnamespace App;\nclass C : Widget { }\n' },
      ],
      ([l1, l2, verbatim, consumer]) => {
        const st = new SymbolTable();
        for (const f of [l1, l2, verbatim]) {
          for (const d of csharpExtractor.declarations(f)) st.declare('csharp', d.symbolKey, f.path);
        }
        const owners = csharpExtractor.uses(consumer);
        const group = groupContaining(owners, 'Widget')!;
        // Verbatim LAST; using prefixes code-point sorted ahead of it.
        expect(group).toEqual(['App.Widget', 'L1.Widget', 'L2.Widget', 'Widget']);
        expect(group[group.length - 1]).toBe('Widget');
        const resolver = makeResolver({
          ownerIndex: {
            ownerOf: (f: string) => (f === 'src/a/W.cs' ? 'a' : f === 'src/b/W.cs' ? 'b' : f === 'src/d/W.cs' ? 'd' : undefined),
          } as never,
          symbolTable: st,
          resolvePathToFile: () => undefined,
        });
        const bound = walkResolve(owners, 'Widget', resolver, consumer.path);
        expect(bound).toBeUndefined(); // CS0104: ambiguous using tier silences the whole group
      },
    );
  });
});

describe('csharp extractor — registry wiring', () => {
  it('declares the csharp language', () => {
    expect(csharpExtractor.languages.has('csharp')).toBe(true);
  });
});
