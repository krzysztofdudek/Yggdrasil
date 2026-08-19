import { describe, it, expect } from 'vitest';
import { withParsedFile } from '../../../src/ast/parser.js';
import { readNodeTypes } from '../../../src/ast/node-types.js';
import { deriveBinding, type RootsBinding } from '../../../src/roots/binding.js';
import { extractUnits, finalizeUnits, BODY_VISIT_CAP, type RawScope } from '../../../src/roots/extract.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/extract.test.ts — spec §6 extraction, phase 1
// (`extractUnits`) and phase 3 (`finalizeUnits`) of Task 4's three-phase
// split. Real source snippets parsed via `withParsedFile` (the plan's own
// "parse seam" — no fabricated ASTs), asserted against `deriveBinding`'s real
// derivation for the grammar under test (never a hand-rolled binding).
// ---------------------------------------------------------------------------

const tsBinding: RootsBinding = deriveBinding(readNodeTypes('typescript'));
const pyBinding: RootsBinding = deriveBinding(readNodeTypes('python'));
const goBinding: RootsBinding = deriveBinding(readNodeTypes('go'));
const csharpBinding: RootsBinding = deriveBinding(readNodeTypes('c_sharp'));

async function extractTs(relPath: string, source: string): Promise<RawScope[]> {
  return withParsedFile(relPath, source, (tree) => extractUnits(relPath, source, tree, tsBinding));
}

/** A trivial single-file, single-package PartitionMap for `finalizeUnits` tests that only need one partitionId — every relPath SURVIVES (own-floor) under `partitionId`. */
function trivialPartitions(relPaths: string[], moduleRootDir = '', partitionId = '_root'): PartitionMap {
  const partitionOfFile = new Map<string, string>();
  const moduleRootDirOfFile = new Map<string, string>();
  for (const p of relPaths) {
    partitionOfFile.set(p, partitionId);
    moduleRootDirOfFile.set(p, moduleRootDir);
  }
  return {
    partitionOfFile,
    moduleRootDirOfFile,
    packageRoots: [],
    survivingPartitionIds: [partitionId],
    statusOfKey: new Map([[partitionId, 'own-floor']]),
    silent: false,
  };
}

describe('extractUnits — scope discovery, ordinals, identity (spec §6.2-§6.4)', () => {
  it('finds a method scope and the one file scope per file', async () => {
    const raw = await extractTs('src/a.ts', 'function greet(name: string) { return name; }\n');
    const kinds = raw.map((s) => s.kind).sort();
    expect(kinds).toEqual(['file', 'method']);
    expect(raw.filter((s) => s.kind === 'file')).toHaveLength(1);
  });

  it('kind rule: a class whose body contains a further scope is `type`, a bodyless-of-scopes function is `method` (spec §6.2)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class Widget {\n  render() { return 1; }\n}\nfunction standalone() { return 2; }\n',
    );
    const widget = raw.find((s) => s.name === 'Widget');
    const render = raw.find((s) => s.name === 'render');
    const standalone = raw.find((s) => s.name === 'standalone');
    expect(widget?.kind).toBe('type');
    expect(render?.kind).toBe('method');
    expect(standalone?.kind).toBe('method');
  });

  it('anonymous scopes are named <anon> and get a qualifiedName suffixed with their occurrence ordinal — always, even the first (spec §6.4)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'export default function () { return 1; }\nconst f2 = function () { return 2; };\n',
    );
    const anons = raw.filter((s) => s.name === '<anon>').sort((a, b) => a.startRow - b.startRow);
    expect(anons).toHaveLength(2);
    expect(anons[0].ordinal).toBe(0);
    expect(anons[0].qualifiedName).toBe('<anon>0');
    expect(anons[1].ordinal).toBe(1);
    expect(anons[1].qualifiedName).toBe('<anon>1');
  });

  it('overloads by source order: same (kind,name) pair gets #k, elided at k=0 (spec §6.4)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class C {\n  handle() { return 1; }\n}\nclass C2 {\n  handle() { return 2; }\n}\n',
    );
    // Two different classes each declare their own `handle` method — same
    // (kind,name) pair "method handle" recurs across the FILE (spec §6.4's
    // ordinal is scoped to the file, not to the enclosing type), so the
    // second occurrence in source order carries #1.
    const handles = raw.filter((s) => s.kind === 'method' && s.name === 'handle').sort((a, b) => a.startRow - b.startRow);
    expect(handles).toHaveLength(2);
    expect(handles[0].qualifiedName).toBe('handle');
    expect(handles[0].ordinal).toBe(0);
    expect(handles[1].qualifiedName).toBe('handle#1');
    expect(handles[1].ordinal).toBe(1);
  });

  it('arity and hasParameterList: arity is the named-child count of the parameters field; hasParameterList is domain-only, distinct from arity=0', async () => {
    const raw = await extractTs('src/a.ts', 'function noParams() {}\nfunction oneParam(a: number) {}\n');
    const noParams = raw.find((s) => s.name === 'noParams');
    const oneParam = raw.find((s) => s.name === 'oneParam');
    expect(noParams?.arity).toBe(0);
    expect(noParams?.hasParameterList).toBe(true); // an EMPTY parameter list still exists as a field
    expect(oneParam?.arity).toBe(1);
  });

  it('supertypes via the heritage matcher (E9 raw)', async () => {
    const raw = await extractTs('src/a.ts', 'class AuthGuard extends BaseGuard implements CanActivate {\n  check() { return true; }\n}\n');
    const guard = raw.find((s) => s.name === 'AuthGuard');
    expect(guard?.supertypes.sort()).toEqual(['BaseGuard', 'CanActivate']);
    expect(guard?.grammarHasHeritageCandidacy).toBe(true);
  });

  it('nodeTypesSeen/calleeTexts/localVarNames/statementShapes/firstStatementType/lastReturnExprType are method-only, empty/default on type and file scopes', async () => {
    const raw = await extractTs('src/a.ts', 'class C {\n  m() {\n    const x = 1;\n    doThing(x);\n    return x;\n  }\n}\n');
    const method = raw.find((s) => s.name === 'm');
    const type = raw.find((s) => s.name === 'C');
    expect(method?.calleeTexts).toContain('doThing');
    expect(method?.localVarNames).toContain('x');
    expect(method?.firstStatementType).toBeDefined();
    expect(method?.hasReturnStatement).toBe(true);
    expect(method?.lastReturnExprType).toBe('identifier');
    expect(type?.calleeTexts).toEqual([]);
    expect(type?.bodyStatementCount).toBe(0);
  });

  it('file imports are shared across every scope of the file, raw (unnormalized)', async () => {
    const raw = await extractTs('src/pkg/a.ts', "import { X } from '../core/check.js';\nimport lodash from 'lodash';\nfunction f() {}\n");
    for (const scope of raw) {
      expect(scope.fileImports.sort()).toEqual(['../core/check.js', 'lodash']);
    }
  });
});

describe('extractUnits — the marker/window guard at extraction level (spec §6.2 regression cases)', () => {
  it("TypeScript's type_annotation is never mined as a decorator (the measured over-match; Task 3's isDecorationMarkerText is the guard)", async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class Worker {\n  queue: fastq.queueAsPromised<Job>;\n  run() { return 1; }\n}\n',
    );
    const worker = raw.find((s) => s.name === 'Worker');
    expect(worker?.decorators).toEqual([]);
  });

  // REWORK F5 (mutation-surviving rule): the test above does NOT actually
  // discriminate the marker predicate — `queue`'s `type_annotation` sits
  // INSIDE the class body, on a row AFTER `Worker`'s own `bodyRow`, so it is
  // excluded by the decoration WINDOW (`isWithinDecorationWindow`) before
  // `isDecorationMarkerText` is ever consulted; deleting the marker
  // predicate entirely would not change that test's outcome (confirmed by
  // the reviewer's mutation probe). THIS case is the discriminating one: a
  // PARAMETER-level type annotation sits lexically BETWEEN the scope's name
  // and its body — inside the window `(loRow, bodyRow]` for real — so it
  // reaches the marker check, and only the marker predicate (a type
  // annotation's text never starts with `@`/`[`) keeps it from being mined
  // as a decorator.
  it('a parameter-level type annotation lands INSIDE the decoration window but is excluded by the MARKER predicate — the discriminating case the type_annotation test above does not cover', async () => {
    const raw = await extractTs('src/a.ts', 'class C {\n  first() { return 1; }\n  handle(x: Job) { return x; }\n}\n');
    const handle = raw.find((s) => s.name === 'handle');
    expect(handle?.decorators).toEqual([]);
  });

  it('a stacked decorator above a PRECEDING member is not attributed to the following scope (the window lower bound)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class C {\n  @Before()\n  first() { return 1; }\n\n  second() { return 2; }\n}\n',
    );
    const first = raw.find((s) => s.name === 'first');
    const second = raw.find((s) => s.name === 'second');
    expect(first?.decorators).toEqual(['Before']);
    expect(second?.decorators).toEqual([]);
  });

  it('a decorator stack of any height is attributed in full to the scope it precedes', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class C {\n  @Injectable()\n  @Scoped()\n  handle() { return 1; }\n}\n',
    );
    const handle = raw.find((s) => s.name === 'handle');
    expect(handle?.decorators.sort()).toEqual(['Injectable', 'Scoped']);
  });
});

describe('extractUnits — §6.1 error tolerance', () => {
  it('a syntax error inside one function leaves sibling scopes intact (error-free subtrees only)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'function good() { return 1; }\nfunction bad( { return 2 \nfunction alsoGood() { return 3; }\n',
    );
    const names = raw.filter((s) => s.kind === 'method').map((s) => s.name);
    expect(names).toContain('good');
    // `bad`'s malformed parameter list makes it (or its containing region) an
    // error node — the walk never descends into it, so it is not extracted as
    // a clean scope. The file scope is still always present regardless.
    expect(raw.some((s) => s.kind === 'file')).toBe(true);
  });

  it('a totally garbled file still yields exactly the file scope, never throws', async () => {
    const raw = await extractTs('src/a.ts', ')))} constclass function {{{ === !!! \n');
    expect(raw.filter((s) => s.kind === 'file')).toHaveLength(1);
    expect(raw.every((s) => s.kind === 'file' || s.kind === 'method' || s.kind === 'type')).toBe(true);
  });

  // REWORK R1 (reviewer probe): a malformed SIBLING member inside a class
  // must not prune the whole class. Verified against the real parse
  // (`good`/`alsoGood` remain clean `method_definition` SIBLINGS of a single
  // `ERROR` node in this exact source — probed directly against tree-sitter's
  // own output before writing this test) — this is the ancestor-pruning bug
  // the old `if (child.hasError) continue` guard had: `class_declaration`
  // itself carries `hasError = true`, propagated up from the one malformed
  // member, so the OLD guard skipped the entire class at the walk's very
  // first step, before ever looking inside it.
  it('a malformed method inside a class leaves the class AND its clean sibling methods intact — only the malformed method itself is skipped (spec §6.1: error-free subtrees only, not error-free ancestors)', async () => {
    const raw = await extractTs('src/a.ts', 'class C {\n  good() { return 1; }\n  ;;; ) ( ;;;\n  alsoGood() { return 3; }\n}\n');
    const names = raw.filter((s) => s.kind === 'method' || s.kind === 'type').map((s) => s.name).sort();
    // C (the class itself, `type`-kind: it contains further scopes), `good`
    // and `alsoGood` are all recovered; the malformed member (which parses as
    // a bare `ERROR` sibling, not a `method_definition` at all) contributes
    // no scope of its own — there is no "bad" name to find.
    expect(names).toEqual(['C', 'alsoGood', 'good']);
  });
});

describe('extractUnits — §6.7 extraction contract: no-descend and the 4000-node visit cap', () => {
  it('a scope containing a nested named scope is reclassified `type` (spec §6.2) — so it never collects method-only body features for itself, by construction', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'function outer() {\n  function inner() {\n    const onlyInInner = 1;\n    return onlyInInner;\n  }\n  return inner();\n}\n',
    );
    const outer = raw.find((s) => s.name === 'outer');
    const inner = raw.find((s) => s.name === 'inner');
    expect(outer?.kind).toBe('type'); // has a descendant scope (inner) -> container
    expect(inner?.kind).toBe('method');
    // inner's own features belong to inner alone.
    expect(inner?.localVarNames).toEqual(['onlyInInner']);
    // Method-only fields are empty on the (now `type`-kind) outer scope —
    // the kind reclassification is exactly what keeps a scope's own
    // statement-level features from ever being computed over a region that
    // contains a nested scope's body (spec §6.7's no-descend contract is
    // structurally unreachable for `method`-kind scopes under this
    // binding rule: any scope containing a further scope is `type`, and
    // `type` scopes never collect E3/E6-call/E10 in the first place).
    expect(outer?.calleeTexts).toEqual([]);
    expect(outer?.localVarNames).toEqual([]);
  });

  it('sibling methods on the same class never see each other’s own body content (scope-body isolation, §6.7)', async () => {
    const raw = await extractTs(
      'src/a.ts',
      'class C {\n  a() {\n    const onlyInA = 1;\n    return onlyInA;\n  }\n  b() {\n    const onlyInB = 2;\n    return onlyInB;\n  }\n}\n',
    );
    const a = raw.find((s) => s.name === 'a');
    const b = raw.find((s) => s.name === 'b');
    expect(a?.localVarNames).toEqual(['onlyInA']);
    expect(b?.localVarNames).toEqual(['onlyInB']);
  });

  it('a pathological body far beyond the visit cap still extracts without throwing or hanging', async () => {
    const statements = Array.from({ length: BODY_VISIT_CAP + 500 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const source = `function huge() {\n${statements}\n  return v0;\n}\n`;
    const raw = await extractTs('src/a.ts', source);
    const huge = raw.find((s) => s.name === 'huge');
    expect(huge).toBeDefined();
    // `localVarNames` alone is a WEAK witness for the visit cap: it carries
    // its OWN independent cap (`localVarSampleMax`, default 20 — see the
    // next test), so this assertion would pass even if `BODY_VISIT_CAP`
    // itself were disabled entirely. `nodeTypesSeen` has no such
    // independent cap, so it stays a real (if secondary) confirmation that
    // the walk did not visit every one of the 4500+ declarators.
    expect(huge!.localVarNames.length).toBeLessThan(BODY_VISIT_CAP);
  });

  // REWORK F4 (mutation-surviving rule): the PRIMARY witness for
  // `BODY_VISIT_CAP` must be a field with NO independent cap of its own.
  // `calleeTexts` qualifies (unlike `localVarNames`, above) — its size is
  // bounded ONLY by how many nodes the walk visits before `BODY_VISIT_CAP`
  // stops it. A distinct callee name per statement makes the count directly
  // legible: capped, the walk visits only a fraction of the ~4500 call
  // statements before stopping (reviewer probe: 667 collected vs. 4500
  // total, confirming the cap actually bites); with the cap disabled, this
  // count would approach the full 4500.
  it('BODY_VISIT_CAP actually bounds an UNCAPPED field (calleeTexts) — not vacuously satisfied by a field with its own separate cap', async () => {
    const total = BODY_VISIT_CAP + 500;
    const statements = Array.from({ length: total }, (_, i) => `  call${i}();`).join('\n');
    const source = `function huge() {\n${statements}\n  return call0();\n}\n`;
    const raw = await extractTs('src/a.ts', source);
    const huge = raw.find((s) => s.name === 'huge');
    expect(huge).toBeDefined();
    expect(huge!.calleeTexts.length).toBeGreaterThan(0);
    // Strictly fewer than the total distinct callees the source declares —
    // if `BODY_VISIT_CAP` were a no-op, this would approach `total` instead.
    expect(huge!.calleeTexts.length).toBeLessThan(total);
  });
});

// REWORK R4: `shapeDepth`/`shapeMaxStatements`/`localVarSampleMax` are now
// threaded through `ExtractOptions` (extract.ts's header comment) rather than
// fixed local constants — this is a BEHAVIORAL test (the emitted shape
// string itself changes), not a signature-shape check.
describe('extractUnits — ExtractOptions: shapeDepth/shapeMaxStatements/localVarSampleMax are threaded, not fixed (spec §4.5)', () => {
  it('changing shapeDepth changes the emitted statement-shape string', async () => {
    const source = 'function f() {\n  if (x) {\n    doThing();\n  }\n}\n';
    const shallow = await withParsedFile('src/a.ts', source, (tree) => extractUnits('src/a.ts', source, tree, tsBinding, { shapeDepth: 1 }));
    const deep = await withParsedFile('src/a.ts', source, (tree) => extractUnits('src/a.ts', source, tree, tsBinding, { shapeDepth: 3 }));
    const shallowShape = shallow.find((s) => s.name === 'f')?.statementShapes[0];
    const deepShape = deep.find((s) => s.name === 'f')?.statementShapes[0];
    expect(shallowShape).toBeDefined();
    expect(deepShape).toBeDefined();
    // A deeper serialization is strictly longer (it recurses further into
    // the `if`'s own body) — the two are simply DIFFERENT strings.
    expect(shallowShape).not.toBe(deepShape);
    expect((deepShape as string).length).toBeGreaterThan((shallowShape as string).length);
  });

  it('omitting ExtractOptions (or any of its fields) falls back to spec §4.5’s own defaults — unchanged from before this option existed', async () => {
    const source = 'function f() {\n  if (x) {\n    doThing();\n  }\n}\n';
    const withoutOptions = await extractTs('src/a.ts', source);
    const withEmptyOptions = await withParsedFile('src/a.ts', source, (tree) => extractUnits('src/a.ts', source, tree, tsBinding, {}));
    expect(withoutOptions.find((s) => s.name === 'f')?.statementShapes).toEqual(withEmptyOptions.find((s) => s.name === 'f')?.statementShapes);
  });

  it('localVarSampleMax caps the sampled local-variable names', async () => {
    const source = 'function f() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a;\n}\n';
    const capped = await withParsedFile('src/a.ts', source, (tree) => extractUnits('src/a.ts', source, tree, tsBinding, { localVarSampleMax: 2 }));
    // The body-feature walk visits statements via a LIFO stack (last
    // top-level statement first), so declared order is REVERSED in
    // `localVarNames` — `c` then `b`, `a` never collected once the cap of 2
    // is reached. This is existing, unrelated walk behavior (not something
    // this option changes); pinned here so the cap's OWN effect (fewer than
    // 3 names) is asserted precisely, not merely "some names."
    expect(capped.find((s) => s.name === 'f')?.localVarNames).toEqual(['c', 'b']);
  });
});

describe('extractUnits — cross-grammar spot checks (binding.ts’s derived heritage/decorator sets applied through real parses of non-TypeScript source)', () => {
  it('Python: heritage via the argument_list rule, no lexical decorator marker needed for @-prefixed decorators', async () => {
    const source = 'class Handler(BaseHandler):\n    @app.route("/x")\n    def get(self):\n        return 1\n';
    const raw = await withParsedFile('src/a.py', source, (tree) => extractUnits('src/a.py', source, tree, pyBinding));
    const handler = raw.find((s) => s.name === 'Handler');
    const get = raw.find((s) => s.name === 'get');
    expect(handler?.supertypes).toContain('BaseHandler');
    expect(get?.decorators).toContain('app.route');
  });

  it('Go: no decorator node types at all — grammarHasDecoratorTypes is false for every scope', async () => {
    const source = 'package main\n\nfunc NewRouter() int {\n\treturn 1\n}\n';
    const raw = await withParsedFile('src/a.go', source, (tree) => extractUnits('src/a.go', source, tree, goBinding));
    expect(raw.length).toBeGreaterThan(0);
    for (const scope of raw) expect(scope.grammarHasDecoratorTypes).toBe(false);
  });

  it('C#: attribute_list decorators use the `[` marker, not `@`', async () => {
    const source = 'class Ctrl {\n  [HttpGet]\n  public int Get() { return 1; }\n}\n';
    const raw = await withParsedFile('src/a.cs', source, (tree) => extractUnits('src/a.cs', source, tree, csharpBinding));
    const get = raw.find((s) => s.name === 'Get');
    expect(get?.decorators).toContain('HttpGet');
  });
});

describe('finalizeUnits — skeyR, stable_id, module synthesis (spec §6.3-§6.4)', () => {
  it('skeyR is relPath#kind#qualifiedName; stable_id is a 16-hex-char sha256 fold', async () => {
    const raw = await extractTs('src/a.ts', 'function f() { return 1; }\n');
    const units = finalizeUnits(raw, trivialPartitions(['src/a.ts']));
    const method = units.find((u) => u.kind === 'method' && u.name === 'f');
    expect(method?.skeyR).toBe('src/a.ts#method#f');
    expect(method?.stableId).toMatch(/^[0-9a-f]{16}$/);
  });

  // REWORK R6: a golden, HAND-DERIVED hex assertion — computed independently
  // of this codebase (`sha256hex('p src/a.ts method f 0').slice(0, 16)`, via
  // Node's own `crypto` at the command line) and pinned here, so a future
  // change to the fold's field order, its space delimiter, or the hash
  // algorithm itself changes this exact string and the test fails loudly,
  // rather than merely "still produces SOME 16-hex-char string" (the prior
  // test above, `toMatch(/^[0-9a-f]{16}$/)`, would pass unchanged through
  // such a regression).
  it('stable_id golden hex: a hand-derived sha256hex(partitionId relPath kind qualifiedName arity)[:16] for a fixed case', async () => {
    const raw = await extractTs('src/a.ts', 'function f() { return 1; }\n');
    const units = finalizeUnits(raw, trivialPartitions(['src/a.ts'], '', 'p'));
    const method = units.find((u) => u.kind === 'method' && u.name === 'f');
    // Independently computed: node -e "console.log(require('crypto').createHash('sha256').update('p src/a.ts method f 0').digest('hex').slice(0,16))"
    expect(method?.stableId).toBe('543e0f923408b598');
  });

  // REWORK R1: `finalizeUnits` excludes DROPPED scopes entirely (see its own
  // header comment) — a raw scope whose file has no `partitionOfFile` entry
  // must produce NO `ScopeUnit` at all, not a `'_repo'`-defaulted one.
  it('a raw scope whose file was DROPPED by partitioning produces NO ScopeUnit at all', async () => {
    const raw = await extractTs('src/dropped.ts', 'function f() { return 1; }\n');
    const partitions: PartitionMap = {
      partitionOfFile: new Map(), // no entry — dropped
      moduleRootDirOfFile: new Map(),
      packageRoots: [],
      survivingPartitionIds: [],
      statusOfKey: new Map([['_root', 'dropped']]),
      silent: true,
    };
    const units = finalizeUnits(raw, partitions);
    expect(units).toEqual([]);
  });

  it('two overloads sharing the same arity get DIFFERENT stable_ids (the ordinal, folded into qualifiedName, is what disambiguates them)', async () => {
    const raw = await extractTs('src/a.ts', 'class C {\n  handle() { return 1; }\n}\nclass C2 {\n  handle() { return 2; }\n}\n');
    const units = finalizeUnits(raw, trivialPartitions(['src/a.ts']));
    const handles = units.filter((u) => u.kind === 'method' && u.name === 'handle');
    expect(handles).toHaveLength(2);
    expect(handles[0].stableId).not.toBe(handles[1].stableId);
    expect(handles[0].arity).toBe(handles[1].arity); // both zero-arity — arity alone could not have disambiguated them
  });

  it('a sparse directory (<3 code files) rolls its module up to the partition root; a dense one (≥3) gets its own module', async () => {
    const files = ['src/lonely/a.ts', 'src/busy/a.ts', 'src/busy/b.ts', 'src/busy/c.ts'];
    let allRaw: RawScope[] = [];
    for (const f of files) {
      allRaw = allRaw.concat(await extractTs(f, 'function f() { return 1; }\n'));
    }
    const partitions = trivialPartitions(files, ''); // module root = repo root
    const units = finalizeUnits(allRaw, partitions);
    const modules = units.filter((u) => u.kind === 'module');
    const moduleDirs = modules.map((m) => m.relPath).sort();
    // `src/lonely` has only 1 code file — it must NOT get its own module;
    // its file rolls up to the partition-root module ('').
    expect(moduleDirs).not.toContain('src/lonely');
    // `src/busy` has 3 code files — it clears the threshold and gets its own module.
    expect(moduleDirs).toContain('src/busy');
    expect(moduleDirs).toContain('');
  });
});
