import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { kotlinExtractor } from '../../../../src/relations/extractors/kotlin.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFiles, type ParseSpec } from '../../helpers/with-parsed-files.js';
import { kotlinView } from '../../../../src/relations/extractors/kotlin-recover.js';

const run = (code: string) => runExtractor(kotlinExtractor, 'kotlin', '.kt', code);

const symbolKeys = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'symbol' ? [u.candidates[0].symbolKey] : []));

/** A Kotlin (path, code) pair as a withParsedFiles spec. */
const kt = (path: string, code: string): ParseSpec => ({ path, code, language: 'kotlin' });

describe('kotlin extractor — uses() emits SYMBOL hints (not path hints)', () => {
  it('emits the imported FQN as a symbol hint for a single-type import', async () => {
    const { uses } = await run('package com.acme.app\nimport com.acme.payments.PaymentService\nclass C\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [{ kind: 'symbol', symbolKey: 'com.acme.payments.PaymentService' }],
        kind: 'import',
      }),
    );
    // It must NOT be a path hint — Kotlin resolves through the SymbolTable.
    expect(uses.every((u) => u.candidates[0].kind === 'symbol')).toBe(true);
  });

  it('IGNORES the alias of `import ... as B` — the hint is the real FQN', async () => {
    const { uses } = await run('import com.acme.util.Helpers as H\nclass C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('com.acme.util.Helpers');
    // The alias `H` is a local binding only — never the dependency target.
    expect(keys).not.toContain('H');
    expect(keys.every((k) => !k.includes(' as '))).toBe(true);
  });

  it('emits `<package>.*` for a star import (the resolver collapses it by owner)', async () => {
    const { uses } = await run('import com.acme.audit.*\nimport com.acme.audit.Log\nclass C\n');
    const keys = symbolKeys(uses);
    // The `*` is a separate token; the qualified_identifier is the package, re-marked with `.*`.
    expect(keys).toContain('com.acme.audit.*');
    expect(keys).toContain('com.acme.audit.Log');
    expect(keys).not.toContain('com.acme.audit');
  });

  it('emits a stdlib/external import FQN unchanged (silencing is the SymbolTable job)', async () => {
    const { uses } = await run('import kotlin.collections.List\nimport java.util.ArrayList\nclass C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('kotlin.collections.List');
    expect(keys).toContain('java.util.ArrayList');
  });

  it('collects every import in a multi-import file', async () => {
    const { uses } = await run(
      ['package com.acme.app', 'import com.acme.a.Alpha', 'import com.acme.b.Beta', 'class C', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('com.acme.a.Alpha');
    expect(keys).toContain('com.acme.b.Beta');
  });

  it('deduplicates two identical imports that begin on the same line', async () => {
    // Two `import a.B` statements on ONE line collide on the `<symbolKey> <line>` dedup
    // key — only one symbol hint is emitted (the seen-set true-arm).
    const { uses } = await run('import a.B;import a.B\nclass C\n');
    expect(symbolKeys(uses)).toEqual(['a.B']);
  });

  it('emits a SYMBOL hint for an inline fully-qualified TYPE reference (type position is shadow-free)', async () => {
    // A multi-segment user_type written inline in a TYPE position — supertype list,
    // by-delegation supertype, property / parameter / return type — is a fully-qualified
    // name with exactly one meaning, so it resolves through the SymbolTable like an import.
    const { uses } = await run(
      [
        'package com.acme.app',
        'class C : com.acme.base.Base(), com.acme.flow.Flowable by delegate {',
        '  val r: com.acme.model.Repo? = null',
        '  fun m(l: com.acme.metrics.Logger): com.acme.model.Result = TODO()',
        '}',
        '',
      ].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('com.acme.base.Base'); // superclass
    expect(keys).toContain('com.acme.flow.Flowable'); // by-delegation supertype
    expect(keys).toContain('com.acme.model.Repo'); // property type
    expect(keys).toContain('com.acme.metrics.Logger'); // parameter type
    expect(keys).toContain('com.acme.model.Result'); // return type
    // The hints are SYMBOL hints (Kotlin resolves through the SymbolTable, never a path).
    expect(uses.every((u) => u.candidates[0].kind === 'symbol')).toBe(true);
  });

  it('emits NOTHING for EXPRESSION-position references (ctor call, qualified call, `::member`, `::class`)', async () => {
    // An EXPRESSION-position reference — a constructor call, a qualified member call, a
    // `::member` callable reference, a `::class` literal — parses as a navigation_expression /
    // member-access chain that is indistinguishable from `localVariable.field.method`, so
    // binding it could pick the wrong target. It is deliberately left silent (zero-FP boundary).
    const { uses } = await run(
      [
        'package com.acme.app',
        'fun m() {',
        '  val t = com.acme.metrics.Timer()',
        '  com.acme.audit.AuditLog.record("x")',
        '  val ref = com.acme.util.Helpers::format',
        '  val k = com.acme.model.Order::class',
        '}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });
});

describe('kotlin extractor — declarations() produce <package>.<Name> FQN keys', () => {
  it('prefixes class / interface / object / function / property / typealias with the package', async () => {
    const { declarations } = await run(
      [
        'package com.acme.app',
        'class Foo',
        'interface Bar',
        'object Baz',
        'fun qux() {}',
        'val quux = 1',
        'typealias Money = Long',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('com.acme.app.Foo');
    expect(keys).toContain('com.acme.app.Bar'); // interface parses as class_declaration
    expect(keys).toContain('com.acme.app.Baz');
    expect(keys).toContain('com.acme.app.qux');
    expect(keys).toContain('com.acme.app.quux');
    expect(keys).toContain('com.acme.app.Money');
  });

  it('uses the BARE name when the file has no package_header (root package / .kts)', async () => {
    const { declarations } = await run('class Foo\nfun bar() {}\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('bar');
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('indexes a modifier-prefixed property (skips the leading non-variable_declaration child)', async () => {
    // `const val PI = 3` puts a `modifiers` node before the `variable_declaration`, so
    // the property loop skips the first named child (it is not a variable_declaration)
    // before finding the name. The FQN is still emitted.
    const { declarations } = await run('package com.acme.app\nconst val PI = 3\n');
    expect(declarations.map((d) => d.symbolKey)).toContain('com.acme.app.PI');
  });

  it('emits NO key for a destructuring property declaration (no single name)', async () => {
    // `val (a, b) = pair` nests a `multi_variable_declaration`, not a
    // `variable_declaration`; v1 indexes only the single-name form, so declarationName
    // yields nothing and the declaration is skipped — no symbol key for a or b.
    const { declarations } = await run('package com.acme.app\nval (a, b) = pair\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).not.toContain('com.acme.app.a');
    expect(keys).not.toContain('com.acme.app.b');
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('package p\n\nclass OnLineThree\n');
    const foo = declarations.find((d) => d.symbolKey === 'p.OnLineThree');
    expect(foo?.line).toBe(3);
  });
});

describe('kotlin SYMBOL-TABLE resolution — the half this language validates', () => {
  it("builds a SymbolTable from two files' declarations() and resolves a third file's import hint to the right file", async () => {
    ensureLoaderRegistered();
    // Two declaring files in different packages, plus a consumer that imports one of them.
    await withParsedFiles(
      [
        kt('src/a/PaymentService.kt', 'package com.acme.payments\nclass PaymentService\n'),
        kt('src/b/AuditLog.kt', 'package com.acme.audit\nobject AuditLog\n'),
        kt('src/c/Order.kt', 'package com.acme.orders\nimport com.acme.payments.PaymentService\nclass Order\n'),
      ],
      ([fileA, fileB, consumer]) => {
        // Build the shared SymbolTable exactly as pass.ts step 4 does.
        const st = new SymbolTable();
        for (const f of [fileA, fileB]) {
          for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
        }

        // The consumer's import hint must resolve to fileA via resolveUnique.
        const uses = kotlinExtractor.uses(consumer);
        const importHint = uses.find((u) => u.candidates[0].kind === 'symbol');
        expect(importHint?.candidates[0]).toEqual({ kind: 'symbol', symbolKey: 'com.acme.payments.PaymentService' });
        expect(st.resolveUnique('kotlin', 'com.acme.payments.PaymentService')).toBe('src/a/PaymentService.kt');

        // And the full resolver wires symbol → owner node (mirrors resolver.ts).
        const ownerIndex = { ownerOf: (f: string) => (f === 'src/a/PaymentService.kt' ? 'a' : f === 'src/b/AuditLog.kt' ? 'b' : undefined) };
        const resolver = makeResolver({ ownerIndex: ownerIndex as never, symbolTable: st, resolvePathToFile: () => undefined });
        expect(resolver.resolve(importHint!.candidates[0], consumer.path, 'kotlin')).toEqual({
          ownerNode: 'a',
          resolvedFile: 'src/a/PaymentService.kt',
        });
      },
    );
  });

  it('AMBIGUITY: two files declaring the SAME FQN → a use of it resolves to undefined (silence, no flag)', async () => {
    ensureLoaderRegistered();
    // Two files both declare com.acme.dup.Thing — the FQN is ambiguous.
    await withParsedFiles(
      [
        kt('src/x/Thing.kt', 'package com.acme.dup\nclass Thing\n'),
        kt('src/y/Thing.kt', 'package com.acme.dup\nclass Thing\n'),
        kt('src/z/Use.kt', 'package com.acme.z\nimport com.acme.dup.Thing\nclass Use\n'),
      ],
      ([fileX, fileY, consumer]) => {
        const st = new SymbolTable();
        for (const f of [fileX, fileY]) {
          for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
        }

        // resolveUnique returns undefined for the ambiguous FQN.
        expect(st.resolveUnique('kotlin', 'com.acme.dup.Thing')).toBeUndefined();

        // Through the resolver the use also resolves to undefined — silence, never a flag.
        const ownerIndex = { ownerOf: (f: string) => f.split('/')[1] }; // src/<node>/… — the two declaring files are two NODES
        const resolver = makeResolver({ ownerIndex: ownerIndex as never, symbolTable: st, resolvePathToFile: () => undefined });
        const importHint = kotlinExtractor.uses(consumer).find((u) => u.candidates[0].kind === 'symbol')!;
        expect(resolver.resolve(importHint.candidates[0], consumer.path, 'kotlin')).toBeUndefined();
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parse recovery (kotlin-recover.ts): syntax the shipped grammar predates must not erase the
// declarations after it, and what stays unreadable must fail closed.
describe('kotlin extractor — parse recovery for Kotlin 2.2+ syntax', () => {
  const keysOf = (decls: { symbolKey: string }[]): string[] => decls.map((d) => d.symbolKey);

  it('a when-guard no longer erases later declarations, imports-after types, or line numbers', async () => {
    const { declarations, uses } = await run(
      [
        'package p',
        'fun kind(v: Any) = when (v) {',
        '    is String if v.isNotEmpty() -> 1',
        '    else if v == 0 -> 2',
        '    else -> 3',
        '}',
        'class After',
        'val repo: com.acme.data.Repo? = null',
        '',
      ].join('\n'),
    );
    const keys = keysOf(declarations);
    expect(keys).toEqual(expect.arrayContaining(['p.kind', 'p.After', 'p.repo']));
    expect(keys.some((k) => k.endsWith('*'))).toBe(false); // fully recovered → no marker
    expect(declarations.find((d) => d.symbolKey === 'p.After')?.line).toBe(7);
    expect(symbolKeys(uses)).toContain('com.acme.data.Repo');
  });

  it('a multi-dollar string (plain and raw, with a `$${…}` template) no longer erases later declarations', async () => {
    const { declarations } = await run(
      ['package p', 'val a = $$"price: $$amount"', 'val b = $$"""{ "$schema": "$${id}" }"""', 'class After', ''].join('\n'),
    );
    expect(keysOf(declarations)).toEqual(expect.arrayContaining(['p.a', 'p.b', 'p.After']));
    expect(keysOf(declarations).some((k) => k.endsWith('*'))).toBe(false);
  });

  it('a context-parameter clause (top level and on a member) keeps the decorated declarations', async () => {
    const { declarations } = await run(
      [
        'package p',
        'context(log: Logger)',
        'fun save() {}',
        'class Svc {',
        '    context(log: Logger, tx: Tx)',
        '    fun run() {}',
        '    fun other() {}',
        '}',
        '',
      ].join('\n'),
    );
    expect(keysOf(declarations)).toEqual(expect.arrayContaining(['p.save', 'p.Svc', 'p.Svc+run', 'p.Svc+other']));
    expect(keysOf(declarations).some((k) => k.endsWith('*'))).toBe(false);
  });

  it('an unreadable declaration marks the package incomplete and never trusts a name behind the damage', async () => {
    const { declarations } = await run(['package p', 'public %% class Thing', 'class Other', ''].join('\n'));
    const keys = keysOf(declarations);
    expect(keys).toContain('p.*');
    expect(keys).toContain('p.Other');
    expect(keys).not.toContain('p.Thing');
  });

  it('a class whose body cannot be parsed keeps its name and marks its members incomplete; later classes survive', async () => {
    const { declarations } = await run(
      ['package p', 'class Box {', '  public %% fun hidden() {}', '  fun shown() {}', '}', 'class After', ''].join('\n'),
    );
    const keys = keysOf(declarations);
    expect(keys).toEqual(expect.arrayContaining(['p.Box', 'p.Box+*', 'p.After']));
    expect(keys).not.toContain('p.*');
    expect(keys).not.toContain('p.Box+hidden');
  });

  it('a file the grammar reads cleanly gets no marker', async () => {
    const { declarations } = await run('package p\nclass A\nfun f() = 1\n');
    expect(keysOf(declarations).some((k) => k.includes('*'))).toBe(false);
  });

  it('a one-line class body (a MISSING separator in the shipped grammar, no ERROR) is read as it stands', async () => {
    const { declarations } = await run('package p\nclass A { val x = 1 }\nclass B\n');
    const keys = keysOf(declarations);
    expect(keys).toEqual(expect.arrayContaining(['p.A', 'p.A+x', 'p.B']));
    expect(keys.some((k) => k.includes('*'))).toBe(false);
  });
});

describe('kotlin extractor — local declarations and JVM file facades', () => {
  it('does not key declarations local to a function, lambda, init block, accessor, constructor or object expression', async () => {
    const { declarations } = await run(
      [
        'package p',
        'class R {',
        '    fun render(): String { val format = "%d"; class Row; fun helper() = 1; return format }',
        '    init { val fromInit = 2 }',
        '    val p: Int get() { val inGetter = 1; return inGetter }',
        '    constructor(x: Int) { val inCtor = x }',
        '    val member = 3',
        '}',
        'fun top() = listOf(1).map { val inLambda = it; inLambda }',
        'val anon = object : Any() { val inObject = 1 }',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    for (const local of ['format', 'Row', 'helper', 'fromInit', 'inGetter', 'inCtor', 'inLambda', 'inObject']) {
      expect(keys.some((k) => k === `p.${local}` || k.endsWith(`+${local}`))).toBe(false);
    }
    expect(keys).toEqual(expect.arrayContaining(['p.R', 'p.R+render', 'p.R+member', 'p.top', 'p.anon']));
  });

  it('declares the `<File>Kt` facade for a file with a top-level function or property, the @file:JvmName name when given, none for classes only', async () => {
    ensureLoaderRegistered();
    await withParsedFiles(
      [
        kt('src/a/order-utils.kt', 'package p\nfun place() {}\n'),
        kt('src/b/Pricing.kt', '@file:JvmName("PriceMath")\npackage p\nval VAT = 23\n'),
        kt('src/c/Model.kt', 'package p\nclass Model\n'),
        kt('src/d/script.kts', 'package p\nfun run() {}\n'),
      ],
      ([a, b, c, d]) => {
        expect(kotlinExtractor.declarations(a).map((x) => x.symbolKey)).toContain('p.Order_utilsKt');
        const bKeys = kotlinExtractor.declarations(b).map((x) => x.symbolKey);
        expect(bKeys).toContain('p.PriceMath');
        expect(bKeys).not.toContain('p.PricingKt');
        expect(kotlinExtractor.declarations(c).map((x) => x.symbolKey).some((k) => k.endsWith('Kt'))).toBe(false);
        expect(kotlinExtractor.declarations(d).map((x) => x.symbolKey).some((k) => k.endsWith('Kt'))).toBe(false);
      },
    );
  });
});

describe('kotlin extractor — parse recovery reads headers and lexes defensively', () => {
  const keysOf = (decls: { symbolKey: string }[]): string[] => decls.map((d) => d.symbolKey);

  it('reads a damaged declaration header through annotations, modifiers, generics and receivers', async () => {
    const { declarations } = await run(
      [
        'package p',
        '@Deprecated("x") @a.b.Marker(1) @[A B] @Gen<Int> public fun <T> List<T>.ext(): Int { %% }',
        'fun interface Handler { %% }',
        'typealias Alias = %%',
        'val <T> T.prop: Int get() = %%',
        'var byDel by lazy { %% }',
        'val (a, b) = %%',
        'object Obj { %% }',
        'class `Quoted` { %% }',
        'class Last',
        '',
      ].join('\n'),
    );
    const keys = keysOf(declarations);
    expect(keys).toEqual(
      expect.arrayContaining(['p.ext', 'p.Handler', 'p.Handler+*', 'p.Alias', 'p.prop', 'p.byDel', 'p.Obj', 'p.Obj+*', 'p.Quoted', 'p.Last', 'p.XKt']),
    );
    expect(keys).not.toContain('p.a');
    expect(keys).not.toContain('p.*'); // every damaged header was readable
  });

  it('an unreadable header fails the package closed: function-type receiver, name on the next line, junk', async () => {
    for (const line of ['fun ((Int) -> Unit).weird() { %% }', 'val\n  split = %%', '%% junk', 'val x.%%']) {
      const { declarations } = await run(`package p\n${line}\nclass After\n`);
      expect(keysOf(declarations), line).toContain('p.*');
      expect(keysOf(declarations), line).toContain('p.After');
    }
  });

  it('lexes comments, char literals, escapes, templates and raw strings without mis-splitting declarations', async () => {
    const { declarations } = await run(
      [
        'package p',
        '// line comment {',
        '/* block /* nested { */ still */',
        "val c = '{'",
        "val e = '\\''",
        'val s = "a\\"b ${ "inner {" } $x"',
        'val r = """raw ${ """x""" } """"',
        'val m = $$"""{ $${ "q" } }"""',
        'val d = 1 + $',
        'class After { fun f() = 1 }',
        'public %% class Broken',
        '',
      ].join('\n'),
    );
    const keys = keysOf(declarations);
    expect(keys).toEqual(expect.arrayContaining(['p.c', 'p.e', 'p.s', 'p.r', 'p.m', 'p.After', 'p.After+f', 'p.*']));
    expect(keys).not.toContain('p.Broken');
  });

  it('a literal or comment that runs off the end makes the split untrustworthy → package incomplete', async () => {
    for (const tail of ['@Anno(( %%', 'val s = "open', '/* open', 'val t = """open', 'val u = "${ open', 'fun g() {']) {
      const { declarations } = await run(`package p\nclass A { %% }\n${tail}\n`);
      expect(keysOf(declarations), tail).toContain('p.*');
    }
  });

  it('blanks only real guards and context clauses', async () => {
    const { declarations } = await run(
      [
        'package p',
        'fun a(x: Any, y: Boolean) = when (x) {',
        '    is Int if y -> 1',
        '    is Long if (if (y) true else false) -> 2',
        '    else -> 3',
        '}',
        'fun b(y: Boolean) = when {',
        '    y -> 1',
        '    else -> 2',
        '}',
        'fun c(x: Int) = when (x) { 1 -> 2; else -> 3 }',
        'private context(l: Logger)',
        'fun d() {}',
        'val f = context(1)',
        'class After',
        '',
      ].join('\n'),
    );
    expect(keysOf(declarations)).toEqual(expect.arrayContaining(['p.a', 'p.b', 'p.c', 'p.d', 'p.After']));
  });

  it('kotlinView releases its trees once, however often dispose is called', async () => {
    ensureLoaderRegistered();
    const code = 'package p\ncontext(l: Logger)\nfun d() {}\n';
    await withParsedFiles([kt('src/a/D.kt', code)], ([f]) => {
      const view = kotlinView(f.tree, f.content);
      expect(view.roots.length).toBeGreaterThan(0);
      view.dispose();
      view.dispose();
    });
  });

  it('names the facade from a qualified `kotlin.jvm.JvmName`, ignores other file annotations, and escapes a leading digit', async () => {
    ensureLoaderRegistered();
    await withParsedFiles(
      [
        kt('src/a/Util.kt', '@file:Suppress("x")\n@file:kotlin.jvm.JvmName("Utils")\npackage p\nfun f() {}\n'),
        kt('src/b/1util.kt', 'package p\nfun g() {}\n'),
      ],
      ([a, b]) => {
        expect(kotlinExtractor.declarations(a).map((x) => x.symbolKey)).toContain('p.Utils');
        expect(kotlinExtractor.declarations(b).map((x) => x.symbolKey)).toContain('p._1utilKt');
      },
    );
  });
});

describe('kotlin extractor — registry wiring', () => {
  it('declares the kotlin language', () => {
    expect(kotlinExtractor.languages.has('kotlin')).toBe(true);
  });
});
