import { describe, it, expect } from 'vitest';
import { derivePartitions, makeRootsFileFilters, BUILT_IN_EXCLUSIONS, PARTITION_SCOPE_FLOOR } from '../../../src/roots/partitions.js';
import type { RawScope } from '../../../src/roots/extract.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/partitions.test.ts — spec §6.8 field partitions
// (package-root detection, the 300-scope floor, the `_repo` merge, J4) and
// the two-flavor `makeRootsFileFilters` exclusion factory.
// ---------------------------------------------------------------------------

/** A minimal RawScope for partition-floor tests — only relPath and kind matter to derivePartitions. */
function scope(relPath: string, kind: RawScope['kind'] = 'method'): RawScope {
  return {
    kind,
    relPath,
    name: 'x',
    qualifiedName: 'x',
    ordinal: 0,
    arity: 0,
    hasParameterList: false,
    startRow: 0,
    supertypes: [],
    decorators: [],
    grammarHasDecoratorTypes: false,
    grammarHasHeritageCandidacy: false,
    grammarNodeTypeVocabulary: [],
    fileImports: [],
    calleeTexts: [],
    nodeTypesSeen: [],
    statementShapes: [],
    localVarNames: [],
    firstStatementType: undefined,
    lastReturnExprType: undefined,
    hasReturnStatement: false,
    bodyStatementCount: 0,
  };
}

function manyScopes(relPath: string, n: number): RawScope[] {
  return Array.from({ length: n }, () => scope(relPath));
}

describe('derivePartitions — package-root detection (spec §6.8)', () => {
  it('a directory containing package.json is a partition root; nested roots win (closest ancestor)', async () => {
    const config = await defaultRootsConfig();
    const files = ['package.json', 'packages/api/package.json', 'packages/api/src/a.ts', 'src/b.ts'];
    const rawScopes = [...manyScopes('packages/api/src/a.ts', 400), ...manyScopes('src/b.ts', 400)];
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.packageRoots.sort()).toEqual(['', 'packages/api']);
    expect(partitions.partitionOfFile.get('packages/api/src/a.ts')).toBe('packages/api');
    expect(partitions.partitionOfFile.get('src/b.ts')).toBe(''); // owned by the repo-root package.json, not `_root`
  });

  it('files under no marker at all belong to `_root`', async () => {
    const config = await defaultRootsConfig();
    const files = ['lib/a.go'];
    const rawScopes = manyScopes('lib/a.go', 400);
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.partitionOfFile.get('lib/a.go')).toBe('_root');
    expect(partitions.moduleRootDirOfFile.get('lib/a.go')).toBe('');
  });

  it('go.mod, pom.xml, *.csproj, *.sln and setup.cfg are all recognized markers (no grammar filter applies to the marker scan)', async () => {
    const config = await defaultRootsConfig();
    const files = ['svc-go/go.mod', 'svc-go/main.go', 'svc-java/pom.xml', 'svc-java/App.java', 'svc-cs/App.csproj', 'svc-cs/Program.cs', 'svc-py/setup.cfg', 'svc-py/app.py'];
    const rawScopes = [
      ...manyScopes('svc-go/main.go', 300),
      ...manyScopes('svc-java/App.java', 300),
      ...manyScopes('svc-cs/Program.cs', 300),
      ...manyScopes('svc-py/app.py', 300),
    ];
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.packageRoots.sort()).toEqual(['svc-cs', 'svc-go', 'svc-java', 'svc-py']);
  });
});

describe('derivePartitions — the 300-scope floor and the `_repo` merge (spec §6.8)', () => {
  it('a partition with >= 300 raw scopes stands on its own', async () => {
    const config = await defaultRootsConfig();
    const files = ['pkg/package.json', 'pkg/a.ts'];
    const partitions = derivePartitions(files, manyScopes('pkg/a.ts', 300), config);
    expect(partitions.partitionOfFile.get('pkg/a.ts')).toBe('pkg');
    expect(partitions.statusOfKey.get('pkg')).toBe('own-floor');
    expect(partitions.survivingPartitionIds).toEqual(['pkg']);
    expect(partitions.silent).toBe(false);
  });

  it('a partition under 300 scopes merges into `_repo`, combined with other under-floor partitions', async () => {
    const config = await defaultRootsConfig();
    const files = ['pkg-a/package.json', 'pkg-a/a.ts', 'pkg-b/package.json', 'pkg-b/b.ts'];
    const rawScopes = [...manyScopes('pkg-a/a.ts', 150), ...manyScopes('pkg-b/b.ts', 200)];
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.partitionOfFile.get('pkg-a/a.ts')).toBe('_repo');
    expect(partitions.partitionOfFile.get('pkg-b/b.ts')).toBe('_repo');
    expect(partitions.statusOfKey.get('pkg-a')).toBe('repo-merged');
    expect(partitions.statusOfKey.get('pkg-b')).toBe('repo-merged');
    expect(partitions.survivingPartitionIds).toEqual(['_repo']);
    expect(partitions.silent).toBe(false); // 150+200=350 >= 300, the merged bucket clears the floor
    // §6.3's stated convention: a merged partition substitutes the repo root
    // for the "partition root" arm of the module nearest-of rule.
    expect(partitions.moduleRootDirOfFile.get('pkg-a/a.ts')).toBe('');
  });

  // Reviewer probe shape (REWORK R1): a repo with a large, well-floored
  // partition ALONGSIDE a small, under-floor one must not be silent — the
  // large one survives regardless of what happens to the small one, and the
  // small one's own scopes are DROPPED (not silently reassigned to `_repo`),
  // exactly matching the prototype's own per-bucket merge loop.
  it('a big own-floor partition survives independently of a small partition merging (and dropping) elsewhere — the repo is NOT silent', async () => {
    const config = await defaultRootsConfig();
    const files = ['big/package.json', 'big/a.ts', 'tiny/package.json', 'tiny/b.ts'];
    const rawScopes = [...manyScopes('big/a.ts', 5000), ...manyScopes('tiny/b.ts', 10)];
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.statusOfKey.get('big')).toBe('own-floor');
    expect(partitions.statusOfKey.get('tiny')).toBe('dropped'); // 10 alone is the WHOLE merge bucket, still < 300
    expect(partitions.partitionOfFile.get('big/a.ts')).toBe('big');
    expect(partitions.partitionOfFile.has('tiny/b.ts')).toBe(false); // dropped: no entry at all, not '_repo'
    expect(partitions.moduleRootDirOfFile.has('tiny/b.ts')).toBe(false);
    expect(partitions.survivingPartitionIds).toEqual(['big']);
    expect(partitions.silent).toBe(false); // `big` survived — the repo is not silent just because `tiny` dropped
  });

  // The pure drop case: a SINGLE under-floor partition, nothing else to
  // clear the floor — the merged bucket IS just this partition, stays under
  // 300, and is dropped whole; this also happens to be the repo-wide-silent
  // case (J4) since nothing else exists to survive.
  it('a lone under-floor partition (no other partition to merge with) is DROPPED — no `_repo` fallback assignment — and the repo is silent (J4)', async () => {
    const config = await defaultRootsConfig();
    const files = ['pkg-a/package.json', 'pkg-a/a.ts'];
    const rawScopes = manyScopes('pkg-a/a.ts', 50);
    const partitions = derivePartitions(files, rawScopes, config);
    expect(partitions.statusOfKey.get('pkg-a')).toBe('dropped');
    expect(partitions.partitionOfFile.has('pkg-a/a.ts')).toBe(false); // dropped, not '_repo'
    expect(partitions.moduleRootDirOfFile.has('pkg-a/a.ts')).toBe(false);
    expect(partitions.survivingPartitionIds).toEqual([]);
    expect(partitions.silent).toBe(true);
  });

  it('zero scopes at all: no partition exists to survive, so the repo is silent (spec: "repo with < 300 scopes ... -> silent" holds literally, not only its at-least-one-merge special case)', async () => {
    const config = await defaultRootsConfig();
    const partitions = derivePartitions([], [], config);
    expect(partitions.silent).toBe(true);
    expect(partitions.survivingPartitionIds).toEqual([]);
    expect(partitions.partitionOfFile.size).toBe(0);
  });

  it(`PARTITION_SCOPE_FLOOR is the spec's fixed constant (300)`, () => {
    expect(PARTITION_SCOPE_FLOOR).toBe(300);
  });
});

describe('makeRootsFileFilters — the two exclusion flavors (spec §6.8, §21.3)', () => {
  it('forMarkers excludes the built-in list, ignoring `include` entirely (a narrow include must not hide a package marker)', async () => {
    const config = await defaultRootsConfig('include:\n    - "src/**"\n');
    const filters = makeRootsFileFilters(config);
    expect(filters.forMarkers('go.mod')).toBe(true); // outside `include`, but forMarkers doesn't consult include at all
    expect(filters.forMarkers('node_modules/x/package.json')).toBe(false); // built-in exclusion
  });

  it('forParsing requires include AND excludes test-pattern files (mining-only), which forMarkers does not exclude', async () => {
    const config = await defaultRootsConfig('include:\n    - "src/**"\n');
    const filters = makeRootsFileFilters(config);
    expect(filters.forParsing('src/a.ts')).toBe(true);
    expect(filters.forParsing('lib/a.ts')).toBe(false); // outside include
    expect(filters.forParsing('src/a.test.ts')).toBe(false); // mining-only exclusion
    expect(filters.forMarkers('src/a.test.ts')).toBe(true); // NOT excluded from the marker scan (not a mining concern)
  });

  it('config.exclude merges with the built-in list for BOTH flavors', async () => {
    const config = await defaultRootsConfig('exclude:\n    - "legacy/**"\n');
    const filters = makeRootsFileFilters(config);
    expect(filters.forMarkers('legacy/package.json')).toBe(false);
    expect(filters.forParsing('legacy/a.ts')).toBe(false);
  });

  it('the built-in exclusion list matches spec v6-spec.md:271 verbatim (count + a few spot entries)', () => {
    expect(BUILT_IN_EXCLUSIONS).toHaveLength(20);
    expect(BUILT_IN_EXCLUSIONS).toContain('**/node_modules/**');
    expect(BUILT_IN_EXCLUSIONS).toContain('**/.yggdrasil/**');
    expect(BUILT_IN_EXCLUSIONS).toContain('**/*.d.ts');
    // The test-pattern clause is documented as a SEPARATE, mining-only
    // addition (spec's own "for convention mining" qualifier) — never in
    // the general built-in list.
    expect(BUILT_IN_EXCLUSIONS).not.toContain('**/*.test.*');
  });
});
