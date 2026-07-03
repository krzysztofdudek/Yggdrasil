import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { csharpExtractor } from '../../../../src/relations/extractors/csharp.js';
import type { DetectedDep } from '../../../../src/relations/extractors/types.js';

/**
 * Branch-coverage tests for the C# extractor targeting the advanced type-reference
 * forms the primary suite does not exercise: attribute usages (`[Foo]` two-reading
 * group, generic `[Foo<Bar>]`), tuple element types, `global::`-rooted and namespace-
 * alias (`S::Tail`) inline references, C#12 alias-RHS embedded types inside tuple/array
 * wrappers, `is`-constant-pattern type references, and block-namespace name skipping.
 * Each test asserts the concrete symbol candidate the extractor emits.
 */

const run = (code: string) => runExtractor(csharpExtractor, 'csharp', '.cs', code);

/** Every symbol key across every candidate of every detected reference. */
const symbolKeys = (uses: DetectedDep[]): string[] =>
  uses.flatMap((u) => u.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : [])));

/** The ordered candidate keys of the FIRST detected reference whose group contains `key`. */
const groupContaining = (uses: DetectedDep[], key: string): string[] | undefined => {
  const dep = uses.find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key));
  return dep?.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : []));
};

describe('csharp extractor — attribute usages emit a two-reading group', () => {
  it('emits BOTH the verbatim and the `Attribute`-suffixed reading for `[Foo]`', async () => {
    const { uses } = await run('namespace App;\n[Route]\nclass Handler {}\n');
    const keys = symbolKeys(uses);
    // The C# convention: `[Route]` may name `Route` OR `RouteAttribute`.
    expect(keys).toContain('Route');
    expect(keys).toContain('RouteAttribute');
    // Both readings live in ONE ordered group (an attribute is a single dependency).
    const group = groupContaining(uses, 'Route');
    expect(group).toContain('Route');
    expect(group).toContain('RouteAttribute');
  });

  it('does NOT double-suffix an already-`Attribute`-suffixed name `[FooAttribute]`', async () => {
    const { uses } = await run('namespace App;\n[RouteAttribute]\nclass Handler {}\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('RouteAttribute');
    // No `RouteAttributeAttribute` — the suffixed reading is suppressed when already suffixed.
    expect(keys).not.toContain('RouteAttributeAttribute');
  });

  it('reads a generic attribute `[Foo<Bar>]` as the base name plus each type argument', async () => {
    const { uses } = await run('namespace App;\n[Validate<Models.Customer>]\nclass Handler {}\n');
    const keys = symbolKeys(uses);
    // Base container name resolves the attribute class (verbatim + suffixed reading).
    expect(keys).toContain('Validate');
    expect(keys).toContain('ValidateAttribute');
    // Each generic type ARGUMENT is its own real type reference.
    expect(keys).toContain('Models.Customer');
  });
});

describe('csharp extractor — tuple element types are real references', () => {
  it('emits each NAMED element type of a tuple field type', async () => {
    const { uses } = await run(
      'namespace App;\nclass C {\n  (int, Models.Customer) Pair;\n}\n',
    );
    const keys = symbolKeys(uses);
    // `int` is a predefined type (no dep); the named element is a dependency.
    expect(keys).toContain('Models.Customer');
  });
});

describe('csharp extractor — global:: and namespace-alias inline references', () => {
  it('resolves a `global::A.B.C` reference from the root as its sole candidate', async () => {
    const { uses } = await run('namespace App;\nclass C {\n  global::Other.Models.User U;\n}\n');
    const keys = symbolKeys(uses);
    // The `global::` qualifier is stripped; the clean FQN is the reference.
    expect(keys).toContain('Other.Models.User');
    // A rooted reference resolves verbatim only — no enclosing-ns/using expansion candidates.
    const group = groupContaining(uses, 'Other.Models.User');
    expect(group).toEqual(['Other.Models.User']);
  });

  it('rewrites a `using`-alias-qualified `S::Tail` reference to the aliased FQN', async () => {
    const { uses } = await run(
      'using S = App.Space;\nnamespace App;\nclass C {\n  S::Widget W;\n}\n',
    );
    const keys = symbolKeys(uses);
    // `S::Widget` with `using S = App.Space;` rewrites to `App.Space.Widget`, resolved from root.
    expect(keys).toContain('App.Space.Widget');
  });

  it('leaves a non-global `::`-qualified reference intact (silence-by-luck at resolution)', async () => {
    const { uses } = await run('namespace App;\nclass C {\n  Lib::Space.Widget W;\n}\n');
    const keys = symbolKeys(uses);
    // With no `using Lib = ...;` the `::` text is kept verbatim: it can never match a dot-only
    // declaration key, so it resolves to nothing (R13) rather than being rewritten to a real FQN.
    expect(keys).toContain('Lib::Space.Widget');
    // It is NOT rewritten into a resolvable dot-only key such as `Space.Widget`.
    expect(keys).not.toContain('Space.Widget');
  });
});

describe('csharp extractor — C#12 alias-RHS embedded named types', () => {
  it('harvests a named type embedded in an alias RHS TUPLE', async () => {
    const { uses } = await run('using P = (int, App.Models.Order);\nclass C {}\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('App.Models.Order');
  });

  it('harvests a named type embedded in an alias RHS ARRAY', async () => {
    const { uses } = await run('using A = App.Models.Row[];\nclass C {}\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('App.Models.Row');
  });
});

describe('csharp extractor — is-pattern constant type reference', () => {
  it('emits the bare type named in an `o is Zed` constant pattern', async () => {
    const { uses } = await run(
      'namespace App;\nclass C {\n  bool M(object o) => o is Widget;\n}\n',
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('Widget');
  });
});

describe('csharp extractor — block namespace declaration', () => {
  it('qualifies types by a BLOCK namespace and does not treat the namespace name as a use', async () => {
    const { declarations, uses } = await run(
      'namespace App.Services {\n  class Handler {\n    Models.Customer C;\n  }\n}\n',
    );
    // The declared type is namespace-qualified from the block namespace.
    expect(declarations.map((d) => d.symbolKey)).toContain('App.Services.Handler');
    // The namespace NAME `App.Services` is not emitted as a dependency; the field type is.
    const keys = symbolKeys(uses);
    expect(keys).not.toContain('App.Services');
    expect(keys.some((k) => k.endsWith('Models.Customer'))).toBe(true);
  });
});
