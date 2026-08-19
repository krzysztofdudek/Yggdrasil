import { describe, it, expect } from 'vitest';
import { withParsedFile } from '../../../src/ast/parser.js';
import { readNodeTypes } from '../../../src/ast/node-types.js';
import { deriveBinding } from '../../../src/roots/binding.js';
import { extractUnits, finalizeUnits, type RawScope, type ScopeUnit } from '../../../src/roots/extract.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import { buildVocabularies, enumerate, overlapGroupForSurface, type RootsVocabularies } from '../../../src/roots/enumerate.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import type { RootsConfig } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/enumerate.test.ts — spec §7's twelve enumerators
// (Appendix B, one table-driven case per row where real source makes the
// row observable), the §7.2 per-partition vocabulary builder, the §5
// sparse-boolean domain contract (including its own named property test:
// sparse counting ≡ dense counting), and the §7.3 static overlap-group map.
// ---------------------------------------------------------------------------

const tsBinding = deriveBinding(readNodeTypes('typescript'));
const pyBinding = deriveBinding(readNodeTypes('python'));

/** Config with support/topK floors low enough that a tiny fixture's tokens survive vocabulary selection. */
async function lowFloorConfig(): Promise<RootsConfig> {
  return defaultRootsConfig(
    'enumerate:\n    support: { nodeType: 1, call: 1, import: 1, supertype: 1, shape: 1, decorator: 1 }\n    topK: { nodeType: 50, call: 50, import: 50, supertype: 50, shape: 50, decorator: 50 }\n',
  );
}

/**
 * Runs extract -> finalize over TS snippets, all assigned to ONE fixed,
 * ALWAYS-SURVIVING synthetic partition (`'_root'`) — this file tests
 * `enumerate.ts` in isolation, per Appendix B, one real-parse case per row;
 * whether a fixture's tiny scope count would clear spec §6.8's real 300-scope
 * floor is `partitions.test.ts`'s concern, never this file's (its own header
 * comment states this explicitly). A REAL `derivePartitions` call was used
 * here before REWORK R1: that WORKED only because the pre-fix
 * `derivePartitions` silently assigned every under-floor scope to `'_repo'`
 * rather than dropping it (the very bug R1 fixed) — post-fix, a real call
 * over these tiny few-scope fixtures would now correctly report every one of
 * them DROPPED (never mined), producing zero `ScopeUnit`s and breaking every
 * test in this file. This synthetic map sidesteps the floor question
 * entirely, exactly as this function's own callers already assumed.
 */
function syntheticPartitions(relPaths: string[]): PartitionMap {
  const partitionOfFile = new Map(relPaths.map((p) => [p, '_root']));
  const moduleRootDirOfFile = new Map(relPaths.map((p) => [p, '']));
  return {
    partitionOfFile,
    moduleRootDirOfFile,
    packageRoots: [],
    survivingPartitionIds: ['_root'],
    statusOfKey: new Map([['_root', 'own-floor']]),
    silent: false,
  };
}

/** Runs the full extract -> finalize pipeline over TS snippets in one (synthetic, always-surviving) partition. */
async function buildUnits(files: Array<{ path: string; source: string }>): Promise<{ units: ScopeUnit[]; partitions: PartitionMap }> {
  let allRaw: RawScope[] = [];
  for (const f of files) {
    allRaw = allRaw.concat(await withParsedFile(f.path, f.source, (tree) => extractUnits(f.path, f.source, tree, tsBinding)));
  }
  const partitions = syntheticPartitions(files.map((f) => f.path));
  const units = finalizeUnits(allRaw, partitions);
  return { units, partitions };
}

async function enumerateAll(files: Array<{ path: string; source: string }>, config: RootsConfig) {
  const { units, partitions } = await buildUnits(files);
  const vocabByPartition = buildVocabularies(units, partitions, config);
  // All fixtures here fit in one partition (whatever id derivePartitions
  // resolved it to — real markers/300-floor mechanics are `partitions.test.ts`'s
  // concern, not this file's).
  const partitionId = units.find((u) => u.kind !== 'module')?.partitionId as string;
  const vocab = vocabByPartition.get(partitionId) as RootsVocabularies;
  const partitionUnits = units.filter((u) => u.partitionId === partitionId);
  return { ...enumerate(partitionUnits, vocab, config), units: partitionUnits, vocab };
}

function bagFor(bags: ReturnType<typeof enumerate>['bags'], predicate: (b: (typeof bags)[number]) => boolean) {
  const found = bags.find(predicate);
  if (!found) throw new Error('bag not found');
  return found;
}

describe('enumerate — Appendix B, one case per applicable enumerator (real TS source, real vocab)', () => {
  it('E1 auto.nameshape / auto.filenameshape: PascalCase class, camelCase file', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll([{ path: 'src/UserService.ts', source: 'export class UserService {\n  handle() { return 1; }\n}\n' }], config);
    const type = bagFor(bags, (b) => b.kind === 'type');
    const file = bagFor(bags, (b) => b.kind === 'file');
    expect(type.surfaces['auto.nameshape']).toBe('(Ua)+'); // "UserService" = U a U a -> folds to (Ua)+
    expect(file.surfaces['auto.filenameshape']).toBe('(Ua)+'); // "UserService" stem, same shape
  });

  // REWORK F6: Appendix B's E1 domain is "all named scopes" — an anonymous
  // scope (`name === '<anon>'`) was never actually named by anyone, so it
  // must be excluded from the domain entirely, not folded through
  // `nameShape()` into a fabricated-looking convention string.
  it('E1 auto.nameshape: an anonymous scope is OUT OF DOMAIN entirely (Appendix B: named scopes only)', async () => {
    const config = await lowFloorConfig();
    const { bags, domains } = await enumerateAll([{ path: 'src/a.ts', source: 'export default function () { return 1; }\n' }], config);
    const anon = bagFor(bags, (b) => b.kind === 'method' && b.skeyR.includes('<anon>'));
    expect(anon.surfaces['auto.nameshape']).toBeUndefined();
    expect(domains.get('auto.nameshape')?.has(anon.stableId)).toBeFalsy();
  });

  it('E2 auto.arity: parameter-count band, 0/1/2/3+', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'function zero() {}\nfunction two(a: number, b: number) {}\nfunction four(a: number, b: number, c: number, d: number) {}\n' }],
      config,
    );
    expect(bagFor(bags, (b) => b.relPath.endsWith('a.ts') && b.skeyR.includes('#zero')).surfaces['auto.arity']).toBe('0');
    expect(bagFor(bags, (b) => b.skeyR.includes('#two')).surfaces['auto.arity']).toBe('2');
    expect(bagFor(bags, (b) => b.skeyR.includes('#four')).surfaces['auto.arity']).toBe('3+');
  });

  it('E3 auto.has:<t>: TRUE-only — present when the node type is observed, absent (not "false") when not', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'function withTry() {\n  try { doThing(); } catch (e) { handle(e); }\n}\nfunction withoutTry() {\n  doOther();\n}\n' }],
      config,
    );
    const withTry = bagFor(bags, (b) => b.skeyR.includes('#withTry'));
    const withoutTry = bagFor(bags, (b) => b.skeyR.includes('#withoutTry'));
    expect(withTry.surfaces['auto.has:try_statement']).toBe('true');
    expect(withoutTry.surfaces['auto.has:try_statement']).toBeUndefined(); // sparse: never stored false
  });

  it('E4 auto.first1: node type of the first body statement', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll([{ path: 'src/a.ts', source: 'function guard(x: number) {\n  if (x < 0) { return 0; }\n  return x;\n}\n' }], config);
    expect(bagFor(bags, (b) => b.skeyR.includes('#guard')).surfaces['auto.first1']).toBe('if_statement');
  });

  it('E5 auto.ret: node type of the last return expression, or bare', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'function withVal() {\n  return 1 + 2;\n}\nfunction bare() {\n  return;\n}\n' }],
      config,
    );
    expect(bagFor(bags, (b) => b.skeyR.includes('#withVal')).surfaces['auto.ret']).toBe('binary_expression');
    expect(bagFor(bags, (b) => b.skeyR.includes('#bare')).surfaces['auto.ret']).toBe('bare');
  });

  it('E6 auto.call:<c> / auto.deco:@<d>: callee vocabulary and decorator vocabulary', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: '@Injectable()\nclass Service {\n  handle() {\n    doWork();\n  }\n}\n' }],
      config,
    );
    const type = bagFor(bags, (b) => b.kind === 'type');
    const method = bagFor(bags, (b) => b.kind === 'method');
    expect(type.surfaces['auto.deco:@Injectable']).toBe('true');
    expect(method.surfaces['auto.call:doWork']).toBe('true');
  });

  it('E7 auto.dirN: the first `pathSegments` directory segments of the file', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll([{ path: 'src/services/auth/a.ts', source: 'function f() {}\n' }], config);
    const file = bagFor(bags, (b) => b.kind === 'file');
    expect(file.surfaces['auto.dir1']).toBe('src');
    expect(file.surfaces['auto.dir2']).toBe('services');
    expect(file.surfaces['auto.dir3']).toBe('auth');
  });

  it('E8 auto.imp:<s>: relative specifiers normalize to ~/-prefixed, extension-stripped paths; package specifiers pass through', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/pkg/a.ts', source: "import { check } from '../core/check.js';\nimport lodash from 'lodash';\nfunction f() {}\n" }],
      config,
    );
    const file = bagFor(bags, (b) => b.kind === 'file');
    expect(file.surfaces['auto.imp:~/src/core/check']).toBe('true');
    expect(file.surfaces['auto.imp:lodash']).toBe('true');
  });

  it('E8 normalization: two differently-spelled relative specifiers to the same target are ONE token', async () => {
    const config = await lowFloorConfig();
    const a = await enumerateAll([{ path: 'src/a.ts', source: "import { x } from '../core/check.js';\nfunction f() {}\n" }], config);
    const b = await enumerateAll([{ path: 'src/sub/b.ts', source: "import { x } from '../../core/check.js';\nfunction f() {}\n" }], config);
    const fileA = bagFor(a.bags, (x) => x.kind === 'file');
    const fileB = bagFor(b.bags, (x) => x.kind === 'file');
    const tokenA = Object.keys(fileA.surfaces).find((k) => k.startsWith('auto.imp:'));
    const tokenB = Object.keys(fileB.surfaces).find((k) => k.startsWith('auto.imp:'));
    expect(tokenA).toBe(tokenB);
    expect(tokenA).toBe('auto.imp:~/core/check');
  });

  it('E9 auto.extends:<T>: declared supertype/interface', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'class AuthGuard extends BaseGuard {\n  check() { return true; }\n}\n' }],
      config,
    );
    expect(bagFor(bags, (b) => b.kind === 'type').surfaces['auto.extends:BaseGuard']).toBe('true');
  });

  // REWORK D4: pinned to the EXACT shape string, not merely "some
  // `auto.stshape:` key exists" — `serializeShape` is depth-limited
  // recursion (`type(child,child,child)`, children truncated to 3, spec
  // §7.1 E10), and for `return 1;` at the spec §4.5 default `shapeDepth = 2`
  // that recursion produces exactly `return_statement(number())` (the
  // `return_statement`'s one child, a `number` literal, recurses one level
  // deeper to an empty child list, hence the trailing `()`).
  it('E10 auto.stshape:<sh>: depth-limited statement-shape presence, exact string', async () => {
    const config = await lowFloorConfig();
    const { bags, vocab } = await enumerateAll([{ path: 'src/a.ts', source: 'function f() {\n  return 1;\n}\n' }], config);
    expect(vocab.shape).toEqual(['return_statement(number())']);
    const method = bagFor(bags, (b) => b.kind === 'method');
    expect(method.surfaces['auto.stshape:return_statement(number())']).toBe('true');
  });

  // REWORK D4: pinned to the EXACT modal shape string. Both locals
  // ("userId", "userName") reduce to the SAME char-class shape: an
  // uppercase run of one letter ("I"/"N") folds to a single `U` (a run of
  // length 1 is not a *repeated* run, so `(x)+` folding — which needs >= 2
  // repetitions of the same unit — never applies here), flanked by lowercase
  // runs folding to `a` — `"userId"`/`"userName"` -> `"aUa"` both, so the
  // modal value is unambiguous.
  it('E11 auto.varshape: modal name-shape over >= 2 declared locals, exact string', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'function f() {\n  const userId = 1;\n  const userName = 2;\n  return userId;\n}\n' }],
      config,
    );
    expect(bagFor(bags, (b) => b.kind === 'method').surfaces['auto.varshape']).toBe('aUa');
  });

  it('E12 auto.moddirshape / auto.modfileshape / auto.modsize: a directory with >= 3 code files', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll(
      [
        { path: 'src/busy/aOne.ts', source: 'function f() {}\n' },
        { path: 'src/busy/bTwo.ts', source: 'function f() {}\n' },
        { path: 'src/busy/cThree.ts', source: 'function f() {}\n' },
      ],
      config,
    );
    const moduleBag = bagFor(bags, (b) => b.kind === 'module' && b.relPath === 'src/busy');
    expect(moduleBag.surfaces['auto.modsize']).toBe('3-7');
    expect(moduleBag.surfaces['auto.moddirshape']).toBeDefined();
    expect(moduleBag.surfaces['auto.modfileshape']).toBeDefined();
  });

  it('a resolved module directory with < 3 DIRECT code files gets NO module-level facts at all (out of domain, not false) — even though a module-kind bag still exists (it rolled up to the repo-root module, which itself has 0 direct files here)', async () => {
    const config = await lowFloorConfig();
    const { bags } = await enumerateAll([{ path: 'src/lonely/a.ts', source: 'function f() {}\n' }], config);
    const moduleBags = bags.filter((b) => b.kind === 'module');
    expect(moduleBags).toHaveLength(1); // rolled up to the repo-root module ('')
    expect(moduleBags[0].surfaces).toEqual({}); // out of domain: 0 direct files < MIN_MODULE_CODE_FILES
  });
});

describe('buildVocabularies — support floor + top-K selection, per partition (spec §7.2)', () => {
  it('a token below the support floor is dropped from the vocabulary and never becomes a surface', async () => {
    const config = await defaultRootsConfig(
      'enumerate:\n    support: { nodeType: 1, call: 5, import: 1, supertype: 1, shape: 1, decorator: 1 }\n    topK: { nodeType: 50, call: 50, import: 50, supertype: 50, shape: 50, decorator: 50 }\n',
    );
    const { bags, vocab } = await enumerateAll([{ path: 'src/a.ts', source: 'function f() {\n  rareCallee();\n}\n' }], config);
    expect(vocab.call).not.toContain('rareCallee'); // support 5, only 1 occurrence
    expect(bagFor(bags, (b) => b.kind === 'method').surfaces['auto.call:rareCallee']).toBeUndefined();
  });

  it('top-K keeps only the highest-count tokens, ties broken token-asc, stored sorted', async () => {
    const config = await defaultRootsConfig(
      'enumerate:\n    support: { nodeType: 1, call: 1, import: 1, supertype: 1, shape: 1, decorator: 1 }\n    topK: { nodeType: 50, call: 1, import: 50, supertype: 50, shape: 50, decorator: 50 }\n',
    );
    // `bbb` is called from TWO scopes (count 2), `aaa` from only one (count
    // 1) — counting is per-SCOPE presence (a scope's own `calleeTexts` is
    // already deduped at extraction), not per call-site, so calling the same
    // callee twice within ONE scope would not separate the counts.
    const { vocab } = await enumerateAll(
      [{ path: 'src/a.ts', source: 'function f() {\n  bbb();\n}\nfunction g() {\n  bbb();\n  aaa();\n}\n' }],
      config,
    );
    expect(vocab.call).toEqual(['bbb']); // topK=1, bbb (count 2) beats aaa (count 1)
  });
});

// REWORK R3 + F7: the fabricated ScopeUnit literals this block used to build
// by hand are gone — E3's domain is now `grammarNodeTypeVocabulary`
// (extract.ts's own threaded copy of `RootsBinding.nodeTypeVocabulary`, a
// GRAMMAR-level fact with nothing partition-shaped about it), so the
// meaningful test is a real MIXED-extension fixture through the real
// pipeline: a `.ts` file and a `.py` file sharing one partition, verifying a
// TypeScript-only node type is in-domain for the TS method and OUT of domain
// for the Python one — not because this partition never happened to observe
// it under `.py` (the old, replaced empirical framing), but because Python's
// own grammar never declares that node type AT ALL.
describe('enumerate — E3’s grammar-declared node-type-vocabulary domain (spec §7.1/§21.3’s worked example, read literally)', () => {
  it('a node type one grammar never declares at all is OUT OF DOMAIN for every scope of that grammar, even sharing a partition with a grammar that does declare it', async () => {
    const config = await lowFloorConfig();
    // `binary_expression` is a real, verified TypeScript-only node type name
    // (confirmed absent from tree-sitter-python's own node-types.json —
    // Python's grammar names the equivalent construct `binary_operator`) —
    // not a hypothetical "some JS-only shape," an actually-checked fact
    // about these two shipped grammars.
    const tsSource = 'function withBinary() {\n  return 1 + 1;\n}\n';
    const pySource = 'def plain():\n    return 1\n';
    const tsRaw = await withParsedFile('src/a.ts', tsSource, (tree) => extractUnits('src/a.ts', tsSource, tree, tsBinding));
    const pyRaw = await withParsedFile('src/b.py', pySource, (tree) => extractUnits('src/b.py', pySource, tree, pyBinding));
    const allRaw = [...tsRaw, ...pyRaw];
    const partitions = syntheticPartitions(['src/a.ts', 'src/b.py']); // ONE shared partition, both grammars
    const units = finalizeUnits(allRaw, partitions);
    const vocab = buildVocabularies(units, partitions, config).get('_root') as RootsVocabularies;
    const { bags, domains } = enumerate(
      units.filter((u) => u.partitionId === '_root'),
      vocab,
      config,
    );

    expect(vocab.nodeType).toContain('binary_expression'); // observed (in the .ts file) and support-eligible
    const tsMethod = bagFor(bags, (b) => b.skeyR.includes('#withBinary'));
    const pyMethod = bagFor(bags, (b) => b.skeyR.includes('#plain'));
    expect(tsMethod.surfaces['auto.has:binary_expression']).toBe('true');
    expect(pyMethod.surfaces['auto.has:binary_expression']).toBeUndefined(); // out of domain, not a spurious "false"

    const domainSet = domains.get('auto.has:binary_expression');
    expect(domainSet?.has(tsMethod.stableId)).toBe(true); // TS: the grammar that declares this node type — in domain
    expect(domainSet?.has(pyMethod.stableId)).toBe(false); // Python's grammar never declares it at all — out of domain
  });
});

// REWORK F8: strengthened from a single hand-picked surface on a
// single-grammar fixture to EVERY bool surface actually produced by a rich,
// MIXED .ts/.py fixture — with R3 landed, the mixed-grammar fixture gives a
// genuine `domain ⊊ members` case (`auto.has:binary_expression`: Python
// methods are OUT of domain entirely, not merely false) alongside ordinary
// in-domain-false cases, so the property is exercised on real divergence,
// not vacuously on a fixture where every scope happens to be in-domain.
describe('enumerate — spec §5 sparse ≡ dense property test', () => {
  it('n_false computed via |domain ∩ members| - n_true equals a direct dense count, for every bool surface produced by a mixed-grammar fixture (domain ⊊ members exercised for real)', async () => {
    const config = await lowFloorConfig();
    const tsSource =
      '@Injectable()\nclass Service extends Base {\n  handle() {\n    try {\n      doWork();\n      const x = 1 + 1;\n    } catch (e) {\n      onError(e);\n    }\n  }\n  plain() {\n    return 1;\n  }\n}\n';
    const pySource = 'class Plain:\n    def run(self):\n        return 1\n';
    const tsRaw = await withParsedFile('src/a.ts', tsSource, (tree) => extractUnits('src/a.ts', tsSource, tree, tsBinding));
    const pyRaw = await withParsedFile('src/b.py', pySource, (tree) => extractUnits('src/b.py', pySource, tree, pyBinding));
    const allRaw = [...tsRaw, ...pyRaw];
    const partitions = syntheticPartitions(['src/a.ts', 'src/b.py']);
    const units = finalizeUnits(allRaw, partitions);
    const vocab = buildVocabularies(units, partitions, config).get('_root') as RootsVocabularies;
    const partitionUnits = units.filter((u) => u.partitionId === '_root');
    const { bags, domains } = enumerate(partitionUnits, vocab, config);

    // One (inDomain, value) predicate PAIR per bool-class enumerator this
    // fixture exercises, reading the SAME raw `ScopeUnit` fields
    // `enumerate.ts` itself reads — independent of the sparse/domain
    // machinery under test. `inDomain` mirrors each surface's REAL gating
    // condition exactly (Appendix B's domain column, applied literally):
    // note `auto.deco:`/`auto.extends:` are gated by a per-scope grammar
    // flag, NOT merely by kind — a method/type scope whose grammar lacks
    // decorator/heritage nodes entirely is OUT of that domain too, same as
    // a wrong-grammar scope is out of `auto.has:`'s domain.
    const denseCheck = (surfaceId: string): { inDomain: (u: ScopeUnit) => boolean; value: (u: ScopeUnit) => boolean } | undefined => {
      const hasMatch = /^auto\.has:(.+)$/.exec(surfaceId);
      if (hasMatch) {
        const token = hasMatch[1];
        return { inDomain: (u) => u.kind === 'method' && u.grammarNodeTypeVocabulary.includes(token), value: (u) => u.nodeTypesSeen.includes(token) };
      }
      const callMatch = /^auto\.call:(.+)$/.exec(surfaceId);
      if (callMatch) {
        const token = callMatch[1];
        return { inDomain: (u) => u.kind === 'method' && u.bodyStatementCount >= 1, value: (u) => u.calleeTexts.includes(token) };
      }
      const decoMatch = /^auto\.deco:@(.+)$/.exec(surfaceId);
      if (decoMatch) {
        const token = decoMatch[1];
        return { inDomain: (u) => (u.kind === 'method' || u.kind === 'type') && u.grammarHasDecoratorTypes, value: (u) => u.decorators.includes(token) };
      }
      const extendsMatch = /^auto\.extends:(.+)$/.exec(surfaceId);
      if (extendsMatch) {
        const token = extendsMatch[1];
        return { inDomain: (u) => (u.kind === 'method' || u.kind === 'type') && u.grammarHasHeritageCandidacy, value: (u) => u.supertypes.includes(token) };
      }
      return undefined; // cat surfaces (nameshape, arity, dirN, ...) have no n_false concept — not this property's concern
    };

    let atLeastOneDomainStrictlySmallerThanPartition = false;
    let boolSurfacesChecked = 0;
    for (const [surfaceId, domainIds] of domains) {
      const check = denseCheck(surfaceId);
      if (!check) continue;
      boolSurfacesChecked++;

      // Independently-computed domain (from raw `ScopeUnit` fields) must
      // equal the sparse domain `enumerate()` actually produced — the
      // property's own precondition, verified before trusting the count.
      const denseDomainIds = new Set(partitionUnits.filter(check.inDomain).map((u) => u.stableId));
      expect([surfaceId, [...domainIds].sort()]).toEqual([surfaceId, [...denseDomainIds].sort()]);

      const inDomainUnits = partitionUnits.filter((u) => denseDomainIds.has(u.stableId));
      const denseTrue = inDomainUnits.filter(check.value).length;
      const denseFalse = inDomainUnits.length - denseTrue;

      // SPARSE: n_true from the true-only bags, n_false from |domain| - n_true
      // (members(r) here is "every scope in the partition," so domain(q) ∩
      // members(r) = domain(q) — domain is always a subset of the whole
      // partition by construction).
      const sparseTrue = bags.filter((b) => domainIds.has(b.stableId) && b.surfaces[surfaceId] === 'true').length;
      const sparseFalse = domainIds.size - sparseTrue;

      expect([surfaceId, sparseTrue]).toEqual([surfaceId, denseTrue]);
      expect([surfaceId, sparseFalse]).toEqual([surfaceId, denseFalse]);

      if (domainIds.size < partitionUnits.length) atLeastOneDomainStrictlySmallerThanPartition = true;
    }

    expect(boolSurfacesChecked).toBeGreaterThan(0);
    // The real divergence F8 asks for: at least one surface's domain is a
    // STRICT subset of the partition's units (Python is excluded from
    // `auto.has:binary_expression`'s domain entirely — its grammar never
    // declares that node type).
    expect(atLeastOneDomainStrictlySmallerThanPartition).toBe(true);
  });
});

describe('overlapGroupForSurface — spec §7.3’s static map', () => {
  it('name-tokens <-> E1 (AND E12’s auto.modfileshape, Appendix B’s own overlap column), supertype <-> E9, decorator <-> E6-deco, import-segments <-> E8 and E7', () => {
    expect(overlapGroupForSurface('auto.nameshape')).toBe('name-tokens');
    expect(overlapGroupForSurface('auto.filenameshape')).toBe('name-tokens');
    // REWORK F9: Appendix B (`v6-spec.md:839`) names `auto.modfileshape`'s own
    // overlap group as `name-tokens` explicitly — the map is complete against
    // that table regardless of whether roles (§8.1) currently consume module
    // surfaces (they do not, today).
    expect(overlapGroupForSurface('auto.modfileshape')).toBe('name-tokens');
    expect(overlapGroupForSurface('auto.extends:CanActivate')).toBe('supertype');
    expect(overlapGroupForSurface('auto.deco:@Injectable')).toBe('decorator');
    expect(overlapGroupForSurface('auto.imp:lodash')).toBe('import-segments');
    expect(overlapGroupForSurface('auto.dir1')).toBe('import-segments');
  });

  it('enumerators outside the four overlap groups (E2-E5, E10-E11, and E12’s auto.moddirshape/auto.modsize) have no group at all', () => {
    expect(overlapGroupForSurface('auto.arity')).toBeUndefined();
    expect(overlapGroupForSurface('auto.has:call_expression')).toBeUndefined();
    expect(overlapGroupForSurface('auto.call:doThing')).toBeUndefined();
    expect(overlapGroupForSurface('auto.first1')).toBeUndefined();
    expect(overlapGroupForSurface('auto.ret')).toBeUndefined();
    expect(overlapGroupForSurface('auto.stshape:whatever')).toBeUndefined();
    expect(overlapGroupForSurface('auto.varshape')).toBeUndefined();
    // `auto.moddirshape` carries `—` in Appendix B's own overlap column —
    // unlike its E12 sibling `auto.modfileshape` above, it genuinely has no
    // overlap group.
    expect(overlapGroupForSurface('auto.moddirshape')).toBeUndefined();
    expect(overlapGroupForSurface('auto.modsize')).toBeUndefined();
  });
});
