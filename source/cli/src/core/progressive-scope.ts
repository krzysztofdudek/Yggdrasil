import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { AspectDef, Graph } from '../model/graph.js';
import {
  LOCK_DET_FILE_NAME,
  LOCK_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
} from '../model/lock.js';
import { COMMITTED_EVENTS_FILENAME, EVENTS_FILENAME } from '../io/events-store.js';
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
 * The file is in three parts. The first is the structural reach helpers
 * (`impliesClosure`, `buildReverseTargetIndex`, `collectFlowParticipants`) —
 * each answers "which other graph elements does this one starting point reach".
 * The second composes them into {@link computeBurnSet}, the burn table itself.
 * The third is the BYTE GUARD ({@link forceInScopeOnByteMismatch}), which
 * re-admits an obligation the table let out on git's word when the file's own
 * bytes say git was wrong.
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
/**
 * Exported because a code→fixed-input map elsewhere (`SINGLETON_INPUTS`,
 * core/check-codes.ts) has to intersect the SAME touched set this table reads,
 * and a second, hand-spelled copy of either path silently never matches: the
 * touched set spells them repo-relative, WITH this directory in front. That is
 * not hypothetical — both were once written bare and could never have matched
 * anything. One spelling, imported, is the only way that stays true.
 */
export const ARCHITECTURE_FILE = `${YGG_DIR}/yg-architecture.yaml`;
export const CONFIG_FILE = `${YGG_DIR}/yg-config.yaml`;
const NODE_YAML = 'yg-node.yaml';
const FLOW_YAML = 'yg-flow.yaml';
const LOG_MD = 'log.md';

/**
 * Engine OUTPUTS — a changed lock file, or an appended verdict-event line, is a
 * record of a previous run's answer, never an input to this one, so each is
 * dropped before anything else: it burns nothing AND is not counted as a
 * changed input. Named from the lock and events modules' own constants rather
 * than a `yg-lock.*` prefix test on purpose: an exact list fails CLOSED if a
 * future output file is added (it burns and counts until someone adds it here),
 * whereas a prefix rule would silently swallow it.
 *
 * Dropping the committed LLM lock here has one consequence worth naming: it is
 * the only record proving a verdict ever existed, and a change can DELETE
 * entries from it (a bad merge resolution, `--ours`, or deliberately). That
 * deletion cannot be seen through this file, so it is caught on the other side
 * instead — see {@link BurnInput.baseVerdictPairKeys}.
 */
const IGNORED_OUTPUTS: ReadonlySet<string> = new Set(
  [
    LOCK_FILE_NAME,
    LOCK_NONDET_FILE_NAME,
    LOCK_LOGS_FILE_NAME,
    LOCK_DET_FILE_NAME,
    COMMITTED_EVENTS_FILENAME,
    EVENTS_FILENAME,
  ].map((name) => `${YGG_DIR}/${name}`),
);

/**
 * The identity of one expected pair inside a {@link BurnSet}: `<aspectId> <unitKey>`.
 * Exported so every consumer derives the key the same way — a caller that
 * re-spells the separator gets a set that silently never intersects.
 *
 * KNOWN LIMIT, recorded rather than fixed: the join is a single space, so two
 * different (aspect, unit) pairs whose ids themselves contain spaces could in
 * principle produce the same key. No aspect id and no unit key in practice
 * contains one — aspect ids are slug-like and a unit key is `node:<path>` or
 * `file:<repo-relative POSIX path>` — so this is a latent ambiguity, not a live
 * defect. If ids ever gain spaces, change the separator HERE and every consumer
 * follows, which is the whole reason this function exists.
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
   * Pair keys that HELD a stored verdict in the committed lock as of the
   * reference, supplied by the caller from the merge-base copy of that file.
   *
   * This exists because the committed lock is the only record proving a verdict
   * ever existed, AND it is a file a change can edit. A change that deletes
   * entries from it — a bad merge resolution, `--ours`, or deliberately — makes
   * those pairs verdict-less; without this input they would look exactly like
   * pairs that were simply never verified, render as pre-existing debt, and let
   * the change that destroyed them pass. Every pair whose key is here and has no
   * stored entry now is burned unconditionally, whatever its reviewer kind.
   *
   * A caller that cannot read the lock at the reference must fall back to the
   * GLOBAL gate. Passing an empty set means "the reference genuinely held no
   * verdicts", which disables this row.
   */
  baseVerdictPairKeys: Set<string>;
  /**
   * Whether the reviewer/coverage VOCABULARY in `yg-config.yaml` moved between
   * the merge base and head — {@link configVocabularyChanged} over the two raw
   * texts, which the caller reads with `getFileAtRef`. Only this makes a config
   * edit global; ordinary config churn burns nothing.
   */
  configVocabularyChanged: boolean;
}

/**
 * Which of the two changes made a run global. Recorded rather than re-derived
 * because a run gated this way owes the person a sentence naming the cause, and
 * a caller working that out for itself — by re-testing the changed-file set
 * against the same two paths — would be a second copy of the decision, free to
 * disagree with the one that actually gated the run.
 *
 * `architecture` outranks `configuration` when a change moved both, on the same
 * most-upstream-CAUSE rule the preflight table's fallback rows follow: the
 * explanation should name the thing whose reach is widest, not one of the two
 * arbitrarily.
 */
export type GlobalCause = 'architecture' | 'configuration';

export interface BurnSet {
  /**
   * The change reached something no per-pair intersection can bound (the
   * architecture, or the config vocabulary), so this run must be gated
   * globally. When true the other fields are still populated and honest, but a
   * caller must ignore them and gate everything.
   */
  global: boolean;
  /** Why {@link global} is true — set exactly when it is, absent otherwise. */
  globalCause?: GlobalCause;
  /** `<aspectId> <unitKey>` for every pair this change is accountable for. */
  pairKeys: Set<string>;
  /**
   * Node paths whose NODE-KEYED issues (the log gate, description, mapping and
   * relation diagnostics) the change is accountable for: the owner of every
   * changed file, plus EVERY node the model row reaches — the node whose own
   * directory changed, its descendants, its ancestor chain, and every node
   * declaring a relation to it (including to the literal directory, so a
   * deleted node still re-gates whoever points at it).
   *
   * That last part is load-bearing and was once absent. This set must contain
   * every node whose PAIRS the model row burns, because a node-keyed finding is
   * the only evidence some of those reaches produce at all: editing one node's
   * declaration can make ANOTHER node's existing import become an undeclared
   * cross-node edge, and that finding (`relation-undeclared-dependency`) carries
   * only the second node's path. Burning that node's pairs while leaving it out
   * of this set let a violation the change actually caused be re-coded as
   * inherited debt. The same shape reaches `type-strict-misplaced` when one
   * node's mapping release makes another the owner.
   *
   * The `log.md` carve-out is NOT affected: a change to a node's log file takes
   * the {@link logOnlyNodePaths} branch instead and never enters this set, so
   * `yg log add` on a shallow node still burns nothing but that node's log.
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
    if (nodePath !== '') {
      candidates.push(`graph:${nodePath}`, `graph-children:${nodePath}`);
      // The PARENT's children membership too: this file appearing or
      // disappearing is what moves it, and the unit that observed
      // children(parent) is very often some other node entirely — one that
      // holds a relation to the parent, not the parent itself.
      const slash = nodePath.lastIndexOf('/');
      if (slash > 0) candidates.push(`graph-children:${nodePath.slice(0, slash)}`);
    }
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
 *
 * Leaving a plain LLM pair out is only safe because "cold" has a second cause
 * this predicate says nothing about: its verdict may have been DELETED by the
 * very change being judged. That case is not estimated at all — it is known,
 * from {@link BurnInput.baseVerdictPairKeys}, and burned unconditionally before
 * this predicate is ever consulted.
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
 *   - **`.yggdrasil/model/<p>/**` (anything else)** — the full row: `p`, its
 *     descendants, its ancestor chain (a `descendants:` clause looks down, so an
 *     edit must look up), and every node declaring ANY relation targeting `p`.
 *     Reverse sources are also looked up under the LITERAL directory, so
 *     deleting a node still re-gates whoever still points at it. Each of those
 *     nodes is burned WHOLE — pairs and node-keyed issues alike (`burnNode`),
 *     never pairs alone: see {@link BurnSet.nodePaths} for the violation that
 *     shipped green while this row burned only half of each node it reached.
 *   - **`.yggdrasil/flows/<f>/**`** — pairs of the flow's aspects (and their
 *     `implies` closure) on every participant, descendants included. Pairs
 *     ONLY, unlike the model row above: what moved is which rules attach
 *     through the flow, not anything about a participant itself, so a
 *     participant's own node-keyed findings stay outside the change.
 *   - **removed verdicts** — a pair that HELD a stored verdict at the reference
 *     and holds none now is burned outright, whatever its reviewer kind. The
 *     change deleted it; nothing else in the table can see that, because the
 *     file carrying the proof is an engine output this table ignores.
 *   - **cold pairs** — a pair with NO stored verdict is burned when any changed
 *     file falls inside its component's allowed-reads. Fail closed: a fresh
 *     clone's deterministic cache is entirely cold, and reading that as
 *     "everything is inherited" would silently disarm the gate. Computed once
 *     per component (not per pair, not per file) — see {@link isColdEstimable}
 *     for which pairs qualify.
 *
 * Complexity: every row above is an inverted index built in ONE pass over
 * `pairs` and probed a fixed number of times per changed file —
 * O(pairs + observations + changed), never their product. The cold row is the
 * one exception and is stated honestly rather than folded into that claim: an
 * allowed-reads set is per-component with no cheap inversion, so each component
 * that has a cold pair tests changed paths until one matches (early exit on the
 * first hit), giving O(components-with-cold-pairs x changed) in the worst case.
 * It does not run at all for a component whose pairs are all warm, and the
 * allowed-reads set itself is resolved once per component — never per pair and
 * never per changed file, which is the part that would actually hurt.
 */
export function computeBurnSet(input: BurnInput): BurnSet {
  const { touched, graph, pairs, touchedListsByPairKey, baseVerdictPairKeys } = input;

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
  const removedVerdictPairKeys: string[] = [];

  for (const pair of pairs) {
    const key = progressivePairKey(pair.aspectId, pair.unitKey);
    aspectOfPairKey.set(key, pair.aspectId);
    pushInto(pairKeysByAspect, pair.aspectId, key);
    for (const subject of pair.subjectFiles) pushInto(pairKeysBySubjectFile, subject, key);
    if (pair.nodePath !== undefined) pushInto(pairKeysByNode, pair.nodePath, key);

    const observations = touchedListsByPairKey.get(key);
    if (observations === undefined) {
      // Its verdict was there at the reference and is not here now — the change
      // destroyed it. Unconditional, before any estimate: this is a fact, not a
      // guess about what the pair might have read.
      if (baseVerdictPairKeys.has(key)) removedVerdictPairKeys.push(key);
      // Cold. A nodeless (type-covered) pair has no component whose
      // allowed-reads apply, so there is nothing to estimate from — it is
      // reachable through the subject and aspect rows alone.
      else if (pair.nodePath !== undefined && isColdEstimable(pair, aspectById)) {
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
  // Tracked as two flags rather than one, so the cause reported below is decided
  // by which change was seen — never by which one the touched set happened to
  // list first.
  let architectureMoved = false;
  let vocabularyMoved = false;
  const pairKeys = new Set<string>();
  const nodePaths = new Set<string>();
  const files = new Set<string>();
  const logOnlyNodePaths = new Set<string>();

  const burnKeys = (keys: string[] | undefined): void => {
    for (const key of keys ?? []) pairKeys.add(key);
  };
  /**
   * Burn one node: its pairs AND its node-keyed issues. The two travel together
   * on purpose — see {@link BurnSet.nodePaths}. A reach that burned only the
   * pairs would silently exempt every finding whose ONLY identity is that node's
   * path, which is how a change that caused a violation elsewhere could ship it
   * as inherited debt.
   */
  const burnNode = (nodePath: string): void => {
    nodePaths.add(nodePath);
    burnKeys(pairKeysByNode.get(nodePath));
  };

  // Removed-verdict row. Independent of the touched set: the deletion shows in
  // the lock, and the lock is an output this table never reads as an input.
  burnKeys(removedVerdictPairKeys);

  for (const file of touched) {
    if (IGNORED_OUTPUTS.has(file)) continue;
    files.add(file);

    // Owner row — pattern-only resolution, so a deleted path still lands.
    const owner = ownerOf(file);
    if (owner !== undefined) burnNode(owner);

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
      architectureMoved = true;
    } else if (file === CONFIG_FILE) {
      if (input.configVocabularyChanged) vocabularyMoved = true;
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
          burnNode(nodePath);
          for (const descendant of collectDescendants(node)) burnNode(descendant.path);
          for (const ancestor of collectAncestors(node)) burnNode(ancestor.path);
          for (const source of reverseTargets.get(nodePath) ?? []) burnNode(source);
        }
        // Whoever still declares a relation to the LITERAL directory — the node
        // that used to live there may have just been deleted, and the graph no
        // longer holds it to be found by the walk above.
        if (dir !== '' && dir !== nodePath) {
          for (const source of reverseTargets.get(dir) ?? []) burnNode(source);
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

  const globalCause: GlobalCause | undefined = architectureMoved
    ? 'architecture'
    : vocabularyMoved
      ? 'configuration'
      : undefined;
  return {
    global: globalCause !== undefined,
    globalCause,
    pairKeys,
    nodePaths,
    files,
    logOnlyNodePaths,
    changedInputCount: files.size,
  };
}

// ============================================================
// The byte guard — when git's answer is provably wrong
// ============================================================

/**
 * The digests git uses to name objects, by the hex width of the id each
 * produces. A repository is created in ONE object format and every id in its
 * trees is that format's — `sha1` for every repository git has ever created by
 * default, `sha256` for one initialised with `--object-format=sha256`.
 *
 * Keyed by width because that is the only thing a listing tells us: a tree
 * records ids, not the algorithm that made them. Hard-wiring one of these was a
 * real defect and a silent one — on a sha256 repository every recorded id is 64
 * hex characters, so every comparison against a 40-character digest fails,
 * every inherited finding is forced back in scope, and the mode is inert with
 * nothing said about it.
 */
const GIT_OBJECT_DIGESTS: ReadonlyMap<number, string> = new Map([
  [40, 'sha1'],
  [64, 'sha256'],
]);

/**
 * Which digest produced the ids in this listing, or `null` when this build
 * cannot reproduce them and the guard must therefore not run at all.
 *
 * Read off ONE entry, because a repository's object format is a property of the
 * repository and not of a file: every id in one listing is the same width by
 * construction, so scanning the rest would cost a pass to re-learn a fact the
 * first entry already settled.
 *
 * An EMPTY listing answers `sha1` and it does not matter which it answers: a
 * listing with no entries records no id for any subject, so every subject takes
 * the "absent from the reference" branch and nothing is ever hashed.
 */
export function gitObjectDigest(blobOidByPath: ReadonlyMap<string, string>): string | null {
  for (const oid of blobOidByPath.values()) return GIT_OBJECT_DIGESTS.get(oid.length) ?? null;
  return 'sha1';
}

/**
 * The git object id of a blob holding exactly `bytes`: `digest` over the literal
 * header `blob <byteLength>\0` followed by the RAW bytes — git's own
 * loose-object form, which is what a tree listing records.
 *
 * Three details are load-bearing, and getting any of them wrong makes EVERY file
 * mismatch rather than failing loudly:
 *
 *   - the length in the header is the BYTE length, not a character count, and
 *     the header is written as its own ASCII chunk so no encoding step can
 *     widen it;
 *   - the content is hashed as raw bytes, never as decoded text. Deterministic
 *     rules keep binary files among their subjects, and a `toString()` anywhere
 *     on this path replaces every byte an encoder cannot represent, so every
 *     binary subject would mismatch forever and the guard would be permanently,
 *     uselessly noisy. There is no `.toString()` here on purpose;
 *   - the digest is the one the REPOSITORY uses, resolved from the recorded ids
 *     by {@link gitObjectDigest}, not a constant. See that function for what
 *     assuming one costs.
 *
 * This is a hash used as an OBJECT NAME, not as a security primitive: the value
 * is compared against ids git itself wrote, so the algorithm is fixed by the
 * repository's format and is not a choice this code gets to make.
 */
export function hashGitBlob(bytes: Buffer, digest = 'sha1'): string {
  return createHash(digest).update(`blob ${bytes.length}\0`, 'latin1').update(bytes).digest('hex');
}

/** One file a candidate finding's verdict is about, with the bytes on disk now. */
export interface ByteGuardSubject {
  /** Repo-relative POSIX path, spelled exactly as a tree listing spells it. */
  path: string;
  /**
   * The file's RAW current bytes, or `null` when they could not be read at all.
   * `null` is NOT "empty": it means the comparison cannot be made, which the
   * guard resolves the blocking way (see {@link forceInScopeOnByteMismatch}).
   */
  bytes: Buffer | null;
  /**
   * The component that answers for this file, when one does — resolved by the
   * gatherer from the graph's own path patterns, so the decision itself needs no
   * graph. Re-admitting a file puts its owner back in scope too, which is
   * exactly what the burn table's own owner row would have done had git reported
   * the file at all.
   */
  owner?: string;
}

/**
 * One finding the classification is about to set aside, and the files its
 * verdict is about.
 *
 * `pairKey` is present only for a finding whose identity IS a rule check. The
 * rest — a finding keyed by component, by file, or by the dependency edges it
 * names — carry none, and are re-admitted through the file and component sets
 * instead. Deriving candidates from rule checks ALONE was a real hole: a hidden
 * edit that introduced an undeclared cross-component dependency produced a
 * finding carrying only a component path, no rule check moved at all, and the
 * whole class went on being reported as inherited debt.
 */
export interface ByteGuardCandidate {
  /** `<aspectId> <unitKey>` — {@link progressivePairKey} — or absent when the finding names no rule check. */
  pairKey?: string;
  subjects: ByteGuardSubject[];
}

/** Everything the decision needs about this run beyond the candidates themselves. */
export interface ByteGuardEvidence {
  candidates: readonly ByteGuardCandidate[];
  /**
   * Every rule check each component owns — the same index the burn table builds
   * to burn a component WHOLE when one of its files changes. Re-admitting a
   * component without it re-admits its node-keyed findings while leaving its
   * rule checks released, which is a narrower answer than the honest table gives
   * for the identical file.
   */
  pairKeysByNode: ReadonlyMap<string, readonly string[]>;
}

/**
 * Re-admit every candidate finding whose files disagree with the reference tree
 * — the guard against git being TOLD to lie.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * The burn table decides what a change is accountable for by asking git which
 * files differ from the reference. Git can be instructed to answer that question
 * wrongly: a path marked `assume-unchanged` or `skip-worktree` is reported as
 * unmodified no matter what its bytes actually say, so `git status` and
 * `git diff` both omit it. Every finding about that file then falls outside the
 * change, its live refusal is re-coded as inherited debt, and the build goes
 * green over an edit the gate never saw.
 *
 * So for candidates only, this asks the bytes instead of asking git. A file's
 * git object id is a function of its content alone; recomputing it in-process
 * from the bytes already in hand and comparing against the id the reference tree
 * recorded is a complete answer that no index flag can influence.
 *
 * ── What it widens, and why all three sets ──────────────────────────────────
 * A re-admitted file is put back into the scope in the SAME three places the
 * burn table would have put it had git reported it:
 *
 *   - `files` — which is what the per-file rung, the dependency-edge rung and
 *     the coverage split all read;
 *   - `nodePaths` — the file's owning component, which is what every
 *     component-keyed finding reads (the undeclared-dependency finding, the log
 *     gate, a missing description);
 *   - `pairKeys` — the candidate's own rule check, when it has one.
 *
 * Widening only `pairKeys` was the defect this shape replaces: it re-admitted
 * rule checks and nothing else, so an entire class of finding — everything
 * identified by a component or a file rather than by a rule — stayed released
 * on git's false report.
 *
 * `changedInputCount` follows `files` by construction, exactly as it does in
 * {@link computeBurnSet}: a file the guard re-admits IS a changed input the
 * measurement failed to count, and leaving the number behind would have the
 * header claim fewer inputs than the run just gated on.
 *
 * ── What it may and may not do ──────────────────────────────────────────────
 * ADD, never remove. Every returned set is a SUPERSET of the input's and
 * `global` is untouched — and with nothing forced, the input object itself comes
 * back, so a run where the guard finds nothing is indistinguishable from one
 * where it never ran. Every rung of the classification ladder is monotone in
 * these sets, so a superset can only ever keep a finding blocking that would
 * otherwise have been released. That direction is the whole safety argument: a
 * wrong "force" costs someone reading a finding that was not theirs, while a
 * wrong "release" ships a real violation green.
 *
 * ── When it declines to answer ──────────────────────────────────────────────
 *   - `blobOidByPath === null` — the listing could not be obtained. The guard is
 *     SKIPPED entirely rather than treated as an empty listing (which would
 *     force every candidate in scope, inventing a second failure mode where the
 *     measurement already fails closed elsewhere). NOTE the one way that
 *     listing can come back `null` for a reason unrelated to git health: it is
 *     read through a bounded output buffer, and a repository whose tree listing
 *     exceeds it fails the read and disarms the guard silently. That is
 *     fail-open, and it is recorded here rather than defended against.
 *   - the recorded ids are in an object format this build cannot reproduce —
 *     also skipped, and the caller is told so it can SAY so rather than let the
 *     mode go quietly inert.
 *   - `burn.global` — the run already gates everything; there is nothing to add.
 *
 * ── Which way a comparison that cannot be made falls ────────────────────────
 * Toward blocking, in both shapes:
 *   - a subject whose bytes could not be read (`bytes === null`) is forced. It
 *     cannot be compared, and an obligation that cannot be shown untouched is
 *     not shown untouched;
 *   - a subject with NO entry in the reference listing is forced. The file did
 *     not exist at the reference, yet git reported the change as never having
 *     touched it — the two cannot both be true, and the honest reading is that
 *     the enumeration is the part that is wrong. (This also catches the variant
 *     where a file is added and hidden in the same breath: staged, then marked
 *     assume-unchanged, so it appears in no status and in no committed diff.)
 *
 * ── The false positive this has, stated at its real scope ───────────────────
 * ANY content filter between the stored blob and the working copy makes the two
 * legitimately differ, and then every failing finding on every filtered file is
 * re-admitted — on every run, on every platform. A committed `.gitattributes`
 * carrying `text eol=` or a `filter=` driver does it, which means continuous
 * integration meets it as readily as a developer's machine; large-file storage
 * is the same class, since the blob holds a pointer and the working copy holds
 * the content. This is NOT confined to Windows or to `core.autocrlf`. The effect
 * is not "a few findings stay blocking": on such a repository every inherited
 * obligation blocks on every run. So the caller is told how many findings this
 * kept, and reports it — a mode that has effectively turned itself off must say
 * so in its own output rather than only in its documentation. The direction is
 * still the safe one (more gated, never less), and it is the price of comparing
 * bytes rather than a normalised decoding of them, which would break every
 * binary subject to fix a text-only case.
 *
 * Pure: the ids and the bytes both arrive as plain values. No git, no
 * filesystem, no clock — the caller gathers, this decides.
 *
 * @param scope     the burn table's answer, plus the reference listing to check
 *                  it against (`null` ⇒ skip)
 * @param evidence  the findings eligible for re-admission and the component ->
 *                  rule-check index re-admitting a component reads. The caller
 *                  supplies ONLY findings that are both blocking and about to be
 *                  set aside, since a passing finding has nothing to keep and an
 *                  in-scope one already blocks
 */
export function forceInScopeOnByteMismatch(
  scope: { burn: BurnSet; blobOidByPath: ReadonlyMap<string, string> | null },
  evidence: ByteGuardEvidence,
): BurnSet {
  const { burn, blobOidByPath } = scope;
  if (blobOidByPath === null || burn.global) return burn;
  const digest = gitObjectDigest(blobOidByPath);
  if (digest === null) return burn;

  const forcedPairKeys: string[] = [];
  const forcedFiles: string[] = [];
  const forcedNodes: string[] = [];
  for (const candidate of evidence.candidates) {
    let moved = false;
    for (const subject of candidate.subjects) {
      if (!subjectMoved(subject, blobOidByPath, digest)) continue;
      moved = true;
      forcedFiles.push(subject.path);
      if (subject.owner === undefined) continue;
      // Re-admit the component WHOLE — its node-keyed findings AND every rule
      // check it owns — which is exactly what the burn table's own owner row
      // does for a file git DID report (`burnNode`). Re-admitting only the
      // candidate's own rule check made this guard's answer strictly narrower
      // than the burn table's for the same file, and the two halves that read it
      // then disagreed: the report gathers a component-keyed finding over the
      // component's whole file set, while the stage that BUYS reviews gathers
      // per rule check. A hidden edit to a neighbouring file in the same
      // component therefore blocked in the report and was declined by the very
      // command the report advised — the same unfixable shape, one layer down.
      forcedNodes.push(subject.owner);
      for (const key of evidence.pairKeysByNode.get(subject.owner) ?? []) forcedPairKeys.push(key);
    }
    // Only the files that actually moved are re-admitted, never a candidate's
    // whole subject list: `files` means "changed paths this run accounted for",
    // and adding one that did not change would make the count in front of a
    // person a claim about their diff that is not true.
    if (moved && candidate.pairKey !== undefined) forcedPairKeys.push(candidate.pairKey);
  }
  if (forcedFiles.length === 0) return burn;

  const files = new Set([...burn.files, ...forcedFiles]);
  return {
    global: burn.global,
    globalCause: burn.globalCause,
    pairKeys: new Set([...burn.pairKeys, ...forcedPairKeys]),
    nodePaths: new Set([...burn.nodePaths, ...forcedNodes]),
    files,
    logOnlyNodePaths: burn.logOnlyNodePaths,
    changedInputCount: files.size,
  };
}

/**
 * How many of `candidates` the guard re-admitted, read off the two burn sets it
 * produced rather than by comparing anything a second time.
 *
 * A candidate is forced exactly when one of its subjects moved, and every moved
 * subject's path is added to `files` — so the paths `after` gained over `before`
 * ARE the moved ones, and a candidate owning any of them is one this run was
 * about to release and did not. No candidate can own a moved path that was
 * already in `before.files`: a candidate is out of scope by construction, and a
 * path git DID report puts every finding about it back in scope through one rung
 * or another (its rule check through the subject row, its component through the
 * owner row, itself through the file and edge rungs).
 *
 * Derived this way rather than by tracking which finding OBJECTS survived
 * classification, because one of them never does: the aggregate coverage finding
 * is SPLIT into two freshly-built halves rather than handed back, so a run whose
 * only re-admission was an uncovered file counted nothing and printed no
 * explanation at all — the one case with no self-diagnosis, which is precisely
 * what the explanation exists for.
 */
export function keptByByteGuard(
  before: BurnSet,
  after: BurnSet,
  candidates: readonly ByteGuardCandidate[],
): number {
  if (after === before) return 0;
  return candidates.filter((c) =>
    c.subjects.some((s) => after.files.has(s.path) && !before.files.has(s.path)),
  ).length;
}

/** Does this one subject's content disagree with what the reference recorded? */
function subjectMoved(
  subject: ByteGuardSubject,
  blobOidByPath: ReadonlyMap<string, string>,
  digest: string,
): boolean {
  if (subject.bytes === null) return true;
  const recorded = blobOidByPath.get(subject.path);
  if (recorded === undefined) return true;
  return hashGitBlob(subject.bytes, digest) !== recorded;
}

// ============================================================
// Config vocabulary — the only config change that goes global
// ============================================================

/**
 * The part of `yg-config.yaml` that changes what the graph MEANS, or that could
 * narrow the gate itself, as opposed to how fast or how loudly a run goes: the
 * schema `version`; the `coverage` block (which files must be covered at all);
 * the SET of reviewer tier names and the RESOLVED default among them (which
 * reviewer a rule is judged under — a stored-verdict ingredient); and the whole
 * `progressive:` block (which reference the scope is measured against).
 * Everything else in the file — prompt character limits, parallelism, debug, a
 * tier's model or provider — changes how a rule is executed, never which rules
 * exist, what they apply to, or how much of the run is gated.
 */
export interface ConfigVocabulary {
  /** Trimmed only when it is a string, matching the config parser's own read. */
  version?: string;
  /** The raw `coverage:` block, compared structurally rather than interpreted. */
  coverage: unknown;
  /** Tier names, sorted — a SET, so declaration order is not a change. */
  tierNames: string[];
  /**
   * The RESOLVED default tier: `reviewer.default` when it names one, otherwise
   * the sole tier when exactly one exists — the same resolution the tier
   * selector performs. This is a verdict-hash ingredient, not a preference: an
   * aspect that declares no tier of its own is reviewed under this name, and
   * the name is folded into every one of its pairs' stored hashes. Repointing
   * it between two EXISTING tiers leaves the tier-name set untouched while
   * recomputing every such pair's hash — every affected pair goes unverified,
   * previously-refused ones included. Without this field that one line would
   * change nothing in the burn set and a whole repository's live refusals would
   * quietly re-render as pre-existing debt.
   */
  defaultTier?: string;
  /**
   * The raw `progressive:` block. ANY change to it goes global — a
   * self-punishing enable. The block names the reference the whole scope is
   * measured against, so a change that repoints it (to `HEAD`, or to the
   * branch's own base) can make the touched set legitimately empty and the run
   * quietly green while gating nothing at all. A gate must never be able to
   * narrow itself unnoticed, so re-pointing it costs one full run.
   */
  progressive: unknown;
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
    return { coverage: undefined, tierNames: [], progressive: undefined };
  }
  const raw = doc as Record<string, unknown>;
  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  let tierNames: string[] = [];
  let declaredDefault: string | undefined;
  const reviewer = raw.reviewer;
  if (reviewer !== null && typeof reviewer === 'object' && !Array.isArray(reviewer)) {
    const reviewerMap = reviewer as Record<string, unknown>;
    const tiers = reviewerMap.tiers;
    if (tiers !== null && typeof tiers === 'object' && !Array.isArray(tiers)) {
      tierNames = Object.keys(tiers as Record<string, unknown>).sort();
    }
    if (typeof reviewerMap.default === 'string') declaredDefault = reviewerMap.default;
  }
  // Same resolution the tier selector performs: the declared default, else the
  // sole tier when there is exactly one, else none.
  const defaultTier =
    declaredDefault ?? (tierNames.length === 1 ? tierNames[0] : undefined);

  return { version, coverage: raw.coverage, tierNames, defaultTier, progressive: raw.progressive };
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
    JSON.stringify([
      v.version ?? null,
      canonicalValue(v.coverage),
      v.tierNames,
      v.defaultTier ?? null,
      canonicalValue(v.progressive),
    ]);
  return canonical(base) !== canonical(head);
}
