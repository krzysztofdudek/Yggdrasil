/**
 * tests/unit/helpers/seed-lock.ts — seed a `yg-lock.json` with VALID verdict
 * entries computed through the REAL pair machinery.
 *
 * This is the verdict-lock replacement for the retired `seed-baseline.ts`. It
 * exists so suites that need a "lock holding a known verdict" do not each
 * re-implement the frozen hash contract (and silently drift from it). Every hash
 * is produced by exactly the modules the engine uses:
 *
 *   - `computeExpectedPairs` (src/core/pairs.ts) resolves the subject set + tier
 *     for each (aspect, unit) pair, just as `verifyLock` / `runFill` do;
 *   - `ruleHashFor` / `tierHashViewFromTier` (src/core/pair-inputs.ts) fold the
 *     rule-source bytes and the tier identity (api_key/timeout/gates stripped);
 *   - `computeLlmInputHash` / `computeDetInputHash` (src/core/pair-hash.ts) emit
 *     the canonical inputHash that `verifyLock` recomputes and compares.
 *
 * Because the helper folds the SAME ingredients the verifier recomputes, an entry
 * seeded `approved` reads back `verified`; an entry seeded `refused` reads back
 * `refused` (with its stored reason); and any input change after seeding (subject
 * edit, content.md edit, tier change, touched-observation change) degrades the
 * pair to `unverified` — which is exactly the property under test in
 * verify-lock.test.ts and check-lock.test.ts.
 *
 * ── API ──────────────────────────────────────────────────────────────────────
 *
 *   seedLock(graph, spec): Promise<LockFile>
 *       Build an in-memory LockFile. Does NOT touch disk.
 *
 *   writeSeededLock(graph, spec): Promise<LockFile>
 *       seedLock(...) then `writeLock` it to <graph.rootPath>/yg-lock.json.
 *
 *   spec.verdicts: array of VerdictSpec — one per (aspectId, unitKey) you want an
 *       entry for. The pair MUST exist in `computeExpectedPairs(graph, {includeDraft})`
 *       (otherwise the helper throws — a seed for a non-existent pair is always a
 *       test bug). Fields:
 *         aspectId   — the aspect's id
 *         unitKey    — nodeUnit(path) (per-node) or fileUnit(path) (per-file)
 *         verdict    — 'approved' | 'refused' (default 'approved')
 *         reason     — stored on refused entries (rendered by `yg check`)
 *         touched    — det only: pre-computed [observationKey, observationHash] pairs
 *                      folded verbatim (caller controls the values)
 *         observe    — det only: observation KEYS the helper re-observes against
 *                      current disk (read:/list:/exists:/graph:) and folds. Use this
 *                      when you want a valid det entry whose `touched` reflects real
 *                      on-disk state (so a later edit invalidates it). `touched` and
 *                      `observe` may both be supplied; they are merged + sorted by key.
 *
 *   spec.nodes: optional per-node facts written into lock.nodes[path]:
 *         source: true    — compute + store the real source fingerprint
 *         log: true       — compute + store the real append-only log baseline
 *       (Absent or false ⇒ that field is omitted. A node entry with neither field
 *       set is omitted entirely.)
 *
 *   spec.includeDraft: passed through to computeExpectedPairs (default false). Set
 *       true when seeding an entry for an aspect that is currently draft (e.g. a GC
 *       round-trip test).
 */

import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import type { Graph, ScopeDef, LlmConfig } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry, UnitKey, Verdict } from '../../../src/model/lock.js';
import { LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { writeLock } from '../../../src/io/lock-store.js';
import { hashBytes } from '../../../src/io/hash.js';
import {
  computeExpectedPairs,
  computeSourceFingerprint,
  type ExpectedPair,
} from '../../../src/core/pairs.js';
import {
  computeLlmInputHash,
  computeDetInputHash,
  tierHashView,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
} from '../../../src/core/pair-hash.js';
import { ruleHashFor, tierHashViewFromTier } from '../../../src/core/pair-inputs.js';
import { selectTierForAspect } from '../../../src/core/tier-selection.js';
import { computeLogBaselineFromContent, readLogContent } from '../../../src/core/log/log-gate.js';

// ── Public spec types ─────────────────────────────────────────────────────────

export interface VerdictSpec {
  aspectId: string;
  unitKey: UnitKey;
  verdict?: Verdict; // default 'approved'
  reason?: string;
  /** det only: folded verbatim. */
  touched?: Array<[string, string]>;
  /** det only: observation keys re-observed against current disk and folded. */
  observe?: string[];
  /**
   * det only: the canonical-form contract to hash under — `null` for the form
   * an earlier release wrote (no contract marker). Absent: the current one.
   */
  contract?: number | null;
}

export interface NodeFactsSpec {
  /** Compute + store the real source fingerprint. */
  source?: boolean;
  /** Compute + store the real append-only log baseline. */
  log?: boolean;
}

export interface SeedLockSpec {
  verdicts?: VerdictSpec[];
  nodes?: Record<string, NodeFactsSpec>;
  includeDraft?: boolean;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Build an in-memory LockFile with valid hashes for the requested verdicts +
 * node facts. Reads subject/reference/observed bytes from disk relative to the
 * project root (the parent of graph.rootPath).
 */
export async function seedLock(graph: Graph, spec: SeedLockSpec = {}): Promise<LockFile> {
  const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
  const projectRoot = path.dirname(graph.rootPath);

  const { pairs } = await computeExpectedPairs(graph, { includeDraft: spec.includeDraft ?? false });
  const pairByKey = new Map<string, ExpectedPair>();
  for (const p of pairs) pairByKey.set(`${p.aspectId}\0${p.unitKey}`, p);

  for (const v of spec.verdicts ?? []) {
    const pair = pairByKey.get(`${v.aspectId}\0${v.unitKey}`);
    if (!pair) {
      throw new Error(
        `seedLock: no expected pair for aspect '${v.aspectId}' unit '${v.unitKey}'. ` +
          `Pairs available: ${[...pairByKey.keys()].map((k) => k.replace('\0', ' / ')).join(', ') || '(none)'}. ` +
          `Did you forget includeDraft, or is the aspect not effective on that node?`,
      );
    }
    const verdict: Verdict = v.verdict ?? 'approved';
    const entry = await buildEntry(graph, projectRoot, pair, verdict, v);
    (lock.verdicts[v.aspectId] ??= {})[v.unitKey] = entry;
  }

  for (const [nodePath, facts] of Object.entries(spec.nodes ?? {})) {
    const nodeEntry: LockFile['nodes'][string] = {};
    if (facts.source) {
      const fp = await computeSourceFingerprint(graph, nodePath);
      if (fp !== undefined) nodeEntry.source = fp;
    }
    if (facts.log) {
      const baseline = computeLogBaselineFromContent(await readLogContent(projectRoot, nodePath));
      if (baseline !== undefined) nodeEntry.log = baseline;
    }
    if (nodeEntry.source !== undefined || nodeEntry.log !== undefined) {
      lock.nodes[nodePath] = nodeEntry;
    }
  }

  return lock;
}

/** seedLock(...) then persist to the lock triad under <graph.rootPath> via the real store. */
export async function writeSeededLock(graph: Graph, spec: SeedLockSpec = {}): Promise<LockFile> {
  const lock = await seedLock(graph, spec);
  const deterministicAspectIds = new Set(
    graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
  );
  await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds });
  return lock;
}

// ── Entry assembly (mirrors verify-lock.ts / fill.ts ingredients) ─────────────

async function buildEntry(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  verdict: Verdict,
  v: VerdictSpec,
): Promise<VerdictEntry> {
  const aspect = graph.aspects.find((a) => a.id === pair.aspectId);
  if (!aspect) throw new Error(`seedLock: aspect '${pair.aspectId}' not in graph`);

  const files = await hashSubjectFiles(projectRoot, pair.subjectFiles);

  if (pair.kind === 'llm') {
    const ruleHash = ruleHashFor(aspect, 'content.md');
    const references = await hashReferences(projectRoot, aspect.references ?? []);
    const reviewer = graph.config.reviewer;
    if (!reviewer) throw new Error(`seedLock: no reviewer config for LLM aspect '${aspect.id}'`);
    const tierResult = selectTierForAspect(aspect, reviewer);
    if (!tierResult.ok) {
      throw new Error(`seedLock: tier resolution failed for '${aspect.id}': ${tierResult.error.what}`);
    }
    const hash = computeLlmInputHash({
      aspectId: aspect.id,
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: pair.nodePath,
      ruleHash,
      files,
      references,
      tier: tierHashViewFromTier(tierResult.tierName),
      verdict,
    });
    return makeEntry(verdict, hash, v.reason);
  }

  // deterministic
  const ruleHash = ruleHashFor(aspect, 'check.mjs');
  const touched = await resolveTouched(projectRoot, v);
  const hash = computeDetInputHash({
    aspectId: aspect.id,
    scope: aspect.scope,
    nodePath: pair.nodePath,
    ruleHash,
    files,
    touched,
    verdict,
    ...(v.contract !== undefined ? { contract: v.contract } : {}),
  });
  const entry = makeEntry(verdict, hash, v.reason);
  if (touched.length > 0) entry.touched = touched;
  return entry;
}

function makeEntry(verdict: Verdict, hash: string, reason?: string): VerdictEntry {
  const entry: VerdictEntry = { verdict, hash };
  if (verdict === 'refused' && reason !== undefined) entry.reason = reason;
  return entry;
}

async function hashSubjectFiles(
  projectRoot: string,
  subjectFiles: string[],
): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const rel of subjectFiles) {
    out.push([rel, await hashFileOrEmpty(projectRoot, rel)]);
  }
  // computeLlmInputHash / computeDetInputHash sort internally; sort here too so
  // the seeded order is irrelevant.
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function hashReferences(
  projectRoot: string,
  references: Array<{ path: string; description?: string }>,
): Promise<Array<[string, string, string]>> {
  const out: Array<[string, string, string]> = [];
  for (const ref of references) {
    out.push([ref.path, await hashFileOrEmpty(projectRoot, ref.path), ref.description ?? '']);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Merge pre-computed `touched` with re-observed `observe` keys; sort by key. */
async function resolveTouched(projectRoot: string, v: VerdictSpec): Promise<Array<[string, string]>> {
  const map = new Map<string, string>();
  for (const [key, h] of v.touched ?? []) map.set(key, h);
  for (const key of v.observe ?? []) map.set(key, await observeFromDisk(projectRoot, key));
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Re-observe a single observation key against current disk, producing the hash
 * `verifyLock`'s internal reObserve would produce for the same key. Uses the
 * public observation primitives so the seed stays byte-compatible with the
 * verifier without re-exporting its private function.
 */
async function observeFromDisk(projectRoot: string, key: string): Promise<string> {
  const sep = key.indexOf(':');
  const kind = key.slice(0, sep);
  const target = key.slice(sep + 1);
  switch (kind) {
    case 'read': {
      const bytes = await readBytesOrNull(path.resolve(projectRoot, target));
      return bytes === null ? hashReadObservation(Buffer.alloc(0)) : hashReadObservation(bytes);
    }
    case 'graph': {
      // graph:<nodePath> folds the node's yg-node.yaml bytes.
      const abs = path.join(projectRoot, '.yggdrasil', 'model', target, 'yg-node.yaml');
      const bytes = await readBytesOrNull(abs);
      return bytes === null ? hashReadObservation(Buffer.alloc(0)) : hashReadObservation(bytes);
    }
    case 'list': {
      const abs = path.resolve(projectRoot, target);
      try {
        const dirents = await readdir(abs, { withFileTypes: true });
        const entries = dirents.map((d) => ({
          name: d.name,
          kind: d.isDirectory() ? ('dir' as const) : ('file' as const),
        }));
        return hashListObservation(entries);
      } catch {
        return hashListObservation([]);
      }
    }
    case 'exists': {
      const abs = path.resolve(projectRoot, target);
      try {
        const s = await stat(abs);
        return hashExistsObservation(s.isDirectory() ? 'dir' : 'file');
      } catch {
        return hashExistsObservation(false);
      }
    }
    default:
      throw new Error(`seedLock: unknown observation kind in key '${key}'`);
  }
}

async function hashFileOrEmpty(projectRoot: string, rel: string): Promise<string> {
  const bytes = await readBytesOrNull(path.resolve(projectRoot, rel));
  return hashBytes(bytes ?? Buffer.alloc(0));
}

async function readBytesOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

// ── Ingredient-level hash helpers ─────────────────────────────────────────────
//
// These compute a single VALID inputHash from explicit ingredients, reading
// subject/reference bytes from disk relative to `projectRoot`. They exist for
// suites (verify-lock.test.ts, check-lock.test.ts) that build hand-rolled
// in-memory graphs and seed entries directly, then mutate state and re-verify.
// Using these keeps the frozen-contract fold in ONE place instead of each suite
// re-deriving the tier strip + reference fold + canonicalization.

export interface SeedLlmHashIngredients {
  aspectId: string;
  aspectDescription?: string;
  scope?: ScopeDef;
  nodePath: string;
  /** content.md bytes (the rule source). */
  ruleContent: string;
  /** subject files, repo-relative POSIX; bytes read from disk. */
  subjectFiles: string[];
  references?: Array<{ path: string; description?: string }>;
  /** the resolved tier config; tier NAME defaults to 'default'. */
  tier: LlmConfig;
  tierName?: string;
  verdict: Verdict;
}

/** Compute a valid LLM inputHash from explicit ingredients (disk-read subjects/refs). */
export async function computeSeedLlmHash(
  projectRoot: string,
  ing: SeedLlmHashIngredients,
): Promise<string> {
  const files = await hashSubjectFiles(projectRoot, ing.subjectFiles);
  const references = await hashReferences(projectRoot, ing.references ?? []);
  // tier config no longer folds into the hash — only the tier name does.
  return computeLlmInputHash({
    aspectId: ing.aspectId,
    aspectDescription: ing.aspectDescription ?? '',
    scope: ing.scope,
    nodePath: ing.nodePath,
    ruleHash: hashBytes(Buffer.from(ing.ruleContent, 'utf8')),
    files,
    references,
    tier: tierHashView(ing.tierName ?? 'default'),
    verdict: ing.verdict,
  });
}

export interface SeedDetHashIngredients {
  aspectId: string;
  scope?: ScopeDef;
  nodePath: string;
  /** check.mjs bytes (the rule source). */
  ruleContent: string;
  subjectFiles: string[];
  /** sorted [observationKey, observationHash] pairs (caller-provided). */
  touched?: Array<[string, string]>;
  verdict: Verdict;
}

/** Compute a valid deterministic inputHash from explicit ingredients. */
export async function computeSeedDetHash(
  projectRoot: string,
  ing: SeedDetHashIngredients,
): Promise<string> {
  const files = await hashSubjectFiles(projectRoot, ing.subjectFiles);
  return computeDetInputHash({
    aspectId: ing.aspectId,
    scope: ing.scope,
    nodePath: ing.nodePath,
    ruleHash: hashBytes(Buffer.from(ing.ruleContent, 'utf8')),
    files,
    touched: (ing.touched ?? []).slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    verdict: ing.verdict,
  });
}

/** Re-observe a single observation key against disk (read:/list:/exists:/graph:). */
export async function reObserveForSeed(projectRoot: string, key: string): Promise<string> {
  return observeFromDisk(projectRoot, key);
}
