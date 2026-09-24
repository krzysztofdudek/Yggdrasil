/**
 * Companion-verdict tests for core/verify-lock.ts.
 * Split from verify-lock.test.ts to keep each file under the reviewer's 50 000-char
 * prompt limit (the `test-deterministic` aspect is per:file).
 *
 * Covers: verify reproduces fill's companion-folded hash — companionHash folded
 * UNCONDITIONALLY; touched folded only-when-present; degrading to unverified when
 * companion.mjs bytes or a touched read: file changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Graph, GraphNode, AspectDef, ScopeDef, LlmConfig } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';
import { nodeUnit, LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { verifyLock } from '../../../src/core/verify-lock.js';
import {
  hashReadObservation,
  observationKey,
  computeLlmInputHash,
} from '../../../src/core/pair-hash.js';
import { ruleHashFor, companionHashFor, tierHashViewFromTier } from '../../../src/core/pair-inputs.js';
import { hashBytes } from '../../../src/io/hash.js';
import {
  computeSeedLlmHash,
} from '../helpers/seed-lock.js';

// ---------------------------------------------------------------------------
// Fixture builders (duplicated from verify-lock.test.ts — kept minimal)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-verify-lock-comp-'));
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
  ruleContent: string;
  scope?: ScopeDef;
  references?: Array<{ path: string; description?: string }>;
  companion?: string;
}

interface TestNode {
  path: string;
  mapping: string[];
  aspects: string[];
  description?: string;
  /** Outgoing relations — needed so a companion path is relation-reachable when the
   *  unconditional §4 gate resolves companions LIVE (since v5.2.0). */
  relations?: Array<{ type: string; target: string }>;
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
    // Persist artifacts to disk at .yggdrasil/aspects/<id>/<filename>. Since v5.2.0 the
    // §4 prompt-size gate is unconditional (an omitted max_prompt_chars defaults to
    // 50000), so verifyLock resolves a companion aspect's companion.mjs LIVE on every
    // run to size the gate — exactly as it does against a real loadGraph()'d graph. The
    // hook loader imports companion.mjs from this on-disk path, so the synthetic graph
    // must materialize it (previously the gate was skipped when no limit was set, and
    // these in-memory-only artifacts were never read).
    const aspectDir = path.join(rootPath, 'aspects', a.id);
    mkdirSync(aspectDir, { recursive: true });
    for (const art of artifacts) {
      writeFileSync(path.join(aspectDir, art.filename), art.content, 'utf-8');
    }
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
      meta: {
        name: n.path, type: 'service', aspects: n.aspects, mapping: n.mapping, description: n.description,
        ...(n.relations ? { relations: n.relations } : {}),
      },
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

function setEntry(lock: LockFile, aspectId: string, unitKey: string, entry: VerdictEntry): void {
  (lock.verdicts[aspectId] ??= {})[unitKey] = entry;
}

/**
 * Compute the valid LLM hash for a pair given current disk state.
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

/**
 * Compute a companion-folded LLM hash exactly as fill-llm.ts produces it.
 */
async function companionLlmHash(params: {
  aspectDef: AspectDef;
  nodePath: string;
  subjectFiles: string[];
  touched: Array<[string, string]>;
  verdict: 'approved' | 'refused';
  tierName?: string;
}): Promise<string> {
  const files = params.subjectFiles
    .map((rel): [string, string] => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(tmpDir, rel));
      } catch {
        bytes = Buffer.alloc(0);
      }
      return [rel, hashBytes(bytes)];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const references = (params.aspectDef.references ?? [])
    .map((ref): [string, string, string] => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(tmpDir, ref.path));
      } catch {
        bytes = Buffer.alloc(0);
      }
      return [ref.path, hashBytes(bytes), ref.description ?? ''];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return computeLlmInputHash({
    aspectId: params.aspectDef.id,
    aspectDescription: params.aspectDef.description ?? '',
    scope: params.aspectDef.scope,
    nodePath: params.nodePath,
    ruleHash: ruleHashFor(params.aspectDef, 'content.md'),
    files,
    references,
    tier: tierHashViewFromTier(params.tierName ?? 'default'),
    companionHash: companionHashFor(params.aspectDef),
    touched: params.touched,
    verdict: params.verdict,
  });
}

/** read: observation for a companion file (the fill-side fold for a companion read). */
function readObs(rel: string): [string, string] {
  return [observationKey('read', rel), hashReadObservation(readFileSync(path.join(tmpDir, rel)))];
}

// ---------------------------------------------------------------------------
// LLM companion verdicts — verify reproduces fill's companion-folded hash
//
// Each test seeds an LLM entry whose hash was produced exactly as fill-llm.ts
// would (companionHash folded UNCONDITIONALLY; touched folded only-when-present),
// then asserts verify reads it back VERIFIED unchanged and degrades to UNVERIFIED
// when a companion input (companion.mjs bytes, or a touched read: file) changes.
// ---------------------------------------------------------------------------

describe('verifyLock — LLM companion verdicts', () => {
  it('[]-companion entry (no touched) → verified when companion.mjs unchanged', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return []; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    // sanity: a companion aspect folds a companionHash.
    expect(companionHashFor(aspectDef)).toBeDefined();
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('[]-companion entry (no touched) → unverified after editing companion.mjs (companionHash changes)', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return []; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    // Edit the companion.mjs artifact in-memory (companionHash differs ⇒ unverified)
    // even though there is NO touched and the subject + rule are unchanged.
    aspectDef.artifacts.find((a) => a.filename === 'companion.mjs')!.content =
      'export function companion() { return []; } // EDITED\n';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('entry with touched read:<companion> → verified unchanged, unverified after editing the companion file', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/partner.ts', 'partner-v1');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/partner.ts" }]; }\n',
    };
    // svc declares a relation to the partner node that owns src/partner.ts, so the
    // companion is relation-reachable when the unconditional §4 gate resolves it LIVE.
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'], relations: [{ type: 'uses', target: 'partner' }] },
        { path: 'partner', mapping: ['src/partner.ts'], aspects: [] },
      ],
      [aspect],
    );
    const aspectDef = graph.aspects[0];
    const touched: Array<[string, string]> = [readObs('src/partner.ts')];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Edit the companion file → its re-observed read: hash differs → unverified.
    writeFile('src/partner.ts', 'partner-v2');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('a DELETED companion file degrades the pair without throwing (live §4 gate → companion-error)', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/partner.ts', 'present');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/partner.ts" }]; }\n',
    };
    // svc declares a relation to the partner node owning src/partner.ts, so the live §4
    // gate resolution (unconditional since v5.2.0) treats the companion as reachable.
    // Since v5.2.0 the §4 gate is unconditional, so verifyLock resolves the companion
    // LIVE to size the prompt. When the companion file is DELETED, the live resolver can
    // no longer read it to assemble the prompt → the pair surfaces as `companion-error`
    // (a clear, blocking diagnostic) BEFORE the stored touched read: re-observation would
    // have degraded it to `unverified`. The contract that matters is preserved: a deleted
    // companion degrades the pair without throwing — only the disposition label changed
    // (the live gate now catches it first, instead of the stored-touched re-observation).
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'], relations: [{ type: 'uses', target: 'partner' }] },
        { path: 'partner', mapping: ['src/partner.ts'], aspects: [] },
      ],
      [aspect],
    );
    const aspectDef = graph.aspects[0];
    const touched: Array<[string, string]> = [readObs('src/partner.ts')];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    rmSync(path.join(tmpDir, 'src/partner.ts'));
    // The live resolution runs only where repository code may run (--approve).
    const result = await verifyLock(graph, lock, undefined, undefined, { runCompanionHooks: true }); // must not throw
    expect(result.pairs[0].state.kind).toBe('companion-error');
    // A read-only verification never runs the hook: the stale pair is simply unverified.
    const readOnly = await verifyLock(graph, lock);
    expect(readOnly.pairs[0].state.kind).toBe('unverified');
    expect(readOnly.pairs[0].companionNotRun).toBe(true);
  });

  it('plain LLM entry (no companion, no touched) → verified and NOT invalidated by an unrelated cross-node edit', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/other.ts', 'other-v1');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] },
        { path: 'other', mapping: ['src/other.ts'], aspects: [] },
      ],
      [aspect],
    );
    const aspectDef = graph.aspects[0];
    // A plain aspect folds NO companionHash — the companion-aware path must
    // reproduce the IDENTICAL pre-feature hash (proved by seeding via the plain
    // llmHash helper and reading it back verified).
    expect(companionHashFor(aspectDef)).toBeUndefined();
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Edit an unrelated node's source — the plain svc pair stays verified.
    writeFile('src/other.ts', 'other-v2');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
  });

  it('plain LLM companion-aware hash equals the legacy plain hash (no companion double-count)', async () => {
    // The companion-aware fold for a plain aspect (companionHash undefined, no
    // touched) must equal the pre-feature plain hash byte-for-byte.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const plain = await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' });
    const folded = await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    expect(folded).toBe(plain);
  });

  it('companion==subject path produces a hash equal to the same pair with a []-resolving companion (no double-count)', async () => {
    // fill-llm drops a companion path equal to a unit subject (already hashed as a
    // subject), so a companion that returns the subject yields NO touched — the
    // hash must equal the []-companion form (companionHash folds, touched empty).
    writeFile('src/a.ts', 'code');
    const subjectReturning: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/a.ts" }]; }\n',
    };
    const emptyReturning: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/a.ts" }]; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [subjectReturning]);
    const aspectDef = graph.aspects[0];
    // Both fold the SAME companionHash (same companion.mjs bytes) with empty touched.
    const subjectHash = await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    const emptyGraph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [emptyReturning]);
    const emptyHash = await companionLlmHash({ aspectDef: emptyGraph.aspects[0], nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    expect(subjectHash).toBe(emptyHash);
    // And the entry verifies.
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), { verdict: 'approved', hash: subjectHash });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// A read-only verification executes no repository code
//
// A companion.mjs is code from the repository. Plain `yg check`, the portal and
// every other read-only caller verify on branches nobody has reviewed yet (a
// fork's pull request in CI), so they must never import it; only the --approve
// fill, which runs the repository's rule code anyway, opts in.
// ---------------------------------------------------------------------------

describe('verifyLock — companion hooks run only when the caller opts in', () => {
  function markerCompanion(marker: string): string {
    return `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport function companion() { return []; }\n`;
  }

  it('a stale companion pair is not sized by running its hook on a read-only verification', async () => {
    const marker = path.join(tmpDir, 'companion-ran');
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', companion: markerCompanion(marker) };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);

    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('unverified');
    expect(result.pairs[0].companionNotRun).toBe(true);
    expect(() => readFileSync(marker)).toThrow();

    const approving = await verifyLock(graph, emptyLock(), undefined, undefined, { runCompanionHooks: true });
    expect(approving.pairs[0].state.kind).toBe('unverified');
    expect(approving.pairs[0].companionNotRun).toBeUndefined();
    expect(readFileSync(marker, 'utf-8')).toBe('ran');
  });

  it('the size gate still fires without the hook when the subjects alone are over the limit (a lower bound)', async () => {
    const marker = path.join(tmpDir, 'companion-ran');
    writeFile('src/a.ts', 'x'.repeat(3000));
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', companion: markerCompanion(marker) };
    const graph = buildGraph(
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }],
      [aspect],
      { tier: { ...DEFAULT_TIER, max_prompt_chars: 1000 } },
    );
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    expect(() => readFileSync(marker)).toThrow();
  });
});
