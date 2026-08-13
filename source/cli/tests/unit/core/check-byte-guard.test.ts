import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectFindingByteGuardCandidates,
  collectPairByteGuardCandidates,
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
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'unverified' })],
      root,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pairKey).toBe(K('a', 'node:svc'));
    expect(candidates[0].subjects[0].owner).toBe('svc');
    expect(candidates[0].subjects[0].bytes?.toString('utf-8')).toBe('export const svc = 1;\n');
  });

  it('ignores a passing rule check — there is nothing to buy or to keep', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'verified' })],
      root,
    );
    expect(candidates).toEqual([]);
  });

  it('ignores an ADVISORY refusal, which is already a warning nothing downgrades', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'refused', reason: 'no' }, { status: 'advisory' })],
      root,
    );
    expect(candidates).toEqual([]);
  });

  it('gathers a rule check whose verdict is VALID but whose prompt outgrew its tier', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [{ pair: pairOf(), state: { kind: 'verified' }, oversized: { chars: 10, limit: 5, tierName: 'standard' } }],
      root,
    );
    expect(candidates.map((c) => c.pairKey)).toEqual([K('a', 'node:svc')]);
  });

  it('ignores a rule check the burn table already burned', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(burnOf({ pairKeys: new Set([K('a', 'node:svc')]) })),
      [verifiedPair({ kind: 'unverified' })],
      root,
    );
    expect(candidates).toEqual([]);
  });

  it('carries an unreadable subject as null rather than dropping it', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts', 'src/vanished.ts'] })],
      root,
    );
    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts', 'src/vanished.ts']);
    expect(candidates[0].subjects[1].bytes).toBeNull();
  });

  it('reads a file shared by several rule checks exactly once', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const { candidates } = await collectPairByteGuardCandidates(
      scopeOf(),
      [
        verifiedPair({ kind: 'unverified' }, { aspectId: 'a' }),
        verifiedPair({ kind: 'unverified' }, { aspectId: 'b' }),
      ],
      root,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0].subjects[0].bytes).toBe(candidates[1].subjects[0].bytes);
  });

  it('gathers nothing when there is no scope, no listing, or a global scope', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const pairs = [verifiedPair({ kind: 'unverified' })];
    expect((await collectPairByteGuardCandidates(undefined, pairs, root)).candidates).toEqual([]);
    expect(
      (await collectPairByteGuardCandidates({ burn: burnOf(), blobOidByPath: null }, pairs, root)).candidates,
    ).toEqual([]);
    expect(
      (await collectPairByteGuardCandidates(scopeOf(burnOf({ global: true })), pairs, root)).candidates,
    ).toEqual([]);
  });
});
