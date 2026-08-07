/**
 * Tests for core/verify-lock.ts — the lock-verification engine (spec §6, §3.1, §4).
 *
 * Every test builds a real on-disk graph in a tmpdir: verifyLock reads subject
 * file bytes, reference bytes, aspect artifact content, and re-observes
 * deterministic touched keys against current disk state. Lock entries are seeded
 * with hashes computed from the SAME frozen-contract helpers verifyLock uses, so
 * a valid entry verifies and any input change degrades it to unverified.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Graph, GraphNode, AspectDef, ScopeDef, LlmConfig } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';
import { nodeUnit, fileUnit, LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { verifyLock, verifyPairs } from '../../../src/core/verify-lock.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import { assembledPromptChars } from '../../../src/llm/prompt.js';
import {
  hashExistsObservation,
  hashNodeSetObservation,
  observationKey,
  MISSING_OBSERVATION,
} from '../../../src/core/pair-hash.js';
import {
  computeSeedLlmHash,
  computeSeedDetHash,
  reObserveForSeed as reObserveForSeedShared,
} from '../helpers/seed-lock.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-verify-lock-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const DEFAULT_TIER: LlmConfig = {
  provider: 'ollama',
  model: 'test',
  temperature: 0,
  consensus: 1,
};

interface TestAspect {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  description?: string;
  ruleContent: string;          // content.md or check.mjs bytes
  scope?: ScopeDef;
  references?: Array<{ path: string; description?: string }>;
  /** companion.mjs bytes — when set on an LLM aspect, an artifact is added so
   *  companionHashFor() returns a hash and verify folds companionHash. */
  companion?: string;
}

interface TestNode {
  path: string;
  mapping: string[];
  aspects: string[];
  description?: string;
}

function buildGraph(
  nodes: TestNode[],
  aspects: TestAspect[],
  opts?: { tier?: LlmConfig },
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => {
    const artifacts = [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: a.ruleContent }];
    if (a.companion !== undefined) artifacts.push({ filename: 'companion.mjs', content: a.companion });
    return {
      id: a.id,
      name: a.id,
      description: a.description,
      reviewer: { type: a.kind },
      status: a.status ?? 'enforced',
      artifacts,
      scope: a.scope,
      references: a.references,
      hasCompanion: a.companion !== undefined ? true : undefined,
    } as AspectDef;
  });

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type: 'service', aspects: n.aspects, mapping: n.mapping, description: n.description },
      children: [],
      parent: null,
    } as GraphNode);
  }

  return {
    config: {
      version: '5.0.0',
      reviewer: { tiers: { default: opts?.tier ?? DEFAULT_TIER }, default: 'default' },
    },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    rootPath,
  } as unknown as Graph;
}

function emptyLock(): LockFile {
  return { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
}

/**
 * Compute the valid LLM hash for a pair given current disk state.
 * Delegates to the shared seed-lock fold so the frozen contract lives in ONE
 * place (subjects/references are read from disk relative to tmpDir).
 */
function llmHash(params: {
  aspect: TestAspect;
  nodePath: string;
  subjectFiles: string[];
  verdict: 'approved' | 'refused';
  tier?: LlmConfig;
}): Promise<string> {
  return computeSeedLlmHash(tmpDir, {
    aspectId: params.aspect.id,
    aspectDescription: params.aspect.description,
    scope: params.aspect.scope,
    nodePath: params.nodePath,
    ruleContent: params.aspect.ruleContent,
    subjectFiles: params.subjectFiles,
    references: params.aspect.references,
    tier: params.tier ?? DEFAULT_TIER,
    verdict: params.verdict,
  });
}

/** Compute the valid deterministic hash for a pair given current disk state. */
function detHash(params: {
  aspect: TestAspect;
  nodePath: string;
  subjectFiles: string[];
  touched: Array<[string, string]>;
  verdict: 'approved' | 'refused';
}): Promise<string> {
  return computeSeedDetHash(tmpDir, {
    aspectId: params.aspect.id,
    scope: params.aspect.scope,
    nodePath: params.nodePath,
    ruleContent: params.aspect.ruleContent,
    subjectFiles: params.subjectFiles,
    touched: params.touched,
    verdict: params.verdict,
  });
}

function setEntry(lock: LockFile, aspectId: string, unitKey: string, entry: VerdictEntry): void {
  (lock.verdicts[aspectId] ??= {})[unitKey] = entry;
}


// ---------------------------------------------------------------------------
// LLM pair validity
// ---------------------------------------------------------------------------

describe('verifyLock — LLM pair validity', () => {
  it('missing entry → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('valid approved entry → verified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('valid refused entry → refused with stored reason', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'refused',
      reason: 'violated rule at src/a.ts:3',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'refused' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state).toEqual({ kind: 'refused', reason: 'violated rule at src/a.ts:3' });
  });

  it('subject-file edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    writeFile('src/a.ts', 'code CHANGED'); // edit after seeding
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('aspect content.md edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    // Seed against the ORIGINAL rule content, then mutate the artifact in-memory
    // (simulating a content.md edit between approve and check).
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    graph.aspects[0].artifacts[0].content = 'rule EDITED';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('reference content edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('docs/ref.md', 'ref-v1');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      references: [{ path: 'docs/ref.md', description: 'catalogue' }],
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    writeFile('docs/ref.md', 'ref-v2'); // edit reference content
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('tier CONFIG change is NOT an input — model/consensus change keeps the verdict valid (only the tier NAME folds in)', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const tierV1: LlmConfig = { provider: 'ollama', model: 'm1', temperature: 0, consensus: 1 };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier: tierV1 });
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier: tierV1 }),
    });
    // Change the tier model + consensus — config is the reviewer's private business,
    // not a verdict input, so the pair stays VERIFIED.
    graph.config.reviewer!.tiers.default.model = 'm2';
    graph.config.reviewer!.tiers.default.consensus = 3;
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('verdict-token tamper (entry says approved but hash computed for refused) → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved', // tampered token
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'refused' }), // hash for refused
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('node description is NOT an input — changing it keeps the verdict valid', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph(
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'], description: 'original' }],
      [aspect],
    );
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    graph.nodes.get('svc')!.meta.description = 'changed prompt garnish';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('no reviewer config → tier cannot resolve → an LLM entry cannot be revalidated → unverified', async () => {
    // When graph.config.reviewer is absent, selectTierForAspect is never called
    // (the `reviewer ? … : undefined` else arm) and the validity recompute is
    // skipped — the pair degrades to unverified (fail-closed).
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    // Strip the reviewer config entirely.
    (graph.config as { reviewer?: unknown }).reviewer = undefined;
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), { verdict: 'approved', hash: 'whatever' });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

});

// ---------------------------------------------------------------------------
// Deterministic pair validity + observation re-observation
// ---------------------------------------------------------------------------

describe('verifyLock — deterministic pair validity', () => {
  // Seed touched observations through the shared re-observer (reads current disk
  // relative to tmpDir), so the seed stays byte-compatible with verifyLock.
  async function detGraph(
    touchedKeys: string[] = [],
  ): Promise<{ graph: Graph; aspect: TestAspect; touched: Array<[string, string]> }> {
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const touched: Array<[string, string]> = [];
    for (const k of touchedKeys) touched.push([k, await reObserveForSeedShared(tmpDir, k)]);
    return { graph, aspect, touched };
  }

  it('valid approved det entry → verified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('valid refused det entry renders stored reason', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'refused',
      reason: 'src/a.ts:1: forbidden import',
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'refused' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state).toEqual({ kind: 'refused', reason: 'src/a.ts:1: forbidden import' });
  });

  it('touched read: file edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/shared.ts', 'shared-v1');
    const key = observationKey('read', 'src/shared.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/shared.ts', 'shared-v2'); // edit the touched file
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched list: dir gains a file → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/handlers/one.ts', 'one');
    const key = observationKey('list', 'src/handlers');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/handlers/two.ts', 'two'); // dir listing changes
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched exists:false path now exists → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const key = observationKey('exists', 'src/maybe.ts'); // absent at seed time
    const { graph, aspect, touched } = await detGraph([key]);
    expect(touched[0][1]).toBe(hashExistsObservation(false)); // seeded as false
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/maybe.ts', 'now here'); // the negative probe is now positive
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched graph: node yaml edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('.yggdrasil/model/other/yg-node.yaml', 'name: other\n');
    const key = observationKey('graph', 'other');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('.yggdrasil/model/other/yg-node.yaml', 'name: other\ntype: changed\n');
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('re-observation of a DELETED touched read file → unverified (no throw)', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/gone.ts', 'present');
    const key = observationKey('read', 'src/gone.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    rmSync(path.join(tmpDir, 'src/gone.ts')); // delete the touched file
    const result = await verifyLock(graph, lock); // must not throw
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('unchanged touched observations keep the verdict verified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/shared.ts', 'shared');
    const key = observationKey('read', 'src/shared.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock); // nothing changed
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('touched list: directory that DISAPPEARED re-observes MISSING → unverified', async () => {
    // The listed directory existed at seed time; deleting it makes listDir return
    // null → MISSING_OBSERVATION (the entries===null arm of the list re-observe).
    writeFile('src/a.ts', 'code');
    writeFile('src/handlers/one.ts', 'one');
    const key = observationKey('list', 'src/handlers');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    rmSync(path.join(tmpDir, 'src/handlers'), { recursive: true }); // dir gone
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// Deterministic graph-SET observation re-observation (Bugs 2 & 3 + flow minor)
//
// Each test seeds a det entry whose `touched` carries a graph-set observation
// (absent-node / children / by-type / flow) computed exactly as the RECORDER
// would, then asserts: unchanged graph re-observes the same value (verified),
// and a membership mutation re-observes a different value (unverified). This is
// the record↔re-observe symmetry guarantee for the new observation kinds.
// ---------------------------------------------------------------------------

describe('verifyLock — deterministic graph-set observations', () => {
  /** Attach parent→children wiring onto an already-built graph. */
  function linkChildren(graph: Graph, parent: string, children: string[]): void {
    const p = graph.nodes.get(parent)!;
    p.children = children.map((c) => {
      const child = graph.nodes.get(c)!;
      child.parent = p;
      return child;
    });
  }

  it('graph: absent-node observation — creating the node later → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph', 'ghost'); // node 'ghost' does not exist
    const touched: Array<[string, string]> = [[key, MISSING_OBSERVATION]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged — the node is still absent → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Now the node exists on disk → graph: re-observes its yaml bytes → unverified.
    writeFile('.yggdrasil/model/ghost/yg-node.yaml', 'name: ghost\n');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-children: adding a child → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph, 'svc', ['svc/c1']);
    const key = observationKey('graph-children', 'svc');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc/c1'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged child set → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Add a second child → membership changes → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
        { path: 'svc/c2', mapping: ['src/c2.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'svc', ['svc/c1', 'svc/c2']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-bytype: adding a node of that type within the allowed set → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    // svc + one child of type 'service' (descendants are in the allowed set).
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph, 'svc', ['svc/c1']);
    // Both svc and svc/c1 are type 'service' and in the allowed set of 'svc'.
    const key = observationKey('graph-bytype', 'service');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'svc/c1'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Add another descendant of type service → by-type membership grows → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
        { path: 'svc/c2', mapping: ['src/c2.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'svc', ['svc/c1', 'svc/c2']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-children of an ABSENT parent re-observes the empty set; adding that node later → unverified', async () => {
    // The recorded observation was children-of("ghost") = ∅ (ghost not in graph).
    // While ghost stays absent the empty-set re-observation matches → verified
    // (exercises the `parent ? … : []` else arm). Adding ghost WITH a child flips it.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph-children', 'ghost'); // no such node
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation([])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Absent parent → empty children set → matches the recorded ∅ → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Now 'ghost' exists with a child → children set grows → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'ghost', mapping: ['src/g.ts'], aspects: [] },
        { path: 'ghost/c', mapping: ['src/gc.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'ghost', ['ghost/c']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-flow matched by flow PATH (not name) re-observes the participant set', async () => {
    // The observation target equals the flow's PATH, not its name — exercising the
    // `f.name === target || f.path === target` second disjunct.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'other', mapping: ['src/o.ts'], aspects: [] },
      ],
      [aspect],
    );
    // name and path differ; the observation target is the PATH.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'flows/checkout', name: 'Checkout Process', nodes: ['svc', 'other'], aspects: [] },
    ];
    const key = observationKey('graph-flow', 'flows/checkout'); // matched by PATH
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'other'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
  });

  it('graph-flow of a NON-EXISTENT flow re-observes the empty set', async () => {
    // No flow matches the target → the `flow ? […] : []` else arm yields ∅. The
    // recorded value was ∅ too → verified; defining the flow later flips it.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph-flow', 'nonexistent');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation([])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // No such flow → empty participant set → matches recorded ∅ → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Define the flow with participants → set grows → unverified.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'nonexistent', name: 'nonexistent', nodes: ['svc'], aspects: [] },
    ];
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-flow: removing a participant → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'other', mapping: ['src/o.ts'], aspects: [] },
      ],
      [aspect],
    );
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'checkout', name: 'checkout', nodes: ['svc', 'other'], aspects: [] },
    ];
    const key = observationKey('graph-flow', 'checkout');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'other'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Drop a participant → participant set changes → unverified.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'checkout', name: 'checkout', nodes: ['svc'], aspects: [] },
    ];
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// Per-file independence + draft exclusion
// ---------------------------------------------------------------------------

describe('verifyLock — per-file independence and draft', () => {
  it('per-file pair validity is independent (editing file A does not invalidate file B)', async () => {
    writeFile('src/a.ts', 'a-code');
    writeFile('src/b.ts', 'b-code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', scope: { per: 'file' } };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', fileUnit('src/a.ts'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    setEntry(lock, 'asp', fileUnit('src/b.ts'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/b.ts'], verdict: 'approved' }),
    });
    writeFile('src/a.ts', 'a-code CHANGED'); // only A changes
    const result = await verifyLock(graph, lock);
    const byUnit = new Map(result.pairs.map((p) => [p.pair.unitKey, p.state.kind]));
    expect(byUnit.get(fileUnit('src/a.ts'))).toBe('unverified');
    expect(byUnit.get(fileUnit('src/b.ts'))).toBe('verified');
  });

  it('draft aspect → no expected pair', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', status: 'draft' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt-size gate (§4)
// ---------------------------------------------------------------------------

describe('verifyLock — prompt-size gate', () => {
  const SMALL_LIMIT = 50; // any real prompt scaffold exceeds this

  function gatedGraph(opts: { status?: 'enforced' | 'advisory' } = {}): { graph: Graph; aspect: TestAspect } {
    writeFile('src/a.ts', 'some source content that pads the prompt out');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'a rule with enough text to overflow the tiny limit',
      status: opts.status,
    };
    const tier: LlmConfig = { provider: 'ollama', model: 'test', temperature: 0, consensus: 1, max_prompt_chars: SMALL_LIMIT };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier });
    return { graph, aspect };
  }

  it('oversized + no entry → prompt-too-large state (no unverified duplicate)', async () => {
    const { graph } = gatedGraph();
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    if (result.pairs[0].state.kind === 'prompt-too-large') {
      expect(result.pairs[0].state.limit).toBe(SMALL_LIMIT);
      expect(result.pairs[0].state.chars).toBeGreaterThan(SMALL_LIMIT);
      expect(result.pairs[0].state.tierName).toBe('default');
    }
    expect(result.pairs[0].oversized).toBeUndefined();
  });

  it('oversized + valid entry → verdict state preserved + oversized gate surfaced', async () => {
    const { graph, aspect } = gatedGraph();
    const tier = graph.config.reviewer!.tiers.default;
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified'); // verdict preserved
    expect(result.pairs[0].oversized).toBeDefined();
    expect(result.pairs[0].oversized!.limit).toBe(SMALL_LIMIT);
  });

  // ── The recorded prompt size (VerdictEntry.promptChars) ────────────────────
  // A valid entry carrying one is answered from the lock instead of by
  // assembling the prompt; one written before the field existed is assembled
  // live, and the size it produced is handed up so --approve can record it.

  it('a valid entry with a RECORDED size is gated from that number, not from a fresh assembly', async () => {
    const { graph, aspect } = gatedGraph();
    const tier = graph.config.reviewer!.tiers.default;
    const hash = await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier });

    // Under the limit → no gate. The recorded number is deliberately a value the
    // live assembly could never produce for this pair (whose real prompt is well
    // over SMALL_LIMIT), which is what proves the stored one was used.
    const under = emptyLock();
    setEntry(under, 'asp', nodeUnit('svc'), { verdict: 'approved', hash, promptChars: SMALL_LIMIT - 1 });
    const underResult = await verifyLock(graph, under);
    expect(underResult.pairs[0].state.kind).toBe('verified');
    expect(underResult.pairs[0].oversized).toBeUndefined();
    // Nothing to write back — the number came from the lock.
    expect(underResult.pairs[0].backfillPromptChars).toBeUndefined();

    // Over the limit → gate trips, reporting the RECORDED size.
    const over = emptyLock();
    setEntry(over, 'asp', nodeUnit('svc'), { verdict: 'approved', hash, promptChars: SMALL_LIMIT + 1 });
    const overResult = await verifyLock(graph, over);
    expect(overResult.pairs[0].state.kind).toBe('verified');
    expect(overResult.pairs[0].oversized).toBeDefined();
    expect(overResult.pairs[0].oversized!.chars).toBe(SMALL_LIMIT + 1);
  });

  it('the tier limit is still read LIVE, so lowering a ceiling re-gates a verdict that is otherwise untouched', async () => {
    // max_prompt_chars is excluded from the verdict hash by design, so a tier
    // edit leaves every verdict valid. Comparing the STORED size against the
    // CURRENT limit is what keeps such an edit from silently going unenforced.
    const { graph, aspect } = gatedGraph();
    const tier = graph.config.reviewer!.tiers.default;
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier }),
      promptChars: 100,
    });

    graph.config.reviewer!.tiers.default.max_prompt_chars = 200;
    expect((await verifyLock(graph, lock)).pairs[0].oversized).toBeUndefined();

    graph.config.reviewer!.tiers.default.max_prompt_chars = 99;
    const tightened = await verifyLock(graph, lock);
    expect(tightened.pairs[0].state.kind).toBe('verified');
    expect(tightened.pairs[0].oversized).toBeDefined();
    expect(tightened.pairs[0].oversized!.limit).toBe(99);
  });

  it('a valid entry with NO recorded size is assembled live and hands the number up for recording', async () => {
    const { graph, aspect } = gatedGraph();
    const tier = graph.config.reviewer!.tiers.default;
    const lock = emptyLock();
    // No promptChars — an entry written before the field existed.
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier }),
    });
    const result = await verifyLock(graph, lock);
    // Classification is exactly what it was before the field existed.
    expect(result.pairs[0].state.kind).toBe('verified');
    expect(result.pairs[0].oversized).toBeDefined();
    // …and the live-computed size is offered for the fill to persist.
    expect(result.pairs[0].backfillPromptChars).toBe(result.pairs[0].oversized!.chars);
  });

  it('an INVALID entry offers nothing to record — a re-fill will write its own size', async () => {
    const { graph } = gatedGraph();
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), { verdict: 'approved', hash: 'stale'.repeat(13) });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    expect(result.pairs[0].backfillPromptChars).toBeUndefined();
  });

  // NOTE: this test INVERTS the prior assertion. Before v5.2.0 a tier omitting
  // max_prompt_chars skipped the gate entirely (effectively unlimited), so an
  // oversized prompt classified `unverified`. The previous test here asserted
  // exactly that ("a tier without max_prompt_chars never trips the gate"). It is
  // intentionally replaced: an omitted key now defaults to DEFAULT_MAX_PROMPT_CHARS
  // (50000), so the same oversized input now trips `prompt-too-large` at limit 50000.
  it('a tier omitting max_prompt_chars applies the 50000 default', async () => {
    writeFile('src/a.ts', 'a'.repeat(60_000)); // pad so the assembled prompt exceeds 50000
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    if (result.pairs[0].state.kind === 'prompt-too-large') {
      expect(result.pairs[0].state.limit).toBe(50_000);
      expect(result.pairs[0].state.chars).toBeGreaterThan(50_000);
    }
  });

  it('a tier omitting max_prompt_chars: an under-50000 prompt stays unverified (not tripped)', async () => {
    writeFile('src/a.ts', 'code'); // tiny subject — assembled prompt well under 50000
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('unverified'); // under the default, no gate trip
  });

  it('a tier omitting max_prompt_chars: 50000 passes, 50001 trips (> strict)', async () => {
    // Build a baseline prompt, measure it, then pad the subject so the assembled
    // length lands EXACTLY on 50000 and EXACTLY on 50001 — the gate is `chars > limit`,
    // so 50000 must pass (unverified) and 50001 must trip (prompt-too-large).
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const baseInput = {
      aspect: { id: 'asp', description: '', content: 'rule' },
      references: [],
      nodePath: 'svc',
      files: [{ path: 'src/a.ts', content: '' }],
      scope: undefined,
    };
    const baseChars = assembledPromptChars(baseInput);

    // Subject content length needed to make the assembled prompt exactly N chars.
    // The subject content is interpolated verbatim (plain ASCII, no XML escaping),
    // so each added char adds exactly one to the assembled length.
    const padTo = (n: number) => 'a'.repeat(n - baseChars);

    writeFile('src/a.ts', padTo(50_000));
    const atLimit = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const atLimitResult = await verifyLock(atLimit, emptyLock());
    expect(assembledPromptChars({ ...baseInput, files: [{ path: 'src/a.ts', content: padTo(50_000) }] })).toBe(50_000);
    expect(atLimitResult.pairs[0].state.kind).toBe('unverified'); // 50000 == limit, not > limit

    writeFile('src/a.ts', padTo(50_001));
    const overLimit = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const overLimitResult = await verifyLock(overLimit, emptyLock());
    expect(overLimitResult.pairs[0].state.kind).toBe('prompt-too-large'); // 50001 > 50000
    if (overLimitResult.pairs[0].state.kind === 'prompt-too-large') {
      expect(overLimitResult.pairs[0].state.limit).toBe(50_000);
    }
  });

  // REGRESSION (v5.2.0): for a PLAIN LLM aspect verify-lock is the ONLY size gate.
  // The §4 gate must measure the SAME prompt fill assembles — including the
  // <suppressed-ranges> block fill injects when a subject carries a yg-suppress
  // marker. Before the fix verify-lock omitted that block, so it under-measured:
  // a prompt that is UNDER the limit without the block but OVER it WITH the block
  // slipped through as `unverified` instead of `prompt-too-large`.
  it('plain LLM aspect: the injected <suppressed-ranges> block is counted by the §4 gate', async () => {
    // Subject carries a single-line yg-suppress marker for THIS aspect followed by
    // a line of code: the marker resolves to a one-line range (start = marker line + 1),
    // so fill injects a non-empty <suppressed-ranges> block. The block adds bytes
    // the gate must count.
    const subject =
      '// yg-suppress(asp) accepted debt per maintainer\n' +
      'const x = 1;\n';
    writeFile('src/a.ts', subject);

    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };

    // Baseline = the assembled prompt WITHOUT the suppressed-ranges block, computed
    // through the SAME assembler verify-lock uses (the pre-fix measurement). The
    // subject content includes the marker bytes either way; only the injected block
    // differs. Setting the limit to exactly this baseline means: under WITHOUT the
    // block, over WITH it.
    const baselineNoBlock = assembledPromptChars({
      aspect: { id: 'asp', description: '', content: 'rule' },
      references: [],
      nodePath: 'svc',
      files: [{ path: 'src/a.ts', content: subject }],
      // suppressedRanges intentionally OMITTED → no <suppressed-ranges> block (old behavior).
      scope: undefined,
    });

    // Sanity: passing the resolved ranges DOES grow the assembled prompt, so the
    // block is genuinely load-bearing for the gate (the marker is on line 1, the
    // waived code is line 2).
    const baselineWithBlock = assembledPromptChars({
      aspect: { id: 'asp', description: '', content: 'rule' },
      references: [],
      nodePath: 'svc',
      files: [{ path: 'src/a.ts', content: subject }],
      suppressedRanges: { byFile: [{ path: 'src/a.ts', ranges: [{ startLine: 2, endLine: 2 }] }] },
      scope: undefined,
    });
    expect(baselineWithBlock).toBeGreaterThan(baselineNoBlock);

    // Limit = exactly the no-block size. Pre-fix verify-lock measured `baselineNoBlock`
    // (== limit, NOT > limit) → would have classified `unverified`. Post-fix it
    // measures `baselineWithBlock` (> limit) → `prompt-too-large`.
    const tier: LlmConfig = {
      provider: 'ollama', model: 'test', temperature: 0, consensus: 1, max_prompt_chars: baselineNoBlock,
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier });

    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    if (result.pairs[0].state.kind === 'prompt-too-large') {
      expect(result.pairs[0].state.limit).toBe(baselineNoBlock);
      expect(result.pairs[0].state.chars).toBe(baselineWithBlock); // the gate counted the block
    }
  });

  // EDGE (v5.2.0): a REASONLESS suppress marker cannot be resolved into ranges —
  // resolveSuppressedRangesForPrompt throws SuppressMarkerError. The §4 gate must
  // catch it and fail closed as `unverified`, NEVER let the throw escape verifyLock.
  it('plain LLM aspect: a reasonless suppress marker classifies unverified (no throw)', async () => {
    // No reason text after the aspect id → SuppressMarkerError out of collectSuppressions.
    const subject =
      '// yg-suppress(asp)\n' +
      'const x = 1;\n';
    writeFile('src/a.ts', subject);

    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    // Any tier limit works; a small subject keeps the prompt well under the default.
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);

    const result = await verifyLock(graph, emptyLock()); // must not throw
    expect(result.pairs[0].state.kind).toBe('unverified');
  });
});

// Companion-verdict tests have been moved to verify-lock-companion.test.ts
// to keep both files under the reviewer's 50 000-char prompt limit.

// ---------------------------------------------------------------------------
// Unreadable subjects pass-through
// ---------------------------------------------------------------------------

describe('verifyLock — unreadable pass-through', () => {
  it('forwards PairComputation.unreadable', async () => {
    // No unreadable in the common case; assert the field is present and is an array.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(Array.isArray(result.unreadable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyPairs — scoped re-verification over a caller-supplied pairs slice
// ---------------------------------------------------------------------------

// `yg owner --file` / `yg context --file` each already walk the WHOLE
// project's pairs once (computeExpectedPairs) just to classify the one file
// they were asked about; re-running that same whole-project walk a second
// time just to re-verify the lock would be wasted work. verifyPairs exists
// so a caller can hand it the pairs it already has (or any subset) and get
// verifyLock's identical per-pair classification back, with no second
// computeExpectedPairs call inside it.
describe('verifyPairs — scoped re-verification (no second computeExpectedPairs walk)', () => {
  it('classifies a pre-computed, pre-filtered pairs slice identically to verifyLock over the whole graph', async () => {
    writeFile('src/a.ts', 'a-code');
    writeFile('src/b.ts', 'b-code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc-a', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc-b', mapping: ['src/b.ts'], aspects: ['det'] },
      ],
      [aspect],
    );

    const lock = emptyLock();
    // svc-a's pair has a valid, currently-verified entry; svc-b's has none at all.
    setEntry(lock, 'det', nodeUnit('svc-a'), {
      verdict: 'approved',
      hash: await detHash({ aspect, nodePath: 'svc-a', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });

    // The caller's own whole-project pair walk (mirroring yg owner --file /
    // yg context --file's own call site) — verifyPairs must never repeat it.
    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(2);

    // Scope down to JUST svc-a's own pair, the way owner/context scope down
    // to one file's own nodeless pairs, and verify that slice alone.
    const svcAPairs = pairs.filter((p) => p.nodePath === 'svc-a');
    expect(svcAPairs).toHaveLength(1);
    const scoped = await verifyPairs(graph, lock, svcAPairs);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].state.kind).toBe('verified');

    // Cross-check against verifyLock's own full-graph classification for the
    // identical pair — the two must never disagree.
    const full = await verifyLock(graph, lock);
    const fullSvcA = full.pairs.find((vp) => vp.pair.nodePath === 'svc-a')!;
    expect(scoped[0].state).toEqual(fullSvcA.state);
  });

  it('a pair with a stale entry (source edited after approval, never re-approved) classifies unverified — the missing-entry case is not the only one', async () => {
    writeFile('src/a.ts', 'original');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);

    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });

    const { pairs } = await computeExpectedPairs(graph);
    expect((await verifyPairs(graph, lock, pairs))[0].state.kind).toBe('verified');

    // Edit the file with no re-approve: the lock still holds the OLD entry —
    // present, but no longer matching the file's current bytes.
    writeFile('src/a.ts', 'edited');
    const stale = await verifyPairs(graph, lock, pairs);
    expect(stale[0].state.kind).toBe('unverified');
  });
});
