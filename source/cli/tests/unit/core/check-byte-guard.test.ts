import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectFindingByteGuardCandidates,
  collectPairByteGuardCandidates,
  filesOfIssue,
} from '../../../src/core/check-byte-guard.js';
import { hashGitBlob, progressivePairKey, type BurnSet } from '../../../src/core/progressive-scope.js';
import type { VerifiedPair, PairState } from '../../../src/core/verify-lock.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import type { CheckIssue } from '../../../src/core/check-contract.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// The GATHERING half of the byte guard: which findings are worth asking the
// bytes about, which files each one is about, and what those files contain.
// Every case runs against real files in a real throwaway directory — the
// module's whole job is the disk and graph access the pure comparer must not
// do, so a stubbed filesystem would test nothing.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project root holding the given repo-relative files with the given content. */
async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-byteguard-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  return root;
}

/** A one-component graph whose mapping owns `src/`, for owner resolution. */
function graphOwning(nodePath = 'svc', mapping = ['src/']): Graph {
  const node = {
    path: nodePath,
    meta: { name: nodePath, type: 'service', mapping },
    children: [],
    parent: null,
  } as unknown as GraphNode;
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map([[nodePath, node]]),
    aspects: [],
    flows: [],
    rootPath: '/tmp/.yggdrasil',
  } as unknown as Graph;
}

function pairOf(overrides: Partial<ExpectedPair> = {}): ExpectedPair {
  return {
    aspectId: 'a',
    kind: 'deterministic',
    unitKey: 'node:svc',
    nodePath: 'svc',
    status: 'enforced',
    subjectFiles: ['src/svc.ts'],
    ...overrides,
  };
}

function verifiedPair(state: PairState, overrides: Partial<ExpectedPair> = {}): VerifiedPair {
  return { pair: pairOf(overrides), state };
}

function burnOf(overrides: Partial<BurnSet> = {}): BurnSet {
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(),
    files: new Set(),
    logOnlyNodePaths: new Set(),
    changedInputCount: 0,
    ...overrides,
  };
}

/** A change scope whose reference listing is present — the guard-enabled shape. */
function scopeOf(burn: BurnSet = burnOf(), listing?: Map<string, string>): {
  burn: BurnSet;
  blobOidByPath: Map<string, string> | null;
} {
  return { burn, blobOidByPath: listing ?? new Map([['src/svc.ts', hashGitBlob(Buffer.from(''))]]) };
}

const K = progressivePairKey;

/** The blocking finding a component-keyed rule produces — no rule check named. */
const undeclaredDependency = (nodePath: string): CheckIssue => ({
  severity: 'error',
  code: 'relation-undeclared-dependency',
  rule: 'relation-undeclared-dependency',
  nodePath,
  messageData: { what: 'w', why: 'y', next: 'n' },
});

/** The blocking finding a rule check produces. */
const unverified = (aspectId: string, unitKey: string, nodePath?: string): CheckIssue => ({
  severity: 'error',
  code: 'unverified',
  rule: 'unverified',
  aspectId,
  unitKey,
  nodePath,
  messageData: { what: 'w', why: 'y', next: 'n' },
});

async function gather(args: {
  root: string;
  issues: CheckIssue[];
  pairs?: VerifiedPair[];
  scope?: ReturnType<typeof scopeOf>;
  graph?: Graph;
  visibleFiles?: string[] | null;
}): ReturnType<typeof collectFindingByteGuardCandidates> {
  return collectFindingByteGuardCandidates({
    scope: args.scope ?? scopeOf(),
    issues: args.issues,
    pairs: args.pairs ?? [],
    graph: args.graph ?? graphOwning(),
    visibleFiles: args.visibleFiles === undefined ? ['src/svc.ts'] : args.visibleFiles,
    projectRoot: args.root,
  });
}

describe('collectFindingByteGuardCandidates — every identity a finding can carry', () => {
  it('asks about a COMPONENT-keyed finding using that component’s own files', async () => {
    // The class the rule-check-only gathering missed entirely: an undeclared
    // cross-component dependency names a component and nothing else, so a hidden
    // edit that introduced one was never even considered.
    const root = await projectWith({ 'src/svc.ts': 'import x from "../other";\n' });
    const { candidates } = await gather({ root, issues: [undeclaredDependency('svc')] });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pairKey).toBeUndefined();
    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts']);
    expect(candidates[0].subjects[0].owner).toBe('svc');
    expect(candidates[0].subjects[0].bytes?.toString('utf-8')).toBe('import x from "../other";\n');
  });

  it('asks about a RULE-CHECK finding using this run’s own subject enumeration', async () => {
    const root = await projectWith({ 'src/svc.ts': 'export const svc = 1;\n' });
    const { candidates } = await gather({
      root,
      issues: [unverified('a', 'node:svc')],
      pairs: [verifiedPair({ kind: 'unverified' })],
    });

    expect(candidates[0].pairKey).toBe(K('a', 'node:svc'));
    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts']);
  });

  it('asks about a FILE-keyed finding using the file its unit names', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      issues: [
        {
          severity: 'error',
          code: 'ambiguous-node-type',
          rule: 'ambiguous-node-type',
          unitKey: 'file:src/svc.ts',
          messageData: { what: 'w', why: 'y', next: 'n' },
        },
      ],
    });

    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts']);
  });

  it('asks about an EDGE-keyed finding using both ends of every edge it names', async () => {
    const root = await projectWith({ 'src/svc.ts': 'a\n', 'src/other.ts': 'b\n' });
    const { candidates } = await gather({
      root,
      issues: [
        {
          severity: 'error',
          code: 'type-relation-forbidden',
          rule: 'type-relation-forbidden',
          relationEdges: [{ fromFile: 'src/svc.ts', toFile: 'src/other.ts' }],
          messageData: { what: 'w', why: 'y', next: 'n' },
        },
      ],
    });

    expect(candidates[0].subjects.map((s) => s.path).sort()).toEqual(['src/other.ts', 'src/svc.ts']);
  });

  it('asks about the aggregate coverage finding using only its INHERITED half', async () => {
    // That finding is split rather than downgraded, so the half already in scope
    // is not at risk and asking about it would be work with no possible effect.
    const root = await projectWith({ 'src/svc.ts': 'a\n', 'src/other.ts': 'b\n' });
    const { candidates } = await gather({
      root,
      scope: scopeOf(burnOf({ files: new Set(['src/svc.ts']) })),
      issues: [
        {
          severity: 'error',
          code: 'unmapped-files',
          rule: 'unmapped-files',
          uncoveredFiles: ['src/svc.ts', 'src/other.ts'],
          messageData: { what: 'w', why: 'y', next: 'n' },
        },
      ],
    });

    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/other.ts']);
  });

});

describe('collectFindingByteGuardCandidates — which findings it leaves alone', () => {
  it('ignores a finding already in scope', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      scope: scopeOf(burnOf({ nodePaths: new Set(['svc']) })),
      issues: [undeclaredDependency('svc')],
    });
    expect(candidates).toEqual([]);
  });

  it('ignores a warning, which nothing downgrades', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      issues: [{ ...undeclaredDependency('svc'), severity: 'warning' }],
    });
    expect(candidates).toEqual([]);
  });

  it('ignores a code the classifier is never allowed to downgrade', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      issues: [
        {
          severity: 'error',
          code: 'structural-cycle',
          rule: 'structural-cycle',
          nodePath: 'svc',
          messageData: { what: 'w', why: 'y', next: 'n' },
        },
      ],
    });
    expect(candidates).toEqual([]);
  });

  it('ignores a finding that names no file it could ask about', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      issues: [
        {
          severity: 'error',
          code: 'unverified',
          rule: 'unverified',
          messageData: { what: 'w', why: 'y', next: 'n' },
        },
      ],
    });
    expect(candidates).toEqual([]);
  });

  it('falls back to a component’s rule-check subjects when there is no file walk', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      visibleFiles: null,
      issues: [undeclaredDependency('svc')],
      pairs: [verifiedPair({ kind: 'verified' })],
    });
    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts']);
  });

  it('reads a file named by several findings exactly once', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const { candidates } = await gather({
      root,
      issues: [undeclaredDependency('svc'), { ...undeclaredDependency('svc'), code: 'description-missing', rule: 'description-missing' }],
    });
    expect(candidates).toHaveLength(2);
    // The same buffer object, not two equal reads.
    expect(candidates[0].subjects[0].bytes).toBe(candidates[1].subjects[0].bytes);
  });

  it('prefers bytes the run already read over a second trip to disk', async () => {
    // What the lock verification loaded to re-hash a subject is what the guard
    // must compare, so the two can never see different content for one file.
    const root = await projectWith({ 'src/svc.ts': 'on disk\n' });
    const alreadyRead = new Map([[path.resolve(root, 'src/svc.ts'), Buffer.from('as hashed\n')]]);
    const { candidates } = await collectFindingByteGuardCandidates({
      scope: scopeOf(),
      issues: [undeclaredDependency('svc')],
      pairs: [],
      graph: graphOwning(),
      visibleFiles: ['src/svc.ts'],
      projectRoot: root,
      alreadyRead,
    });
    expect(candidates[0].subjects[0].bytes?.toString('utf-8')).toBe('as hashed\n');
  });
});

describe('collectFindingByteGuardCandidates — when it does nothing at all', () => {
  const cases: Array<[string, ReturnType<typeof scopeOf> | undefined]> = [
    ['no change scope', undefined],
    ['no reference listing', { burn: burnOf(), blobOidByPath: null }],
    ['a scope that already went global', scopeOf(burnOf({ global: true }))],
  ];

  for (const [label, scope] of cases) {
    it(`gathers nothing with ${label}`, async () => {
      const root = await projectWith({ 'src/svc.ts': 'x\n' });
      const result = await collectFindingByteGuardCandidates({
        scope,
        issues: [undeclaredDependency('svc')],
        pairs: [],
        graph: graphOwning(),
        visibleFiles: ['src/svc.ts'],
        projectRoot: root,
      });
      expect(result.candidates).toEqual([]);
      expect(result.unsupportedObjectFormat).toBe(false);
    });
  }

  it('reports, rather than swallows, ids in a format it cannot reproduce', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n' });
    const result = await gather({
      root,
      scope: scopeOf(burnOf(), new Map([['src/svc.ts', 'deadbeef']])),
      issues: [undeclaredDependency('svc')],
    });
    expect(result.candidates).toEqual([]);
    expect(result.unsupportedObjectFormat).toBe(true);
  });
});

describe('collectPairByteGuardCandidates — the fill stage’s half', () => {
  it('gathers an out-of-scope rule check that is failing, with its bytes', async () => {
    const root = await projectWith({ 'src/svc.ts': 'export const svc = 1;\n' });
    const { candidates } = await collectPairByteGuardCandidates({ scope: scopeOf(), pairs: [verifiedPair({ kind: 'unverified' })], graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pairKey).toBe(K('a', 'node:svc'));
    expect(candidates[0].subjects[0].owner).toBe('svc');
    expect(candidates[0].subjects[0].bytes?.toString('utf-8')).toBe('export const svc = 1;\n');
  });

  it('ignores a passing rule check — there is nothing to buy or to keep', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({ scope: scopeOf(), pairs: [verifiedPair({ kind: 'verified' })], graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });
    expect(candidates).toEqual([]);
  });

  it('ignores an ADVISORY refusal, which is already a warning nothing downgrades', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({ scope: scopeOf(), pairs: [verifiedPair({ kind: 'refused', reason: 'no' }, { status: 'advisory' })], graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });
    expect(candidates).toEqual([]);
  });

  it('gathers a rule check whose verdict is VALID but whose prompt outgrew its tier', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({ scope: scopeOf(), pairs: [{ pair: pairOf(), state: { kind: 'verified' }, oversized: { chars: 10, limit: 5, tierName: 'standard' } }], graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });
    expect(candidates.map((c) => c.pairKey)).toEqual([K('a', 'node:svc')]);
  });

  it('ignores a rule check the burn table already burned', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({ scope: scopeOf(burnOf({ pairKeys: new Set([K('a', 'node:svc')]) })), pairs: [verifiedPair({ kind: 'unverified' })], graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });
    expect(candidates).toEqual([]);
  });

  it('carries an unreadable subject as null rather than dropping it', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({
      scope: scopeOf(),
      pairs: [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts', 'src/vanished.ts'] })],
      graph: graphOwning(),
      visibleFiles: ['src/svc.ts'],
      projectRoot: root,
    });
    expect(candidates[0].subjects.map((s) => s.path).sort()).toEqual(['src/svc.ts', 'src/vanished.ts']);
    expect(candidates[0].subjects[1].bytes).toBeNull();
  });

  it('reads a file shared by several rule checks exactly once', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates({
      scope: scopeOf(),
      pairs: [
        verifiedPair({ kind: 'unverified' }, { aspectId: 'a' }),
        verifiedPair({ kind: 'unverified' }, { aspectId: 'b' }),
      ],
      graph: graphOwning(),
      visibleFiles: ['src/svc.ts'],
      projectRoot: root,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].subjects[0].bytes).toBe(candidates[1].subjects[0].bytes);
  });

  it('gathers nothing when there is no scope, no listing, or a global scope', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const pairs = [verifiedPair({ kind: 'unverified' })];
    expect((await collectPairByteGuardCandidates({ scope: undefined, pairs: pairs, graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root })).candidates).toEqual([]);
    expect(
      (await collectPairByteGuardCandidates({ scope: { burn: burnOf(), blobOidByPath: null }, pairs: pairs, graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root })).candidates,
    ).toEqual([]);
    expect(
      (await collectPairByteGuardCandidates({ scope: scopeOf(burnOf({ global: true })), pairs: pairs, graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root })).candidates,
    ).toEqual([]);
  });
});

describe('the component -> rule-check index both halves hand the decision', () => {
  it('names every rule check a component owns, so re-admitting it re-admits them all', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n', 'src/helper.ts': 'y\n' });
    const pairs = [
      verifiedPair({ kind: 'unverified' }, { unitKey: 'file:src/svc.ts', subjectFiles: ['src/svc.ts'] }),
      verifiedPair({ kind: 'unverified' }, { unitKey: 'file:src/helper.ts', subjectFiles: ['src/helper.ts'] }),
      // Nodeless (type-covered): no component owns it, so it belongs to no entry.
      verifiedPair({ kind: 'unverified' }, { unitKey: 'file:src/loose.ts', nodePath: undefined }),
    ];

    const fromFindings = await gather({ root, issues: [], pairs });
    const fromPairs = await collectPairByteGuardCandidates({ scope: scopeOf(), pairs: pairs, graph: graphOwning(), visibleFiles: ['src/svc.ts'], projectRoot: root });

    for (const index of [fromFindings.pairKeysByNode, fromPairs.pairKeysByNode]) {
      expect(index.get('svc')).toEqual([K('a', 'file:src/svc.ts'), K('a', 'file:src/helper.ts')]);
      expect([...index.keys()]).toEqual(['svc']);
    }
  });
});

describe('filesOfIssue — the dual of the classification ladder’s rungs', () => {
  const noNodeFiles = (): string[] => [];
  const noOutside = (): string[] => [];

  it('names the fixed project files a finding is always about', () => {
    // Unreachable through the gathering pass today (no fixed-input code is
    // downgradable), which is exactly why it is proved here directly: a code
    // admitted to both sets later is attributed by these paths, and a gatherer
    // that never learned to ask about them would reopen the evasion for it.
    const files = filesOfIssue(
      {
        severity: 'error',
        code: 'rules-digest-stale',
        rule: 'rules-digest-stale',
        messageData: { what: 'w', why: 'y', next: 'n' },
      },
      new Map(),
      noNodeFiles,
      noOutside,
    );
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('CLAUDE.md');
  });

  it('names nothing for a finding carrying no identity it could ask about', () => {
    expect(
      filesOfIssue(
        { severity: 'error', code: 'unverified', rule: 'unverified', messageData: { what: 'w', why: 'y', next: 'n' } },
        new Map(),
        noNodeFiles,
        noOutside,
      ),
    ).toEqual([]);
  });

  it('unions every identity a finding happens to carry at once', () => {
    // A rule-check finding also carries its component, and both are asked about:
    // over-gathering is safe (a file that did not move re-admits nothing) while
    // under-gathering is the defect this whole rung set exists to prevent.
    const files = filesOfIssue(
      unverified('a', 'node:svc', 'svc'),
      new Map([[K('a', 'node:svc'), ['src/svc.ts']]]),
      () => ['src/svc.ts', 'src/helper.ts'],
      noOutside,
    );
    expect(files.sort()).toEqual(['src/helper.ts', 'src/svc.ts']);
  });
});

describe('both halves ask about the same files', () => {
  // The half-closed shape the close-out review found: the forcing step agreed on
  // what to do with an answer while the two gatherers were answering different
  // questions. A component file that no rule check has as a subject — a mapped
  // documentation file, or a binary asset a prose rule is never given — belongs
  // to the component and to no subject set, so the narrower half never asked
  // about it and the review it should have bought was bought by nobody.
  it('asks a rule check about its component’s files, not only its own subjects', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n', 'src/README.md': 'docs\n' });
    const pairs = [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts'] })];

    const { candidates } = await collectPairByteGuardCandidates({
      scope: scopeOf(),
      pairs,
      graph: graphOwning(),
      visibleFiles: ['src/svc.ts', 'src/README.md'],
      projectRoot: root,
    });

    expect(candidates[0].subjects.map((s) => s.path).sort()).toEqual(['src/README.md', 'src/svc.ts']);
    expect(candidates[0].subjects.every((s) => s.owner === 'svc')).toBe(true);
  });

  it('resolves a component to exactly the same files on both paths', async () => {
    // Asserted as an equality between the two halves rather than as two
    // independent expectations, because "the same" is the property that broke.
    const root = await projectWith({ 'src/svc.ts': 'x\n', 'src/logo.png': 'PNGDATA\n' });
    const pairs = [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts'] })];
    const visibleFiles = ['src/svc.ts', 'src/logo.png'];

    const fromPairs = await collectPairByteGuardCandidates({
      scope: scopeOf(),
      pairs,
      graph: graphOwning(),
      visibleFiles,
      projectRoot: root,
    });
    const fromFindings = await collectFindingByteGuardCandidates({
      scope: scopeOf(),
      issues: [unverified('a', 'node:svc', 'svc')],
      pairs,
      graph: graphOwning(),
      visibleFiles,
      projectRoot: root,
    });

    const paths = (g: { candidates: Array<{ subjects: Array<{ path: string }> }> }): string[] =>
      g.candidates[0].subjects.map((s) => s.path).sort();
    expect(paths(fromPairs)).toEqual(paths(fromFindings));
    expect(paths(fromPairs)).toEqual(['src/logo.png', 'src/svc.ts']);
  });

  it('falls back to rule-check subjects on both paths when there is no file walk', async () => {
    const root = await projectWith({ 'src/svc.ts': 'x\n', 'src/README.md': 'docs\n' });
    const pairs = [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts'] })];

    const { candidates } = await collectPairByteGuardCandidates({
      scope: scopeOf(),
      pairs,
      graph: graphOwning(),
      visibleFiles: null,
      projectRoot: root,
    });

    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts']);
  });
});
