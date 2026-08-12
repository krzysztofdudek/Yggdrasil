import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AspectDef, Graph } from '../model/graph.js';
import {
  LOCK_DET_FILE_NAME,
  LOCK_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
} from '../model/lock.js';
import type { ExpectedPair } from './pairs.js';
import { collectAncestors, collectDescendants } from './graph/traversal.js';
import { touchedReferencesFile } from './graph/impact-graph.js';
import { collectAllowedReadsForAspect } from '../structure/allowed-reads.js';
import { isPathInMapping } from '../structure/expand-mapping-sync.js';
import { buildOwnerIndex } from '../relations/owner-index.js';

/**
 * Pure burn-set engine for progressive mode: given a graph, the run's expected
 * (aspect, unit) pairs, the observation lists their stored verdicts carry, and
 * the set of files a change touched, answer "which of this run's obligations is
 * the change accountable for". No I/O of any kind — no filesystem, no git, no
 * clock, no environment. Every input is supplied by the caller; every output is
 * a plain set the caller intersects with its own issues.
 *
 * The file is in two halves. The first is the structural reach helpers
 * (`impliesClosure`, `buildReverseTargetIndex`, `collectFlowParticipants`) —
 * each answers "which other graph elements does this one starting point reach".
 * The second composes them into {@link computeBurnSet}, the burn table itself.
 */

// ============================================================
// impliesClosure — unconditional structural closure over `implies`
// ============================================================

/**
 * Every aspect id reachable from `aspectId` by following `AspectDef.implies`
 * edges, INCLUDING `aspectId` itself. Terminates on a cycle (a visited set,
 * not recursion depth, bounds the walk).
 *
 * This is deliberately NOT `expandImpliesFiltered` (core/graph/aspects.ts).
 * That function is node-bound and `when`-filtered: it takes a `GraphNode` and
 * a `Graph`, evaluates each aspect's global `when` and each implier's
 * per-implies `when` against that specific node, and stops an implier with
 * `draft` effective status from propagating — because it answers "which
 * aspects apply to THIS node". `impliesClosure` answers a different, purely
 * structural question with no node in scope at all: "if this aspect's rule
 * text changed, which aspects' verdicts are implicated, everywhere, in
 * principle" — a graph-shape fact, not a per-node applicability fact. Folding
 * in `when`/status filtering here would silently make the closure depend on
 * a node that was never given to it.
 */
export function impliesClosure(aspectId: string, graph: Graph): Set<string> {
  const idToAspect = new Map(graph.aspects.map((a) => [a.id, a]));
  const visited = new Set<string>();
  const queue: string[] = [aspectId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const implied of idToAspect.get(id)?.implies ?? []) {
      if (!visited.has(implied)) queue.push(implied);
    }
  }
  return visited;
}

// ============================================================
// buildReverseTargetIndex — target nodePath -> every node relating to it
// ============================================================

/**
 * Reverse index of `meta.relations`: for every node path, the list of node
 * paths that declare ANY relation targeting it — not only port-consuming
 * relations (`consumes:`), but every plain structural relation too (`uses`,
 * `calls`, `extends`, `implements`, `emits`, `listens`). A narrower,
 * consumes-only index would miss the case where a node's TYPE changes and
 * that alone flips another node's rule attachment through a plain relation,
 * with no port involved at all.
 *
 * One pass over `graph.nodes x meta.relations`. Each source node path
 * appears at most once per target, sorted for determinism (iteration order
 * of `graph.nodes` is a Map insertion order, not a semantic guarantee here).
 */
export function buildReverseTargetIndex(graph: Graph): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const relation of node.meta.relations ?? []) {
      let sources = index.get(relation.target);
      if (!sources) {
        sources = new Set<string>();
        index.set(relation.target, sources);
      }
      sources.add(nodePath);
    }
  }
  const result = new Map<string, string[]>();
  for (const [target, sources] of index) {
    result.set(target, [...sources].sort());
  }
  return result;
}

// ============================================================
// collectFlowParticipants — declared participants + their descendants
// ============================================================

/**
 * Every node path participating in the named flow: each declared node
 * (matched by `FlowDef.name` or `FlowDef.path`, the same either-or match
 * `handleFlowImpact` uses) that still exists in the graph, plus every one of
 * its descendants. A dangling declared path (no longer a real node) is
 * silently skipped, matching the graph's general node-existence tolerance
 * elsewhere. Returns an empty set when no flow matches `flowName`.
 *
 * Lifted from the inline participant-collection block in
 * `cli/impact-handlers.ts::handleFlowImpact`, which stays exactly as it was
 * and may later delegate to this function instead of recomputing the set
 * inline — that refactor is out of scope here.
 */
export function collectFlowParticipants(graph: Graph, flowName: string): Set<string> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) return new Set();

  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    participants.add(nodePath);
    for (const desc of collectDescendants(node)) {
      participants.add(desc.path);
    }
  }
  return participants;
}

// ============================================================
// computeBurnSet — the burn table
// ============================================================

/**
 * Repo-relative POSIX layout of the committed graph, as the touched set spells
 * it. Progressive mode refuses to run at all unless the git work-tree top level
 * IS the project root (the preflight state machine's nested-graph row), so the
 * graph always sits at `<repoRoot>/.yggdrasil` and these literals are exact —
 * the same literals `touchedReferencesFile` builds its own graph-observation
 * paths from, kept in one place here rather than re-spelled per branch.
 */
const YGG_DIR = '.yggdrasil';
const MODEL_PREFIX = `${YGG_DIR}/model/`;
const ASPECTS_PREFIX = `${YGG_DIR}/aspects/`;
const FLOWS_PREFIX = `${YGG_DIR}/flows/`;
const ARCHITECTURE_FILE = `${YGG_DIR}/yg-architecture.yaml`;
const CONFIG_FILE = `${YGG_DIR}/yg-config.yaml`;
const NODE_YAML = 'yg-node.yaml';
const FLOW_YAML = 'yg-flow.yaml';
const LOG_MD = 'log.md';

/**
 * Engine OUTPUTS — a changed lock file is a record of a previous run's answer,
 * never an input to this one, so it is dropped before anything else: it burns
 * nothing AND is not counted as a changed input. Named from the lock model's
 * own constants rather than a `yg-lock.*` prefix test on purpose: an exact list
 * fails CLOSED if a future lock file is added (it burns/counts until someone
 * adds it here), whereas a prefix rule would silently swallow it.
 */
const IGNORED_OUTPUTS: ReadonlySet<string> = new Set(
  [LOCK_FILE_NAME, LOCK_NONDET_FILE_NAME, LOCK_LOGS_FILE_NAME, LOCK_DET_FILE_NAME].map(
    (name) => `${YGG_DIR}/${name}`,
  ),
);

/**
 * The identity of one expected pair inside a {@link BurnSet}: `<aspectId> <unitKey>`.
 * Exported so every consumer derives the key the same way — a caller that
 * re-spells the separator gets a set that silently never intersects.
 */
export function progressivePairKey(aspectId: string, unitKey: string): string {
  return `${aspectId} ${unitKey}`;
}

export interface BurnInput {
  /**
   * Repo-relative POSIX paths that differ from the reference (worktree ∪
   * committed halves, BOTH sides of every rename, deletions included) — exactly
   * `ChangedFiles.files` from the touched-set reader. Already normalized there;
   * this module does not re-normalize, and a caller handing it native-separator
   * or trailing-slash paths gets misses, not errors.
   */
  touched: Set<string>;
  graph: Graph;
  /** This run's expected pairs — the ONLY authority on which obligations exist. */
  pairs: ExpectedPair[];
  /**
   * Stored cross-subject observations per pair key, from the verification
   * result. The present/absent distinction is load-bearing and a caller MUST
   * honour it: a key PRESENT with an empty array means "a stored verdict exists
   * and observed nothing" (warm); a key ABSENT means "no stored verdict at all"
   * (cold — see the cold rule on {@link computeBurnSet}). Collapsing the two —
   * e.g. by omitting entries whose `touched` list is empty — turns every
   * observation-free verdict into a cold pair and burns most of the graph.
   */
  touchedListsByPairKey: Map<string, Array<[string, string]>>;
  /**
   * Whether the reviewer/coverage VOCABULARY in `yg-config.yaml` moved between
   * the merge base and head — {@link configVocabularyChanged} over the two raw
   * texts, which the caller reads with `getFileAtRef`. Only this makes a config
   * edit global; ordinary config churn burns nothing.
   */
  configVocabularyChanged: boolean;
}

export interface BurnSet {
  /**
   * The change reached something no per-pair intersection can bound (the
   * architecture, or the config vocabulary), so this run must be gated
   * globally. When true the other fields are still populated and honest, but a
   * caller must ignore them and gate everything.
   */
  global: boolean;
  /** `<aspectId> <unitKey>` for every pair this change is accountable for. */
  pairKeys: Set<string>;
  /**
   * Node paths whose NODE-KEYED issues (the log gate, description, mapping
   * diagnostics) the change is accountable for: the owner of every changed
   * file, plus a node whose own model directory changed. Deliberately NOT the
   * wider pair fan-out — a descendant, ancestor or reverse-relation node has
   * its PAIRS re-gated because its rule attachment may have moved, but nothing
   * about that node itself changed, and demanding a log entry on it would be
   * asking a person to answer for a file they never opened.
   */
  nodePaths: Set<string>;
  /**
   * Every changed path this burn accounted for: the touched set minus the
   * engine outputs of {@link IGNORED_OUTPUTS}. Keyed by a caller for per-file,
   * non-pair issues (an uncovered file, a gitignored tracked file, the
   * singleton mappings a later stage adds). A path that burned nothing at all
   * is still here — it changed, it was considered, it simply reached nothing.
   */
  files: Set<string>;
  /**
   * Node paths whose `log.md` changed. Their LOG issues are in scope; nothing
   * else about them is. This carve-out is load-bearing: a third of this repo's
   * model-touching commits touch only a log file, and the root node's log alone
   * would otherwise re-gate 407 of 417 nodes, so `yg log add` on a shallow node
   * must never burn its subtree. A node here is not implicitly in `nodePaths`;
   * a caller scoping a log issue tests BOTH sets.
   */
  logOnlyNodePaths: Set<string>;
  /**
   * How many changed paths this burn actually accounted for — `files.size`, by
   * construction. This is the number a person is shown as "N changed file(s)":
   * every path in the touched set except the engine outputs that were dropped
   * unread. It is NOT "paths that burned something" — a changed file that
   * reached no rule was still read and weighed, and hiding it would make the
   * count disagree with the diff the person is looking at.
   */
  changedInputCount: number;
}

function pushInto<T>(index: Map<string, T[]>, key: string, value: T): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
}

/**
 * The observation keys that could reference `file`, derived from the file alone
 * — the exact dual of `touchedReferencesFile`'s forward match. Over-generating
 * is safe (the matcher itself confirms every candidate before it burns
 * anything); under-generating is not, which is why every key kind the matcher
 * understands appears here. `graph-bytype:` deliberately has no candidate: the
 * set of nodes of a type is an architecture-wide fact with no single file
 * behind it, so the matcher refuses it too (accepted semantic #3 — a new node
 * of type T does not burn another node's registry pair until that node is
 * touched or a full audit runs).
 */
function observationKeyCandidates(file: string): string[] {
  const candidates = [`read:${file}`, `exists:${file}`, `list:${path.posix.dirname(file)}`];
  if (file.startsWith(MODEL_PREFIX) && file.endsWith(`/${NODE_YAML}`)) {
    const nodePath = file.slice(MODEL_PREFIX.length, file.length - NODE_YAML.length - 1);
    if (nodePath !== '') candidates.push(`graph:${nodePath}`, `graph-children:${nodePath}`);
  }
  if (file.startsWith(FLOWS_PREFIX) && file.endsWith(`/${FLOW_YAML}`)) {
    const flowName = file.slice(FLOWS_PREFIX.length, file.length - FLOW_YAML.length - 1);
    if (flowName !== '') candidates.push(`graph-flow:${flowName}`);
  }
  return candidates;
}

/**
 * The nearest node at or above `dir` (a model-relative directory path), or
 * undefined when nothing on the way up is a node. Lets a file that is not a
 * node's own `yg-node.yaml` — a note beside it, or a file in a directory whose
 * node was deleted — still land on the component that answers for it.
 */
function nearestNodePath(graph: Graph, dir: string): string | undefined {
  let candidate = dir;
  while (candidate !== '') {
    if (graph.nodes.has(candidate)) return candidate;
    const slash = candidate.lastIndexOf('/');
    if (slash < 0) return undefined;
    candidate = candidate.slice(0, slash);
  }
  return undefined;
}

/**
 * Can this pair's reach be estimated from its component's allowed-reads when it
 * has no stored verdict? Only for a reviewer that can READ ACROSS its subject
 * set: a deterministic check (whose `ctx.fs` reach is exactly allowed-reads),
 * and an LLM aspect with a companion (which records observations the same way).
 * A plain LLM pair reads nothing but its own subject files and its aspect's
 * rule text, both of which are already covered precisely by the subject and
 * aspect rows — estimating it would burn most of the graph for no added truth.
 * Mirrors `classifyInvalidations`'s own cold-start branch.
 */
function isColdEstimable(pair: ExpectedPair, aspectById: Map<string, AspectDef>): boolean {
  if (pair.kind === 'deterministic') return true;
  return aspectById.get(pair.aspectId)?.hasCompanion === true;
}

/**
 * The burn table: which of this run's obligations the change is accountable for.
 *
 * Every row below is ADDITIVE — a changed file is run through all of them, and
 * anything any row admits is burned. Rows, in the order the code applies them:
 *
 *   - **engine outputs** — a lock file is dropped before anything else: not
 *     burned, not counted, not in `files`.
 *   - **owner** — the file's owning component (resolved through the UNGUARDED
 *     owner index: pattern matching only, no filesystem, so a DELETED path
 *     still finds the node that answered for it) has its pairs burned and its
 *     node-keyed issues put in scope. This is also what makes the log gate fire
 *     on the component whose source moved.
 *   - **subject** — every pair whose current `subjectFiles` contain the file.
 *   - **aspect references** — every pair of an aspect that declares the file in
 *     its `references:` (the reviewer reads it, so its verdict depends on it).
 *   - **stored observation** — every pair whose stored verdict recorded an
 *     observation referencing the file. Candidate keys are derived from the
 *     file and confirmed by `touchedReferencesFile`, which stays the single
 *     authority on what a key means.
 *   - **`.yggdrasil/yg-architecture.yaml`** — `global`. Types, their aspect
 *     attachments and their relation allow-lists all move at once; nothing
 *     per-pair can bound that.
 *   - **`.yggdrasil/yg-config.yaml`** — `global` only when
 *     `configVocabularyChanged`. Prompt-size limits, parallelism and debug
 *     churn change no obligation.
 *   - **`.yggdrasil/aspects/<id>/**`** — every pair of `<id>` and of its
 *     `implies` closure: an implied rule attaches BECAUSE of the implier, so a
 *     change to the implier implicates it.
 *   - **`.yggdrasil/model/<p>/log.md`** — `logOnlyNodePaths` only. See
 *     {@link BurnSet.logOnlyNodePaths} for why this carve-out exists. A `log.md`
 *     whose directory is not a node falls through to the full row instead.
 *   - **`.yggdrasil/model/<p>/**` (anything else)** — the full row: pairs of
 *     `p`, of its descendants, of its ancestor chain (a `descendants:` clause
 *     looks down, so an edit must look up), and of every node declaring ANY
 *     relation targeting `p`. Reverse sources are also looked up under the
 *     LITERAL directory, so deleting a node still re-gates whoever still points
 *     at it.
 *   - **`.yggdrasil/flows/<f>/**`** — pairs of the flow's aspects (and their
 *     `implies` closure) on every participant, descendants included.
 *   - **cold pairs** — a pair with NO stored verdict is burned when any changed
 *     file falls inside its component's allowed-reads. Fail closed: a fresh
 *     clone's deterministic cache is entirely cold, and reading that as
 *     "everything is inherited" would silently disarm the gate. Computed once
 *     per component (not per pair, not per file) — see {@link isColdEstimable}
 *     for which pairs qualify.
 *
 * Complexity is O(pairs + observations + changed files), never their product:
 * every row is an inverted index built in one pass over `pairs`, then probed
 * once per changed file. The only per-component work is the cold estimate, and
 * only for components that actually have a cold pair.
 */
export function computeBurnSet(input: BurnInput): BurnSet {
  const { touched, graph, pairs, touchedListsByPairKey } = input;

  // ── Inverted indexes: ONE pass over pairs, probed per changed file ──────
  const aspectById = new Map(graph.aspects.map((a) => [a.id, a]));
  const pairKeysBySubjectFile = new Map<string, string[]>();
  const pairKeysByAspect = new Map<string, string[]>();
  const pairKeysByNode = new Map<string, string[]>();
  const pairKeysByObservation = new Map<string, string[]>();
  const aspectOfPairKey = new Map<string, string>();
  // Cold pairs grouped BY COMPONENT — the grouping is what memoizes the
  // allowed-reads computation to one call per node path.
  const coldPairKeysByNode = new Map<string, string[]>();

  for (const pair of pairs) {
    const key = progressivePairKey(pair.aspectId, pair.unitKey);
    aspectOfPairKey.set(key, pair.aspectId);
    pushInto(pairKeysByAspect, pair.aspectId, key);
    for (const subject of pair.subjectFiles) pushInto(pairKeysBySubjectFile, subject, key);
    if (pair.nodePath !== undefined) pushInto(pairKeysByNode, pair.nodePath, key);

    const observations = touchedListsByPairKey.get(key);
    if (observations === undefined) {
      // Cold. A nodeless (type-covered) pair has no component whose
      // allowed-reads apply, so there is nothing to estimate from — it is
      // reachable through the subject and aspect rows alone.
      if (pair.nodePath !== undefined && isColdEstimable(pair, aspectById)) {
        pushInto(coldPairKeysByNode, pair.nodePath, key);
      }
    } else {
      for (const [observationKey] of observations) {
        pushInto(pairKeysByObservation, observationKey, key);
      }
    }
  }

  const aspectIdsByReferencePath = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    for (const reference of aspect.references ?? []) {
      pushInto(aspectIdsByReferencePath, reference.path, aspect.id);
    }
  }

  const reverseTargets = buildReverseTargetIndex(graph);
  const { ownerOf } = buildOwnerIndex(graph.nodes);
  const closureCache = new Map<string, Set<string>>();
  const closureOf = (aspectId: string): Set<string> => {
    let closure = closureCache.get(aspectId);
    if (closure === undefined) {
      closure = impliesClosure(aspectId, graph);
      closureCache.set(aspectId, closure);
    }
    return closure;
  };

  // ── Outputs ─────────────────────────────────────────────────────────────
  let global = false;
  const pairKeys = new Set<string>();
  const nodePaths = new Set<string>();
  const files = new Set<string>();
  const logOnlyNodePaths = new Set<string>();

  const burnKeys = (keys: string[] | undefined): void => {
    for (const key of keys ?? []) pairKeys.add(key);
  };
  const burnNodePairs = (nodePath: string): void => burnKeys(pairKeysByNode.get(nodePath));

  for (const file of touched) {
    if (IGNORED_OUTPUTS.has(file)) continue;
    files.add(file);

    // Owner row — pattern-only resolution, so a deleted path still lands.
    const owner = ownerOf(file);
    if (owner !== undefined) {
      nodePaths.add(owner);
      burnNodePairs(owner);
    }

    // Subject row.
    burnKeys(pairKeysBySubjectFile.get(file));

    // Aspect-references row.
    for (const aspectId of aspectIdsByReferencePath.get(file) ?? []) {
      burnKeys(pairKeysByAspect.get(aspectId));
    }

    // Stored-observation row. The candidate keys only PROPOSE; the matcher
    // decides, so this can never admit a key it would have rejected.
    for (const candidate of observationKeyCandidates(file)) {
      const keys = pairKeysByObservation.get(candidate);
      if (keys === undefined) continue;
      if (!touchedReferencesFile([[candidate, '']], file)) continue;
      burnKeys(keys);
    }

    // Graph-structure rows.
    if (file === ARCHITECTURE_FILE) {
      global = true;
    } else if (file === CONFIG_FILE) {
      if (input.configVocabularyChanged) global = true;
    } else if (file.startsWith(ASPECTS_PREFIX)) {
      const rest = file.slice(ASPECTS_PREFIX.length);
      const slash = rest.indexOf('/');
      const aspectId = slash < 0 ? rest : rest.slice(0, slash);
      if (aspectId !== '') {
        for (const impliedId of closureOf(aspectId)) burnKeys(pairKeysByAspect.get(impliedId));
      }
    } else if (file.startsWith(MODEL_PREFIX)) {
      const rest = file.slice(MODEL_PREFIX.length);
      const slash = rest.lastIndexOf('/');
      const dir = slash < 0 ? '' : rest.slice(0, slash);
      const basename = slash < 0 ? rest : rest.slice(slash + 1);
      if (basename === LOG_MD && dir !== '' && graph.nodes.has(dir)) {
        logOnlyNodePaths.add(dir);
      } else {
        const nodePath = nearestNodePath(graph, dir);
        if (nodePath !== undefined) {
          const node = graph.nodes.get(nodePath)!;
          nodePaths.add(nodePath);
          burnNodePairs(nodePath);
          for (const descendant of collectDescendants(node)) burnNodePairs(descendant.path);
          for (const ancestor of collectAncestors(node)) burnNodePairs(ancestor.path);
          for (const source of reverseTargets.get(nodePath) ?? []) burnNodePairs(source);
        }
        // Whoever still declares a relation to the LITERAL directory — the node
        // that used to live there may have just been deleted, and the graph no
        // longer holds it to be found by the walk above.
        if (dir !== '' && dir !== nodePath) {
          for (const source of reverseTargets.get(dir) ?? []) burnNodePairs(source);
        }
      }
    } else if (file.startsWith(FLOWS_PREFIX)) {
      const rest = file.slice(FLOWS_PREFIX.length);
      const slash = rest.indexOf('/');
      const flowDir = slash < 0 ? rest : rest.slice(0, slash);
      const flow = graph.flows.find((f) => f.path === flowDir || f.name === flowDir);
      const flowAspectIds = new Set<string>();
      for (const aspectId of flow?.aspects ?? []) {
        for (const impliedId of closureOf(aspectId)) flowAspectIds.add(impliedId);
      }
      if (flowAspectIds.size > 0) {
        for (const participant of collectFlowParticipants(graph, flowDir)) {
          for (const key of pairKeysByNode.get(participant) ?? []) {
            if (flowAspectIds.has(aspectOfPairKey.get(key)!)) pairKeys.add(key);
          }
        }
      }
    }
  }

  // ── Cold row: one allowed-reads computation per component that has one ──
  if (coldPairKeysByNode.size > 0 && files.size > 0) {
    const changed = [...files];
    for (const [nodePath, keys] of coldPairKeysByNode) {
      const allowed = [...collectAllowedReadsForAspect(nodePath, graph)];
      if (allowed.length === 0) continue;
      if (changed.some((file) => isPathInMapping(file, allowed))) burnKeys(keys);
    }
  }

  return { global, pairKeys, nodePaths, files, logOnlyNodePaths, changedInputCount: files.size };
}

// ============================================================
// Config vocabulary — the only config change that goes global
// ============================================================

/**
 * The part of `yg-config.yaml` that changes what the graph MEANS, as opposed to
 * how fast or how loudly it runs: the schema `version`, the `coverage` block
 * (which files must be covered at all), and the SET of reviewer tier names
 * (which rule can name which reviewer). Everything else in the file — prompt
 * character limits, parallelism, debug, a tier's model or provider — changes
 * how a rule is executed, never which rules exist or what they apply to.
 */
export interface ConfigVocabulary {
  /** Trimmed only when it is a string, matching the config parser's own read. */
  version?: string;
  /** The raw `coverage:` block, compared structurally rather than interpreted. */
  coverage: unknown;
  /** Tier names, sorted — a SET, so declaration order is not a change. */
  tierNames: string[];
}

/**
 * Pull the vocabulary out of one raw `yg-config.yaml` text. Reads the COMMITTED
 * text only: a caller supplies the merge-base and head bytes itself, so a
 * gitignored secrets overlay can never move the vocabulary.
 *
 * Throws whatever the YAML parser throws on malformed input — a caller that
 * cannot tolerate that uses {@link configVocabularyChanged}, which treats an
 * unparseable side as changed.
 */
export function extractConfigVocabulary(rawYamlText: string): ConfigVocabulary {
  const doc: unknown = parseYaml(rawYamlText);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { coverage: undefined, tierNames: [] };
  }
  const raw = doc as Record<string, unknown>;
  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  let tierNames: string[] = [];
  const reviewer = raw.reviewer;
  if (reviewer !== null && typeof reviewer === 'object' && !Array.isArray(reviewer)) {
    const tiers = (reviewer as Record<string, unknown>).tiers;
    if (tiers !== null && typeof tiers === 'object' && !Array.isArray(tiers)) {
      tierNames = Object.keys(tiers as Record<string, unknown>).sort();
    }
  }
  return { version, coverage: raw.coverage, tierNames };
}

/** Recursively key-sorted form, so YAML key order is never mistaken for a change. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalValue(source[key]);
    return sorted;
  }
  return value === undefined ? null : value;
}

/**
 * Did the config vocabulary move between the merge-base text and the head text?
 * Pure — the caller reads both texts (`getFileAtRef` for the base) and passes
 * them in; this never touches git or disk.
 *
 * Fails CLOSED in both uncertain cases: `baseText === null` (the file did not
 * exist at the merge base, so every key in it is new) and an unparseable text
 * on either side both answer "changed", which sends the run to the global gate
 * rather than guessing that nothing moved.
 */
export function configVocabularyChanged(baseText: string | null, headText: string): boolean {
  if (baseText === null) return true;
  let base: ConfigVocabulary;
  let head: ConfigVocabulary;
  try {
    base = extractConfigVocabulary(baseText);
    head = extractConfigVocabulary(headText);
  } catch {
    return true;
  }
  const canonical = (v: ConfigVocabulary): string =>
    JSON.stringify([v.version ?? null, canonicalValue(v.coverage), v.tierNames]);
  return canonical(base) !== canonical(head);
}
