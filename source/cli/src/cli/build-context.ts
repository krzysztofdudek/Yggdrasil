import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { collectAncestors, buildNodeContextData, buildFileContextData } from '../core/context-builder.js';
import { formatNodeContext } from '../formatters/context-node.js';
import { formatFileContext, formatFileContextBrief, formatFileContextAspect, effectiveAspects } from '../formatters/context-file.js';
import type { FileContextData, FileContextAspect, FileBriefExtras } from '../formatters/context-file.js';
import { validate } from '../core/validator.js';
import { findOwnerWithinOwnGraph } from './owner.js';
import { normalizeMappingPaths, projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { hashString } from '../io/hash.js';
import { computeNodeMappedFiles } from '../core/pairs.js';
import { readTextFile } from '../io/graph-fs.js';
import { readFeatureFieldEntry } from '../core/feature-index-read.js';
import { FAMILY_SEP } from '../core/feature-field-schema.js';
import { getLanguageDisplayName } from '../utils/language-registry.js';
import { walkRepoFiles, resolveGraphExclusionSet, isExcludedFromGraph, isCoverageExcludedPath, NO_COVERAGE_EXCLUDED, describeExclusionSource, describeExclusionCause } from '../io/repo-scanner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { computeExpectedPairs, computeSourceFingerprint, FileUnreadableError } from '../core/pairs.js';
import type { TypeCoverageInput, ExpectedPair, UnreadableSubject } from '../core/pairs.js';
import { resolveChangeScope } from './progressive-scope-resolve.js';
import { pairIsInScope } from '../core/check-progressive.js';
import { progressivePairKey } from '../core/progressive-scope.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached, classifySingleFileCached } from '../core/type-coverage.js';
import { computeTypeAspectCascade, describeCascadeCycle } from '../core/type-effective.js';
import { buildTypeVisibility, describeTypeVisibilityReason, describeChainTermination, toAppliedPairs } from '../core/type-visibility.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { readLock } from '../io/lock-store.js';
import { verifyPairs } from '../core/verify-lock.js';
import { readLogContent, hasFreshLogEntry } from '../core/log/log-gate.js';
import type { NodeContextData, NodeAspectSubjects, NodeLogState } from '../formatters/context-node.js';
import type { Graph } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
import { runProjectRelationPass } from '../relations/pass.js';
import type { TypedEdgeIndex } from '../relations/pass.js';

type CandidateNode = { nodePath: string; fileCount: number };

function findCandidateNodes(graph: Graph, unmappedFile: string): CandidateNode[] {
  // Normalize first so the directory derived here compares like-for-like against
  // the toPosixPath-normalized mapping dirs below (raw OS separators would never
  // match on Windows).
  const normalized = toPosixPath(unmappedFile);
  const dir = normalized.replace(/\/[^/]+$/, '');
  if (!dir || dir === normalized) return [];

  const candidates = new Map<string, number>();

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    let count = 0;
    for (const mp of mappingPaths) {
      const mpNorm = toPosixPath(mp);
      const mpDir = mpNorm.replace(/\/[^/]+$/, '');
      if (mpDir === dir) {
        count++;
      }
    }
    if (count > 0) {
      candidates.set(nodePath, count);
    }
  }

  return Array.from(candidates.entries())
    .map(([nodePath, fileCount]) => ({ nodePath, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function collectRelevantNodePaths(graph: Graph, nodePath: string): Set<string> {
  const relevant = new Set<string>();
  const node = graph.nodes.get(nodePath);
  if (!node) return relevant;

  relevant.add(nodePath);

  // Ancestors (hierarchy)
  for (const ancestor of collectAncestors(node)) {
    relevant.add(ancestor.path);
  }

  // Direct relation targets + their ancestors
  for (const rel of node.meta.relations ?? []) {
    relevant.add(rel.target);
    const target = graph.nodes.get(rel.target);
    if (target) {
      for (const ancestor of collectAncestors(target)) {
        relevant.add(ancestor.path);
      }
    }
  }

  return relevant;
}

/**
 * The type-level classification lattice (coverage.type_level), classified for
 * this one `yg context` invocation. Undefined when the flag is off.
 */
async function computeTypeCoverageForContext(graph: Graph, repoFiles?: string[]): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const projectRoot = projectRootFromGraph(graph.rootPath);
  const files = repoFiles ?? await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, files);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/**
 * The live type-relation gate's edge index (coverage.type_level's import-edge
 * check), computed ONCE for one `yg context --file` invocation on a file
 * enforced by its type alone — never per file, never per aspect. Seeds the
 * relation pass with the SAME whole-repo type classification
 * `computeTypeCoverageForContext` already produces, so an import reaching ANY
 * type-covered file — not only the one being previewed — resolves to its real
 * type, exactly as `yg check` resolves it. Without this, a `relations:` atom
 * on the previewed file's attached rules would read the conservative
 * always-false a caller with no edge index falls back to, even on the same
 * file `yg check` answers differently for.
 *
 * Returns that seed classification alongside the edge index rather than
 * discarding it after seeding the pass: it is the SAME whole-repo
 * classification the arm preview and `assembleScopeMarking` would otherwise
 * pay to compute again, and the caller threads it into both instead.
 */
async function computeRelationEdgesForContext(graph: Graph, projectRoot: string, repoFiles?: string[]): Promise<{ edges: TypedEdgeIndex; typeCoverage: TypeCoverageInput | undefined }> {
  const typeCoverage = await computeTypeCoverageForContext(graph, repoFiles);
  const relResult = await runProjectRelationPass(graph, projectRoot, typeCoverage?.covered);
  return { edges: relResult.typedEdges, typeCoverage };
}

/** The read-path (deterministic/aggregate/llm) home for one aspect's rule source, same convention buildNodeContextData/buildFileContextData already use. */
function ruleSourcePathFor(aspectId: string, reviewerType: 'llm' | 'deterministic' | 'aggregate'): string {
  return reviewerType === 'deterministic'
    ? `.yggdrasil/aspects/${aspectId}/check.mjs`
    : reviewerType === 'aggregate'
      ? `.yggdrasil/aspects/${aspectId}/yg-aspect.yaml`
      : `.yggdrasil/aspects/${aspectId}/content.md`;
}

/**
 * Assemble `yg context --file`'s typed view for a file enforced by its
 * architecture type alone (no owning component) — the surface that replaces
 * "not covered by any node" for such a file.
 *
 * Classifies and enumerates pairs/drops scoped to THIS ONE FILE (a
 * single-entry `covered` map), never the whole-repo classification map —
 * `yg context --file` answers about one file, so it must not pay for
 * classifying every uncovered file in the repo to do it just to decide which
 * rules apply. `edges` is a SEPARATE, wider computation the caller already ran
 * once for this invocation (`computeRelationEdgesForContext`, which does
 * classify the whole repo — the only way to recognize an import into some
 * OTHER type-covered file) — threading it in here costs nothing more; a
 * `relations:` atom on this file's attached rules is answered from it, the
 * same real, statically-resolved imports `yg check` enforces against, exactly
 * the contract DERIVED_RELATIONS_NOTE states on the rendered page itself.
 */
async function buildTypeCoveredFileContextData(graph: Graph, file: string, typeId: string, edges: TypedEdgeIndex): Promise<FileContextData> {
  const covered = new Map([[file, typeId]]);
  const typeCoverageInput = { covered, ambiguousPaths: [], edges };
  const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage: typeCoverageInput });
  // toAppliedPairs narrows to nodeless pairs — `pairs` also carries every REAL
  // node's own pairs (the ordinary per-node loop still runs over the whole
  // project), which must never leak into this one file's applied-rules list.
  const report = buildTypeVisibility(graph, covered, drops, [], toAppliedPairs(pairs));
  // covered has exactly one (file, typeId) entry, so buildTypeVisibility always
  // produces exactly one byType block, keyed by that same typeId.
  const block = report.byType.find((b) => b.typeId === typeId)!;

  const aspectById = new Map(graph.aspects.map((a) => [a.id, a] as const));
  const toFileAspect = (aspectId: string, status: 'enforced' | 'advisory'): FileContextAspect => {
    const def = aspectById.get(aspectId);
    return {
      aspectId,
      aspectDescription: def?.description ?? def?.name ?? aspectId,
      verifiedAgainst: ruleSourcePathFor(aspectId, def?.reviewer.type ?? 'deterministic'),
      status,
    };
  };

  // Real status, never hardcoded: an advisory rule is listed as advisory, not
  // silently folded under the same [enforced] tag a blocking rule gets.
  const applied = [
    ...block.enforced.map((id) => toFileAspect(id, 'enforced')),
    ...block.advisory.map((id) => toFileAspect(id, 'advisory')),
  ].sort((a, b) => (a.aspectId < b.aspectId ? -1 : a.aspectId > b.aspectId ? 1 : 0));

  // [enforced]/[advisory] names architecture-level status, never a recorded
  // verdict — mark which of `applied`'s pairs the lock does NOT currently
  // hold a valid verdict for. Runs the exact same per-pair verification `yg
  // check` performs (core/verify-lock.ts#verifyPairs, scoped to this file's
  // own nodeless pairs — already computed above as `pairs`, never a second
  // whole-project pass), so a stale entry (this file edited since the
  // verdict was recorded) is marked unverified here exactly as it would be
  // in `yg check`'s own qualified count, not only a pair the lock has never
  // seen at all. A garbled lock is `yg check`'s own error to report; this
  // view still renders without the caveat rather than failing an unrelated
  // file-context lookup.
  try {
    const nodelessPairs = pairs.filter((p) => p.nodePath === undefined);
    const verified = await verifyPairs(graph, readLock(graph.rootPath), nodelessPairs, typeCoverageInput);
    const unverifiedByAspect = new Map(
      verified.map((vp) => [vp.pair.aspectId, vp.state.kind !== 'verified' && vp.state.kind !== 'refused']),
    );
    for (const a of applied) a.unverified = unverifiedByAspect.get(a.aspectId) ?? true;
  } catch (e: unknown) {
    debugWrite(`[context] lock read failed while building the unverified caveat: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    filePath: toPosixPath(file),
    aspects: [],
    dependencies: [],
    dependentCount: 0,
    typeCoverage: {
      typeId,
      chainTerminationText: describeChainTermination(block.chainTermination),
      applied,
      dropped: block.dropped.map((d) => ({ aspectId: d.aspectId, reasonText: describeTypeVisibilityReason(d.reason) })),
    },
  };
}

/**
 * Populate the node-view's read-only lock observability fields (spec §8):
 *   - aspectSubjects: per-aspect subject-file count (or unit count for per:file),
 *     so the reader sees vacuous (0-file) aspects and per-file fan-out at a glance.
 *   - logState: whether a log entry is required before --approve (the type opts
 *     into log_required AND the source fingerprint differs from the lock's stored
 *     one) and whether a fresh entry is already present.
 *
 * Pure read: no LLM calls, no writes. A garbled lock surfaces as LockInvalidError
 * (fail closed) — the caller's generic handler renders it.
 */
/**
 * Derive read-only log-gate state (spec §9) for a log-required node — the
 * fingerprint-vs-lock comparison and freshness check, no side effects.
 * Shared by attachLockObservability (node view, below) and composeBriefExtras
 * (file view's compact line, below) so the two views' log-gate line can never
 * disagree — the promise yg-node.yaml states for this command.
 *
 * Callers are expected to have already checked the node's type opts into
 * log_required; this does not re-check it, because each caller's "not
 * required" outward behavior differs and belongs at the call site (see both).
 *
 * Returns undefined when the source fingerprint cannot be read (an
 * unreadable mapped file) — gate state cannot be honestly computed in that
 * case; a caller decides for itself what to do about it. Reads the lock only
 * when actually needed, so a caller that turns out not to need it (fingerprint
 * unreadable) never pays the risk of a garbled lock's LockInvalidError.
 */
async function deriveLogGateState(
  graph: Graph,
  nodePath: string,
): Promise<NodeLogState | undefined> {
  let currentFingerprint: string | undefined;
  try {
    currentFingerprint = await computeSourceFingerprint(graph, nodePath);
  } catch (e) {
    if (!(e instanceof FileUnreadableError)) throw e;
    debugWrite(`[build-context] source fingerprint for ${nodePath}: ${e.message}`);
    return undefined;
  }
  const lock = readLock(graph.rootPath);
  let required = false;
  if (currentFingerprint !== undefined) {
    const storedFingerprint = lock.nodes[nodePath]?.source;
    required = currentFingerprint !== storedFingerprint;
  }
  const projectRoot = projectRootFromGraph(graph.rootPath);
  const logContent = await readLogContent(projectRoot, nodePath);
  const freshPresent = hasFreshLogEntry(logContent, lock.nodes[nodePath]?.log);
  return { required, freshPresent };
}

async function attachLockObservability(
  graph: Graph,
  nodePath: string,
  data: NodeContextData,
): Promise<void> {
  // ── Per-aspect subject counts from the expected-pair set (this node only) ──
  // includeDraft so draft aspects (also listed in the node view) get a count.
  // typeCoverage is real classification data (below), threaded for correctness;
  // it changes nothing here today — the `p.nodePath === nodePath` filter two
  // lines down can never match a nodeless pair — but keeps this call site from
  // silently answering about a component-only universe.
  const typeCoverage = await computeTypeCoverageForContext(graph);
  const { pairs } = await computeExpectedPairs(graph, { includeDraft: true, typeCoverage });
  const subjects: Record<string, NodeAspectSubjects> = {};
  for (const aspect of data.aspects) {
    const aspectPairs = pairs.filter((p) => p.nodePath === nodePath && p.aspectId === aspect.id);
    if (aspectPairs.length === 0) {
      // No pair → the aspect's subject set is empty here (vacuous), OR it is an
      // aggregate (no own reviewer). Aggregates have no scope/subjects; only
      // report a vacuous count for non-aggregate (rule-bearing) aspects.
      const def = graph.aspects.find((a) => a.id === aspect.id);
      if (def && def.reviewer.type !== 'aggregate') {
        subjects[aspect.id] = { count: 0, perFile: false };
      }
      continue;
    }
    const perFile = aspectPairs[0].unitKey.startsWith('file:');
    // per: node → one pair, count its subject files; per: file → count the pairs
    // (one unit per file).
    const count = perFile ? aspectPairs.length : aspectPairs[0].subjectFiles.length;
    subjects[aspect.id] = { count, perFile };
  }
  if (Object.keys(subjects).length > 0) data.aspectSubjects = subjects;

  // ── Log-gate state (read-only mirror of fill.ts §9 logic, without the gate) ──
  // A garbled lock throws LockInvalidError, which propagates to the command's
  // handler (fail closed) — context cannot honestly report gate state over an
  // unreadable lock.
  const archType = graph.architecture.node_types[data.type];
  const logRequiredType = archType?.log_required ?? false;
  let required = false;
  let freshPresent = false;
  if (logRequiredType) {
    const state = await deriveLogGateState(graph, nodePath);
    if (state) {
      ({ required, freshPresent } = state);
    } else {
      // Fingerprint unreadable: deriveLogGateState stays honest and reports
      // nothing, but this view has always reported a gate state regardless —
      // required cannot be honestly computed (stays false, as before), while
      // freshPresent does not depend on the fingerprint, so recompute it here
      // rather than widen the helper's contract to guess it. (Contrast
      // composeBriefExtras below, which omits its line entirely in this case.)
      const lock = readLock(graph.rootPath);
      const projectRoot = projectRootFromGraph(graph.rootPath);
      const logContent = await readLogContent(projectRoot, nodePath);
      freshPresent = hasFreshLogEntry(logContent, lock.nodes[nodePath]?.log);
    }
  }
  const logState: NodeLogState = { required, freshPresent };
  data.logState = logState;
}

/**
 * Advisory structural-attention note for `yg context --file` (spec RZ-21).
 *
 * When the file being inspected is a recorded structural OUTLIER among its node's
 * other same-language files, AND the local deviation index still describes exactly
 * these bytes (a live content-hash match against the same hashing the relation pass
 * uses), append ONE plain-language line hinting a closer read. It is never a rule
 * and never blocks: `yg context --file` stays exit 0. A stale index (bytes changed
 * since it was written) stays silent — the hash will not match.
 *
 * Entirely best-effort: any failure — an unreadable file, a missing or garbled
 * index — is swallowed to the debug log and NOTHING is printed. The caller gates
 * this on `signals.attention` (default ON), so an absent `signals` config means the
 * note is shown.
 */
async function maybeAppendAttentionLine(graph: Graph, repoRelPosixPath: string): Promise<void> {
  try {
    const projectRoot = projectRootFromGraph(graph.rootPath);
    const content = await readTextFile(path.join(projectRoot, repoRelPosixPath));
    const entry = readFeatureFieldEntry(graph.rootPath, repoRelPosixPath, hashString(content));
    if (entry === null) return; // no live outlier record for these exact bytes → say nothing
    // family = `${owner.kind}\x00${owner.id}\x00${language}` (see
    // core/feature-field-schema.ts's FamilyOwner) — the KIND is always the FIRST
    // segment and the language always the LAST, regardless of how many owner
    // segments sit between them (there is currently exactly one, `owner.id`, but
    // taking first/last rather than a fixed split count keeps this stable if that
    // ever changes). A plain single `indexOf` split would hand back the owner id
    // as if it were the language.
    const kindSepAt = entry.family.indexOf(FAMILY_SEP);
    const kind = kindSepAt >= 0 ? entry.family.slice(0, kindSepAt) : entry.family;
    const langSepAt = entry.family.lastIndexOf(FAMILY_SEP);
    const language = langSepAt >= 0 ? entry.family.slice(langSepAt + 1) : entry.family;
    const lang = getLanguageDisplayName(language);
    // A type-covered file (no owning node) is compared against its matched TYPE's
    // other files, never a node's — the cohort noun must say which.
    const cohort = kind === 'type' ? "this file's matched type" : 'this node';
    process.stdout.write(
      `\nThis file is structurally unusual among ${cohort}'s other ${lang} files — worth a closer read; no action required.\n`,
    );
  } catch (err) {
    debugWrite(`[build-context] attention note skipped (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ScopeMarking {
  /** absent ⇒ no scope section (unmeasurable, or no reference configured) */
  scopeHeaderText?: string;
  scopeByAspect?: Map<string, 'yours' | 'inherited'>;
}
/**
 * Exported so both context views read ONE measurement; not part of the CLI surface.
 * `aspectIds` is the file's effective list (`data.aspects`, or `data.typeCoverage.applied`);
 * `pairs` and `repoFiles` are whatever whole-graph enumeration and repo walk the caller made
 * for THIS invocation — this function adds no enumeration of its own on top of those inputs.
 * `precomputedTypeCoverage` and `precomputedPairs` (both optional, trailing) are forwarded on
 * to `resolveChangeScope`'s own `precomputed` field: the resolver reuses a forwarded
 * classification and/or edge-less enumeration when one is given, and only the type-covered
 * configurations still let it enumerate for itself (see `assembleScopeMarking`, the caller,
 * for which of the three call sites hand which — classification is forwarded whenever the
 * caller has one, pairs only when this invocation's own enumeration carried no edges-resolved
 * lattice). Prints a context-scoped
 * notice to stderr itself when the decision carries one
 * (D9) — one print site, matching `cli/check.ts:330-341`: the comment at `:330-334` introduces
 * the code at `:335-341` that does exactly this.
 *
 * `unreadable` is the SAME enumeration's own unreadable-subject list — the
 * caller's `pairs` was built alongside it by one `computeExpectedPairs` call,
 * so a non-empty `unreadable` means `pairs` is known short. Never mark scope
 * on top of a known-short enumeration: a missing pair could be the one that
 * would have made a rule 'yours', so marking it '(inherited)' anyway would be
 * a positive false claim — the same honesty rule the arm preview already
 * applies to its own suppressed count.
 */
export async function computeScopeMarking(
  graph: Graph,
  filePath: string,
  aspectIds: string[],
  pairs: ExpectedPair[],
  repoFiles: string[],
  unreadable: UnreadableSubject[],
  precomputedTypeCoverage?: TypeCoverageInput,
  precomputedPairs?: ExpectedPair[],
): Promise<ScopeMarking> {
  if (unreadable.length > 0) {
    debugWrite(`[build-context] scope marking suppressed: ${unreadable.length} unreadable subject(s), first: ${unreadable[0].path}`);
    return {};
  }
  const reference = graph.config.progressive?.reference;
  if (reference === undefined) return {};

  const projectRoot = projectRootFromGraph(graph.rootPath);
  const decision = await resolveChangeScope({
    graph,
    projectRoot,
    coverageVisibleFiles: repoFiles,
    fullFlag: false,
    precomputed: { typeCoverage: precomputedTypeCoverage, pairs: precomputedPairs },
  });

  if (decision.kind === 'whole-project') return {};

  if (decision.kind === 'unmeasurable') {
    const what = `Scope marking unavailable — this context view could not be measured against '${reference}'`;
    process.stderr.write(chalk.yellow('Notice: ' + buildIssueMessage({ what, why: decision.notice.why, next: decision.notice.next })) + '\n');
    return {};
  }

  // decision.kind === 'scoped' — measured. `known` is the same whole-graph
  // (aspectId, unitKey) key set `knownPairKeys` derives one layer up from
  // VerifiedPair, so pairIsInScope's "cannot attribute" answer (true, the
  // blocking/paying direction) never gets misread as "not touched" for a
  // pair this run simply never enumerated.
  const known = new Set(pairs.map((p) => progressivePairKey(p.aspectId, p.unitKey)));
  const posixFile = toPosixPath(filePath);
  const scopeByAspect = new Map<string, 'yours' | 'inherited'>();
  for (const aspectId of aspectIds) {
    const yours = pairs.some((p) =>
      p.aspectId === aspectId
      && p.subjectFiles.includes(posixFile)
      && pairIsInScope(decision.burn, p.aspectId, p.unitKey, known),
    );
    scopeByAspect.set(aspectId, yours ? 'yours' : 'inherited');
  }
  const fileCount = decision.burn.changedInputCount;
  const fileWord = fileCount === 1 ? 'file' : 'files';
  const inIt = decision.burn.files.has(posixFile) ? 'in it' : 'not in it';
  const scopeHeaderText = `your change so far: ${fileCount} ${fileWord}; this file is ${inIt}`;

  if (decision.notice !== undefined) {
    const what = `Scope marking measured against '${decision.referenceName}' — with a caveat:`;
    process.stderr.write(chalk.yellow('Notice: ' + buildIssueMessage({ what, why: decision.notice.why, next: decision.notice.next })) + '\n');
  }

  return { scopeHeaderText, scopeByAspect };
}

/**
 * THE single gate-walk-classify-enumerate-mark sequence behind `yg context
 * --file`'s scope marking: gate on `progressive.reference` → walk the repo →
 * classify by type → enumerate expected pairs → `computeScopeMarking`. All
 * three call sites (compact, type-covered full view, node-owned full view)
 * call this instead of each re-expressing the same sequence; the per-site
 * differences — whether a walk, a relation edge index, a classification, or
 * a whole-graph enumeration already happened for THIS invocation — live in
 * `precomputed`, never in a copied block. Module-private: not part of the
 * CLI surface.
 */
async function assembleScopeMarking(
  graph: Graph,
  filePath: string,
  data: FileContextData,
  precomputed?: {
    edges?: TypedEdgeIndex;
    repoFiles?: string[];
    pairsWithUnreadable?: { pairs: ExpectedPair[]; unreadable: UnreadableSubject[] };
    /** the classification the caller already paid for — forwarded, never recomputed */
    typeCoverage?: TypeCoverageInput;
  },
): Promise<ScopeMarking> {
  // Tested FIRST, before the walk below: a reference-less project must pay for neither
  // the repo walk nor the whole-graph enumeration it has no use for. The call sites'
  // own reference gates were removed in favor of this one, so its position is
  // load-bearing — nothing may be hoisted above it.
  if (graph.config.progressive?.reference === undefined) return {};
  const repoFiles = precomputed?.repoFiles ?? await walkRepoFiles(projectRootFromGraph(graph.rootPath));
  const typeCoverage =
    precomputed?.typeCoverage ??
    (precomputed?.pairsWithUnreadable === undefined
      ? await computeTypeCoverageForContext(graph, repoFiles)
      : undefined);
  const enumeration =
    precomputed?.pairsWithUnreadable ??
    (await (async () => {
      // the compact site's edges-spread guard (its arm preview builds the same shape,
      // :619-621) — its two conditions keep the node-owned full-view site on the
      // un-spread arm:
      const input = precomputed?.edges !== undefined && typeCoverage !== undefined
        ? { typeCoverage: { ...typeCoverage, edges: precomputed.edges } }
        : { typeCoverage };
      const { pairs, unreadable } = await computeExpectedPairs(graph, input);
      return { pairs, unreadable };
    })());
  // Forwarded on to resolveChangeScope (via computeScopeMarking): the
  // classification whenever this invocation has one — always this PRE-SPREAD
  // `typeCoverage` binding, never the edges-spread one built into `enumeration`
  // above. Pairs ONLY when this enumeration carried no edges-resolved lattice
  // (`precomputed?.edges === undefined` —
  // the node-owned paths): an edges-spread enumeration could let the burn set
  // differ from resolveTypeCoverage's own pessimistic, edge-less contract
  // (progressive-scope-resolve.ts:317-329), so the type-covered configurations
  // hand the resolver only the classification and let it enumerate its own
  // edge-less set.
  const precomputedPairsForResolver = precomputed?.edges === undefined ? enumeration.pairs : undefined;
  return computeScopeMarking(
    graph,
    filePath,
    effectiveAspects(data).map((a) => a.aspectId),
    enumeration.pairs,
    repoFiles,
    enumeration.unreadable,
    typeCoverage,
    precomputedPairsForResolver,
  );
}

/**
 * Assemble the compact view's non-formatting decisions — the trail pointers
 * and the arm preview line — as data the formatter itself does not compute.
 *
 * `shared` carries what the caller already computed for this ONE invocation,
 * so this function never re-walks the repo, re-runs the relation pass, or
 * reclassifies on a path that already paid for one of those: the node-owned
 * call site holds none of the three and passes nothing (falling back to its
 * own walk and its own classification below); the type-covered call site has
 * already walked the repo, already holds `edges` from its own relation pass,
 * and already holds the classification that pass seeded itself with
 * (`typeCoverage`) — and passes all three, so this function's own arm-preview
 * classification is skipped entirely in favor of the forwarded one.
 *
 * Exported so the compact view's assembly decisions are testable in-process; not part of the CLI surface.
 */
export async function composeBriefExtras(
  graph: Graph,
  filePath: string,
  data: FileContextData,
  shared?: { edges?: TypedEdgeIndex; repoFiles?: string[]; typeCoverage?: TypeCoverageInput },
): Promise<FileBriefExtras> {
  const nextPointers: string[] = [];
  if (data.ownerPath) {
    nextPointers.push(`next: yg log read --node ${data.ownerPath}`);
    const lastSlashAt = data.ownerPath.lastIndexOf('/');
    if (lastSlashAt !== -1) {
      const parentPath = data.ownerPath.slice(0, lastSlashAt);
      if (graph.nodes.has(parentPath)) {
        nextPointers.push(`next: yg context --node ${parentPath}`);
      }
    }
  }
  const governing = effectiveAspects(data);
  if (governing.length > 0) {
    nextPointers.push(`next: yg context --file ${filePath} --aspect ${governing[0].aspectId}`);
  }

  // repoFiles for the scope-marking measurement below, hoisted so the arm
  // preview's own typeCoverage call (immediately below) can reuse it instead
  // of paying for a second walk when both progressive mode and type-level
  // coverage are configured together. Gated on progressive mode alone — never
  // on type-level coverage — because a node-owned file's own typeCoverage
  // call never walks the repo when type_level is off
  // (computeTypeCoverageForContext returns before walking), so nothing else
  // would ever produce this walk for computeScopeMarking to reuse.
  const repoFiles = shared?.repoFiles
    ?? (graph.config.progressive?.reference !== undefined ? await walkRepoFiles(projectRootFromGraph(graph.rootPath)) : undefined);

  // The arm preview: how many pairs editing this file would invalidate, split
  // free (deterministic) vs reviewer (llm). typeCoverage must be passed to
  // computeExpectedPairs, otherwise a type-covered file's nodeless pairs are
  // never enumerated and the preview is always zero. On the type-covered
  // branch the caller's `edges` must be spread onto it — computeTypeCoverageForContext
  // never sets edges itself, and without them a relation-gated rule would be
  // missing from this count while still printed under "Must satisfy:" above.
  //
  // `wholeGraphPairs` (and its sibling `wholeGraphUnreadable`) survive the try
  // block so the scope-marking call below can reuse this SAME whole-graph
  // enumeration rather than making a second one — both stay undefined only on
  // the rare failure this block already swallows, in which case scope marking
  // is skipped too rather than paying for its own re-enumeration.
  let armPreviewText: string | undefined;
  let wholeGraphPairs: ExpectedPair[] | undefined;
  let wholeGraphUnreadable: UnreadableSubject[] | undefined;
  let wholeGraphTypeCoverage: TypeCoverageInput | undefined;
  try {
    // The seed's classification, when the caller already paid for one
    // (the type-covered call site, via computeRelationEdgesForContext) —
    // forwarded rather than reclassified, so a type-covered invocation
    // classifies ONCE, at the seed.
    wholeGraphTypeCoverage = shared?.typeCoverage ?? await computeTypeCoverageForContext(graph, repoFiles);
    const typeCoverageWithEdges = shared?.edges !== undefined && wholeGraphTypeCoverage !== undefined
      ? { ...wholeGraphTypeCoverage, edges: shared.edges }
      : wholeGraphTypeCoverage;
    const { pairs, unreadable } = await computeExpectedPairs(graph, { typeCoverage: typeCoverageWithEdges });
    wholeGraphPairs = pairs;
    wholeGraphUnreadable = unreadable;
    if (unreadable.length > 0) {
      // A non-empty unreadable set means the pair count above is not the true
      // invalidation set — printing it anyway would understate what an edit
      // actually costs. Suppress the whole line rather than mislead.
      debugWrite(`[build-context] arm preview suppressed: ${unreadable.length} unreadable subject(s), first: ${unreadable[0].path}`);
    } else {
      const posixFile = toPosixPath(filePath);
      const filePairs = pairs.filter((p) => p.subjectFiles.includes(posixFile));
      if (filePairs.length > 0) {
        const free = filePairs.filter((p) => p.kind === 'deterministic').length;
        const reviewer = filePairs.filter((p) => p.kind === 'llm').length;
        armPreviewText = `editing this file invalidates ${filePairs.length} pair${filePairs.length === 1 ? '' : 's'} (${free} free / ${reviewer} reviewer pair${reviewer === 1 ? '' : 's'}) — price a fill: yg check --approve --dry-run`;
      }
    }
  } catch (err) {
    // Best-effort, same contract as maybeAppendAttentionLine above: this is a
    // read-only preview on top of an already-successful `yg context --file`
    // call, so a failure here must never abort output that would otherwise
    // have printed — it just omits the line.
    debugWrite(`[build-context] arm preview skipped (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Progressive-mode scope marking (D2/D3/D6): which of this file's rules the
  // current change is accountable for, 'yours' vs inherited debt. Gated on
  // the same config presence computeScopeMarking re-checks defensively, so a
  // reference-less project pays for neither the repo walk above nor this
  // call — and reuses the SAME whole-graph pairs enumeration and repo walk
  // the arm preview above already made, never a second one.
  let scopeHeaderText: string | undefined;
  let scopeByAspect: Map<string, 'yours' | 'inherited'> | undefined;
  if (graph.config.progressive?.reference !== undefined && wholeGraphPairs !== undefined) {
    const marking = await assembleScopeMarking(graph, filePath, data, {
      edges: shared?.edges,
      repoFiles,
      pairsWithUnreadable: { pairs: wholeGraphPairs, unreadable: wholeGraphUnreadable ?? [] },
      typeCoverage: wholeGraphTypeCoverage,
    });
    scopeHeaderText = marking.scopeHeaderText;
    scopeByAspect = marking.scopeByAspect;
  }

  // The owner's log-gate state and flow membership — both absent for a
  // type-covered file (no owning component, therefore no log gate and no
  // flow membership to report), present only for a node-owned file. Derived
  // by the same deriveLogGateState helper the node view uses (above), so
  // the compact view's line can never disagree with what `yg context
  // --node` reports for the same component.
  let logGateText: string | undefined;
  let flowsText: string | undefined;
  if (data.ownerPath) {
    const archType = graph.architecture.node_types[data.ownerType ?? ''];
    const logRequiredType = archType?.log_required ?? false;
    // A type that does not demand a written reason has nothing to report —
    // a brief carries no zero-information lines, so the line is omitted
    // rather than printed as "no".
    // Contrast with the arm preview above: that block is best-effort and swallows every failure, while this log gate fails closed like the node view (a genuine LockInvalidError still propagates), the one exception being the honest "fingerprint unreadable" case below.
    if (logRequiredType) {
      const state = await deriveLogGateState(graph, data.ownerPath);
      if (state) {
        logGateText = `Log entry required before approve: ${state.required ? 'yes' : 'no'} (fresh entry present: ${state.freshPresent ? 'yes' : 'no'})`;
      }
      // else: fingerprint unreadable — deriveLogGateState already logged it
      // to the debug log; the line is simply omitted here.
    }
    const flows = buildNodeContextData(graph, data.ownerPath).flows;
    if (flows.length > 0) {
      flowsText = `Flows: ${flows.map((fl) => fl.name).join(' · ')}`;
    }
  }

  return { armPreviewText, scopeHeaderText, scopeByAspect, nextPointers, logGateText, flowsText };
}

export function registerBuildCommand(program: Command): void {
  const contextAction = async (options: { node?: string; file?: string; brief?: boolean; aspect?: string }) => {
      try {
        if (!options.node && !options.file) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: "No target specified.",
            why: "Either '--node <path>' or '--file <path>' is required.",
            next: "Run: yg context --node <path> or yg context --file <path>",
          }) + '\n'));
          process.exit(1);
        }
        if (options.node && options.file) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: "Conflicting options.",
            why: "'--node' and '--file' are mutually exclusive.",
            next: "Use one or the other, not both.",
          }) + '\n'));
          process.exit(1);
        }
        if (options.brief && options.node) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: "--brief is only available with --file.",
            why: "The brief compresses one file's obligations into two lines per rule; --node already prints the component view, which has no per-file rule list to compress.",
            next: "Run: yg context --file <path> --brief, or yg context --node <path> for the component view.",
          }) + '\n'));
          process.exit(1);
        }
        if (options.aspect !== undefined && options.node) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: "--aspect is only available with --file.",
            why: "--aspect expands one rule from one file's own effective set; a component's rules are listed by yg context --node itself.",
            next: "Run: yg context --file <path> --aspect <id>.",
          }) + '\n'));
          process.exit(1);
        }

        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        let nodePath: string;
        let resolvedFilePath: string | undefined;

        if (options.file) {
          const repoRoot = projectRootFromGraph(graph.rootPath);
          const repoRelative = resolveFileArg(repoRoot, options.file);
          const result = await findOwnerWithinOwnGraph(graph, repoRoot, repoRelative);
          const displayFile = toPosixPath(result.file);
          if (!result.nodePath) {
            // A path the coverage scan UNCONDITIONALLY skips (git internals, or
            // the graph's own .yggdrasil/ tree — isCoverageExcludedPath), one
            // that sits inside a SEPARATE project's own boundary (a nested
            // `.yggdrasil/` graph, or a nested `.git` checkout/submodule/
            // worktree), or one matching a `coverage.excluded` root an adopter
            // configured (the latter two via isExcludedFromGraph, the same
            // exclusion authority findOwnerWithinOwnGraph above already
            // consulted for the mapped case — a genuinely mapped `.yggdrasil/`
            // meta file is deliberately NOT caught by isExcludedFromGraph, so
            // findOwnerWithinOwnGraph would have kept its owner and this branch
            // would never run for it). Any of these can never be enforced by
            // this graph — suggesting "add it to a node mapping" would map a
            // file yg check will never see, or one this graph does not own or
            // has deliberately excluded. Answer "excluded by design" and exit 0
            // either way: this is not a coverage gap, so there is genuinely
            // nothing to fix.
            const exclusionSet = await resolveGraphExclusionSet(repoRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
            if (isCoverageExcludedPath(result.file)) {
              // Structurally exempt (git internals, or the graph's own
              // directory) — unconditional, nothing to do with an adopter's
              // config, so it is named on its own rather than folded into the
              // config-driven disjunction below. Same wording `yg owner --file`
              // already uses for the identical path.
              const excludedMsg = buildIssueMessage({
                what: `${displayFile} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because it sits inside git internals or the graph's own .yggdrasil/ directory, so it cannot and need not be mapped to a node here.`,
                next: 'No action needed.',
              });
              process.stdout.write(`${excludedMsg}\n`);
              process.exit(0);
            }
            if (isExcludedFromGraph(result.file, exclusionSet)) {
              // Names WHICH of the two independent config/filesystem-derived
              // sources caused this — the same distinction `yg owner --file`
              // and `yg type-suggest --file` already draw — instead of asking
              // the reader to check both their own config and their own
              // filesystem. describeExclusionSource cannot return null here:
              // isExcludedFromGraph just confirmed this path is excluded by
              // one of exactly the two sources it covers.
              const cause = describeExclusionCause(describeExclusionSource(result.file, exclusionSet)!);
              const excludedMsg = buildIssueMessage({
                what: `${displayFile} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because ${cause}, so it cannot and need not be mapped to a node here.`,
                next: 'No action needed.',
              });
              process.stdout.write(`${excludedMsg}\n`);
              process.exit(0);
            }
            // A typed answer, not "not covered by any node": classifies ONLY
            // this one file, never the whole-repo classification map, and,
            // when it matches exactly one non-strict type, replaces the
            // not-covered error with the matched type, its chain, and both
            // halves of what the type attaches.
            if (graph.config.coverage?.typeLevel) {
              const typeMatch = await classifySingleFileCached(graph, result.file, new FileContentCache());
              if (typeMatch.bucket === 'covered') {
                // Walked once for this invocation and threaded everywhere below
                // that would otherwise re-walk the repo: into the relation
                // pass, into the seed classification the relation pass now
                // returns instead of discarding, and into assembleScopeMarking
                // (both directly, below, and via composeBriefExtras's own call
                // to it).
                const repoFiles = await walkRepoFiles(repoRoot);
                // Run the relation pass exactly once for this invocation — its
                // typed-edge index is threaded into BOTH the cycle pre-check
                // below and buildTypeCoveredFileContextData's own type-coverage
                // input, so a `relations:` atom in this file's attached rules'
                // `when:` is answered from the SAME real, statically-resolved
                // imports `yg check` enforces against, not the conservative
                // always-false a caller with no edge index falls back to. The
                // classification it seeds itself with is also the WHOLE-REPO
                // classification composeBriefExtras and assembleScopeMarking
                // would otherwise pay to compute again — threaded into both
                // below, so a type-covered invocation classifies ONCE, at the
                // seed.
                const { edges, typeCoverage: seedTypeCoverage } = await computeRelationEdgesForContext(graph, repoRoot, repoFiles);
                // An aspect `implies` cycle reachable from this type stops the
                // cascade before it can decide what applies — computeTypeAspectCascade
                // absorbs the cycle into a `cycle` marker rather than an empty
                // "nothing applies" result (see its own doc). Say so plainly,
                // naming the cycle, instead of running buildTypeCoveredFileContextData
                // and rendering the file as satisfying coverage with zero
                // enforcement, which would be false: the type's rules were never
                // resolved, not resolved-and-absent. yg check's own static
                // aspect-implies-cycle error is unaffected — it still fires and
                // still blocks, on its own separate path. Shares its wording
                // with yg owner --file's identical check (and yg check's own
                // report of the same fact) via describeCascadeCycle, so the
                // surfaces cannot disagree.
                const cascadeCycle = computeTypeAspectCascade(graph, result.file, typeMatch.typeId, edges).cycle;
                if (cascadeCycle) {
                  const cycleMsg = buildIssueMessage({
                    what: `${displayFile} matches type '${typeMatch.typeId}', but its rules could not be worked out.`,
                    why: describeCascadeCycle(cascadeCycle),
                    next: `Run yg check to see the blocking aspect-implies-cycle error, then remove one implies edge in .yggdrasil/aspects/. This file's rules cannot be evaluated until the cycle is fixed.`,
                  });
                  process.stderr.write(chalk.red(`Error: ${cycleMsg}\n`));
                  process.exit(1);
                }
                const data = await buildTypeCoveredFileContextData(graph, displayFile, typeMatch.typeId, edges);
                if (options.aspect !== undefined) {
                  const rendered = formatFileContextAspect(data, options.aspect);
                  if (rendered === undefined) {
                    process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
                      what: `Rule '${options.aspect}' is not one of the rules enforced on ${displayFile}.`,
                      why: "--aspect names a rule from this file's own effective set; a rule attached elsewhere in the graph is not enforced here.",
                      next: `Run: yg context --file ${displayFile} --brief to list this file's rules, then retry with one of them.`,
                    }) + '\n'));
                    process.exit(1);
                  }
                  process.stdout.write(rendered + '\n');
                } else if (options.brief) {
                  process.stdout.write(formatFileContextBrief(data, await composeBriefExtras(graph, displayFile, data, { edges, repoFiles, typeCoverage: seedTypeCoverage })));
                } else {
                  // Progressive-mode scope marking (D2/D3/D6), full view. This
                  // file's own `data` came from a single-entry covered map, so
                  // nothing computeExpectedPairs already did above is reusable
                  // here; `repoFiles` is the walk already made above for this
                  // invocation — no second walk; `typeCoverage` is the seed's
                  // own classification, forwarded rather than reclassified.
                  const marking = await assembleScopeMarking(graph, displayFile, data, { edges, repoFiles, typeCoverage: seedTypeCoverage });
                  process.stdout.write(formatFileContext(data, marking.scopeByAspect));
                  if (graph.config.signals?.attention !== false) {
                    await maybeAppendAttentionLine(graph, displayFile);
                  }
                }
                process.exit(0);
              }
            }
            const candidates = findCandidateNodes(graph, result.file);
            if (candidates.length > 0) {
              let candidatesList = '';
              for (const c of candidates) {
                candidatesList += `  - ${c.nodePath} (${c.fileCount} file${c.fileCount === 1 ? '' : 's'} in same dir)\n`;
              }
              const msg = buildIssueMessage({
                what: `${displayFile} has no graph coverage.`,
                why: `File is not mapped to any node. Other files in the same directory are mapped to these nodes:\n${candidatesList}This suggests the file should be added to one of them.`,
                next: 'Use: yg context --node <node-path>',
              });
              process.stderr.write(chalk.red(`Error: ${msg}\n`));
            } else {
              const noGraphMsg = buildIssueMessage({
                what: `${displayFile} has no graph coverage.`,
                why: 'File is not mapped to any node and no candidate nodes found in the same directory.',
                next: 'Add the file to an existing node mapping, or create a new node.',
              });
              process.stderr.write(chalk.red(`Error: ${noGraphMsg}\n`));
            }
            process.exit(1);
          }
          process.stdout.write(`${displayFile} -> ${result.nodePath}\n`);
          nodePath = result.nodePath;
          resolvedFilePath = toPosixPath(result.file);
        } else {
          nodePath = options.node!.trim().replace(/\/$/, '');
        }

        const relevantNodes = collectRelevantNodePaths(graph, nodePath);

        const validationResult = await validate(graph, 'all');
        const relevantErrors = validationResult.issues.filter(
          (issue) =>
            issue.severity === 'error' &&
            (!issue.nodePath || relevantNodes.has(issue.nodePath)),
        );
        if (relevantErrors.length > 0) {
          const totalErrors = validationResult.issues.filter((i) => i.severity === 'error').length;
          const skippedErrors = totalErrors - relevantErrors.length;
          let errorList = '';
          for (const err of relevantErrors) {
            const loc = err.nodePath ? `${err.nodePath}: ` : '';
            errorList += `  ${err.code ?? ''} ${loc}${buildIssueMessage(err.messageData)}\n`;
          }
          let whyText = 'Context cannot be assembled when structural errors exist.';
          if (skippedErrors > 0) {
            whyText += ` (${skippedErrors} unrelated error(s) in other nodes ignored.)`;
          }
          const msg = buildIssueMessage({
            what: `build-context blocked by ${relevantErrors.length} error${relevantErrors.length === 1 ? '' : 's'} affecting this node's context.`,
            why: whyText,
            next: `Run yg check and fix the listed errors first:\n${errorList}`,
          });
          process.stderr.write(chalk.red(`Error: ${msg}\n`));
          process.exit(1);
        }

        if (resolvedFilePath) {
          const data = buildFileContextData(graph, resolvedFilePath, nodePath);
          if (options.aspect !== undefined) {
            const rendered = formatFileContextAspect(data, options.aspect);
            if (rendered === undefined) {
              process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
                what: `Rule '${options.aspect}' is not one of the rules enforced on ${resolvedFilePath}.`,
                why: "--aspect names a rule from this file's own effective set; a rule attached elsewhere in the graph is not enforced here.",
                next: `Run: yg context --file ${resolvedFilePath} --brief to list this file's rules, then retry with one of them.`,
              }) + '\n'));
              process.exit(1);
            }
            process.stdout.write(rendered + '\n');
          } else if (options.brief) {
            process.stdout.write(formatFileContextBrief(data, await composeBriefExtras(graph, resolvedFilePath, data)));
          } else {
            // Progressive-mode scope marking (D2/D3/D6), full view. This call
            // site holds neither a walk nor a classification today (no
            // type-level classification runs for a node-owned file), so the
            // helper makes its own — exactly one repo walk, same as
            // composeBriefExtras's own node-owned path.
            const marking = await assembleScopeMarking(graph, resolvedFilePath, data);
            process.stdout.write(formatFileContext(data, marking.scopeByAspect));
            // Advisory structural-attention note. Default ON; the off-switch is
            // signals.attention: false (absent `signals` ⇒ ON). Read-only,
            // best-effort, non-blocking — yg context --file stays exit 0.
            if (graph.config.signals?.attention !== false) {
              await maybeAppendAttentionLine(graph, resolvedFilePath);
            }
          }
        } else {
          const data = buildNodeContextData(graph, nodePath);
          // Show the node's OWNED files — the child-precedence carve-out applied —
          // so `yg context` agrees with `yg owner` and with what the node's aspects
          // actually review: a file claimed by a descendant node is NOT listed here.
          data.sourceFiles = await computeNodeMappedFiles(graph, nodePath);
          await attachLockObservability(graph, nodePath, data);
          process.stdout.write(formatNodeContext(data));
        }
      } catch (error) {
        debugWrite(`[build-context] context assembly failed: ${error instanceof Error ? error.message : String(error)}`);
        // A typo'd --node path is a USER error, not an internal bug — classify it
        // with a structured what/why/next instead of the generic crash handler.
        const msg = error instanceof Error ? error.message : String(error);
        const notFound = msg.match(/^Node not found: (.+)$/);
        if (notFound) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: `Node '${toPosixPath(notFound[1])}' does not exist in the graph.`,
            why: `The --node path must name an existing node — a directory under .yggdrasil/model/, written without the model/ prefix.`,
            next: `Browse the graph with 'yg tree', or locate one with 'yg find "<keywords>"', then retry with a valid --node path.`,
          }) + '\n'));
          process.exit(1);
        }
        // A --file path that resolves outside the repository is USER input, not an
        // internal bug — classify it rather than routing to the crash handler.
        const outsideRoot = msg.match(/^Path is outside project root: (.+)$/);
        if (outsideRoot) {
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: `The path '${toPosixPath(outsideRoot[1])}' is outside the project root.`,
            why: `Context can only be built for files tracked inside the project.`,
            next: `Pass a path inside the project root (relative to the repo).`,
          }) + '\n'));
          process.exit(1);
        }
        abortOnUnexpectedError(error, 'building context');
      }
  };

  // Primary command: `yg context`
  program
    .command('context')
    .description('Assemble a context package for one node')
    .option('--node <node-path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--brief', 'compact two-line-per-rule view (≤ 30 lines)')
    .option('--aspect <id>', 'expand one rule in full (wins over --brief)')
    .action(contextAction);

}
