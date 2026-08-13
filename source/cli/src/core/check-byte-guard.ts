/**
 * source/cli/src/core/check-byte-guard.ts — the GATHERING half of the byte
 * guard: which findings are worth asking the bytes about, which files each one
 * is about, and what those files currently contain.
 *
 * The DECIDING half is `core/progressive-scope.ts`'s
 * {@link forceInScopeOnByteMismatch}, which is pure — ids and bytes arrive as
 * plain values. This module is the seam that makes that possible: it holds the
 * filesystem and graph access the guard needs, so the decision itself never
 * touches a disk. Split that way on purpose — the decision is the part whose
 * "adds scope, never removes it" property has to be provable, and a function
 * that reads files while it decides cannot be proved by a plain test.
 *
 * ── Why gathering is driven by FINDINGS, not by rule checks ─────────────────
 * The classification ladder attributes a finding by whichever identity it
 * carries: a rule check, a component, a file, or the dependency edges it names.
 * Gathering from rule checks alone therefore closed the evasion for exactly one
 * of those four rungs. A hidden edit that introduced an undeclared cross-component
 * dependency moved no rule check at all — its finding carries only a component
 * path — so the whole class went on being released on git's false report. The
 * candidate set is now derived from the assembled findings themselves, filtered
 * by the SAME predicate the classifier downgrades on, so the two cannot drift.
 *
 * ── What both halves hand the decision besides the candidates ───────────────
 * The component -> rule-check index. Re-admitting a component has to re-admit
 * every check it owns, which is what the burn table's own owner row does for a
 * file git reported; the decision cannot derive that from a graph it never sees,
 * so the gathering builds it from this run's enumeration and passes it along.
 *
 * ── Why only these findings ─────────────────────────────────────────────────
 * A finding is a candidate only when the classifier is about to set it aside AND
 * it is blocking. Anything else is work with no possible effect: an in-scope
 * finding already blocks, a warning is never downgraded, and a code outside the
 * downgradable set is never touched. On a healthy repository the candidate list
 * is empty and this module reads nothing at all.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import { readFileBytes } from '../io/graph-fs.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import { toPosixPath } from '../utils/posix.js';
import type { CheckIssue } from './check-contract.js';
import type { VerifiedPair } from './verify-lock.js';
import { emitPairIssue } from './check-pair-issues.js';
import { issueIsInScope, knownPairKeys } from './check-progressive.js';
import { SCOPED_CODES, SINGLETON_INPUTS } from './check-codes.js';
import type {
  BurnSet,
  ByteGuardCandidate,
  ByteGuardEvidence,
  ByteGuardSubject,
} from './progressive-scope.js';
import { gitObjectDigest, progressivePairKey } from './progressive-scope.js';

/** The measured scope plus the listing to check it against, as the engine receives it. */
export interface ByteGuardScope {
  burn: BurnSet;
  blobOidByPath: Map<string, string> | null;
}

/**
 * One candidate, with the finding it came from attached.
 *
 * The back-reference is what lets a caller report how many findings the guard
 * KEPT without running the comparison a second time: the classifier hands an
 * in-scope finding back as the very object it was given, so a candidate whose
 * `issue` survives into the classified list is one the run was about to release
 * and did not. Absent on the fill's rule-check gathering, which happens before
 * any finding exists.
 */
export interface ByteGuardCandidateFromFinding extends ByteGuardCandidate {
  issue?: CheckIssue;
}

/** What one gathering pass produced, plus the one thing a caller must be able to report. */
export interface ByteGuardGathering extends ByteGuardEvidence {
  candidates: ByteGuardCandidateFromFinding[];
  /** Every rule check each component owns — see {@link ByteGuardEvidence}. */
  pairKeysByNode: Map<string, string[]>;
  /**
   * The reference listing's ids are in an object format this build cannot
   * reproduce, so the guard cannot run at all. Surfaced rather than swallowed:
   * a check that has silently switched itself off is worse than one that says
   * it could not be made.
   */
  unsupportedObjectFormat: boolean;
}

/** A gathering that found nothing and read nothing. A fresh object per call — a
 *  shared one would hand every caller the same array. */
const nothing = (): ByteGuardGathering => ({
  candidates: [],
  pairKeysByNode: new Map(),
  unsupportedObjectFormat: false,
});

/** Unit-key prefix for a unit that IS one file — mirrors the classifier's own rung. */
const FILE_UNIT_PREFIX = 'file:';

/** The aggregate coverage finding, which names a list of files rather than one subject. */
const COVERAGE_AGGREGATE_CODE = 'unmapped-files';

/**
 * Reads each file at most once per run, preferring bytes the run has ALREADY
 * read over a second trip to disk.
 *
 * The lock verification loads every subject file to re-hash it; handing that
 * cache in means the guard compares the very bytes the verdict was computed
 * from, rather than a fresh read that could — in the window between the two —
 * be different content. Files outside that cache (a component's other sources,
 * an uncovered file, a file named by a dependency edge) are read here.
 */
function makeReader(
  projectRoot: string,
  alreadyRead: ReadonlyMap<string, Buffer | null> | undefined,
): (relPath: string) => Promise<Buffer | null> {
  const own = new Map<string, Buffer | null>();
  return async (relPath: string): Promise<Buffer | null> => {
    const absPath = path.resolve(projectRoot, relPath);
    const hit = alreadyRead?.get(absPath);
    if (hit !== undefined) return hit;
    // `has` rather than a truthiness test: an unreadable file caches as `null`,
    // and reading that back as a miss would re-read it once per finding.
    if (own.has(relPath)) return own.get(relPath)!;
    const bytes = await readFileBytes(absPath);
    own.set(relPath, bytes);
    return bytes;
  };
}

/**
 * Is the guard able and required to run at all? Returns the digest the
 * repository's ids were made with, or a reason to stop.
 */
function guardPrecondition(
  scope: ByteGuardScope | undefined,
): { run: false; gathering: ByteGuardGathering } | { run: true; burn: BurnSet } {
  if (scope === undefined || scope.blobOidByPath === null) return { run: false, gathering: nothing() };
  if (scope.burn.global) return { run: false, gathering: nothing() };
  if (gitObjectDigest(scope.blobOidByPath) === null) {
    return {
      run: false,
      gathering: { candidates: [], pairKeysByNode: new Map(), unsupportedObjectFormat: true },
    };
  }
  return { run: true, burn: scope.burn };
}

/**
 * Component -> every rule check it owns, from this run's own enumeration. The
 * same index the burn table builds for its owner row, rebuilt here because the
 * decision must be able to re-admit a component WHOLE without being handed a
 * graph.
 */
function indexPairKeysByNode(pairs: VerifiedPair[]): Map<string, string[]> {
  const byNode = new Map<string, string[]>();
  for (const vp of pairs) {
    if (vp.pair.nodePath === undefined) continue;
    const key = progressivePairKey(vp.pair.aspectId, vp.pair.unitKey);
    const owned = byNode.get(vp.pair.nodePath);
    if (owned === undefined) byNode.set(vp.pair.nodePath, [key]);
    else owned.push(key);
  }
  return byNode;
}

/**
 * Does this pair produce a BLOCKING finding at all?
 *
 * Asked of `emitPairIssue` rather than re-derived from `state.kind`, because
 * that function is the single authority on what a pair's state is reported as,
 * and the mapping is not one-to-one: an ADVISORY pair's refusal is a warning
 * (which the classifier never downgrades, so guarding it would be pure noise),
 * while a pair whose stored verdict is perfectly valid still reports a blocking
 * prompt-size error when its assembled prompt outgrew the tier. A second copy of
 * that table here would drift, and every way it could drift ends in the guard
 * looking at the wrong set.
 *
 * The runtime-disposition rows are deliberately empty: they only reword an
 * unverified pair's message, never its severity, and this asks about severity.
 */
function producesBlockingFinding(vp: VerifiedPair): boolean {
  return emitPairIssue(vp, []).some((issue) => issue.severity === 'error');
}

/**
 * Candidates derived from this run's RULE CHECKS alone — what a fill stage
 * needs, since the only thing it decides with a scope is which rule checks to
 * pay a reviewer for.
 *
 * This exists separately from {@link collectFindingByteGuardCandidates} because
 * a fill runs before any finding is assembled. It answers the same question for
 * the subset a fill can act on, so a rule check the report is about to re-admit
 * is also one the fill is about to buy — without which a re-admitted
 * reviewer-judged finding would block forever while the very command the run
 * advises refused to review it.
 */
export async function collectPairByteGuardCandidates(
  scope: ByteGuardScope | undefined,
  pairs: VerifiedPair[],
  projectRoot: string,
  alreadyRead?: ReadonlyMap<string, Buffer | null>,
): Promise<ByteGuardGathering> {
  const precondition = guardPrecondition(scope);
  if (!precondition.run) return precondition.gathering;
  const { burn } = precondition;

  const read = makeReader(projectRoot, alreadyRead);
  const candidates: ByteGuardCandidateFromFinding[] = [];
  for (const vp of pairs) {
    const pairKey = progressivePairKey(vp.pair.aspectId, vp.pair.unitKey);
    if (burn.pairKeys.has(pairKey)) continue;
    if (!producesBlockingFinding(vp)) continue;
    const subjects: ByteGuardSubject[] = [];
    for (const file of vp.pair.subjectFiles) {
      // A pair already names the component that answers for it, so no
      // path-pattern resolution is needed (or paid for) on this path.
      subjects.push({ path: file, bytes: await read(file), owner: vp.pair.nodePath });
    }
    candidates.push({ pairKey, subjects });
  }
  return { candidates, pairKeysByNode: indexPairKeysByNode(pairs), unsupportedObjectFormat: false };
}

/**
 * Every file one finding's verdict is about, derived from whichever identity it
 * carries — the exact dual of the classification ladder's rungs, so a finding
 * the classifier attributes by X is asked about the files X names.
 *
 * Over-gathering is safe (a file that did not move re-admits nothing);
 * under-gathering is not, which is why every rung the classifier can match on
 * appears here.
 */
export function filesOfIssue(
  issue: CheckIssue,
  subjectsByPairKey: ReadonlyMap<string, string[]>,
  filesOfNode: (nodePath: string) => string[],
  outsideFiles: (issue: CheckIssue) => string[],
): string[] {
  const files = new Set<string>();
  // 1. A finding whose entire input is a fixed, well-known project file.
  //    Unreachable through the gathering pass today, for the same reason the
  //    ladder's own first rung is: no `SINGLETON_INPUTS` code is a
  //    `SCOPED_CODES` member, so no such finding is ever downgraded and none is
  //    ever offered here. Kept — and this function exported and tested directly
  //    rather than marked as uncovered — because a code admitted to both sets
  //    later would be attributed by those fixed paths, and a gatherer that had
  //    never learned to ask about them would reopen the evasion for exactly that
  //    code, silently.
  for (const fixed of SINGLETON_INPUTS.get(issue.code) ?? []) files.add(fixed);
  // 2. A rule check names its own subject files, through this run's enumeration.
  if (issue.aspectId !== undefined && issue.aspectId !== '' && issue.unitKey !== undefined && issue.unitKey !== '') {
    for (const file of subjectsByPairKey.get(progressivePairKey(issue.aspectId, issue.unitKey)) ?? []) {
      files.add(file);
    }
  }
  // 3. A component-keyed finding is about that component's own source. This is
  //    the rung that made the whole class reachable: an undeclared-dependency
  //    finding carries a component path and nothing else.
  if (issue.nodePath !== undefined && issue.nodePath !== '') {
    for (const file of filesOfNode(issue.nodePath)) files.add(file);
  }
  // 4. A per-file finding that named its file through the unit key.
  if (issue.unitKey?.startsWith(FILE_UNIT_PREFIX) === true) {
    const file = issue.unitKey.slice(FILE_UNIT_PREFIX.length);
    if (file !== '') files.add(file);
  }
  // 5. An aggregate finding carrying the concrete file-to-file edges it is about.
  for (const edge of issue.relationEdges ?? []) {
    if (edge.fromFile !== undefined && edge.fromFile !== '') files.add(edge.fromFile);
    if (edge.toFile !== undefined && edge.toFile !== '') files.add(edge.toFile);
  }
  // 6. The aggregate coverage finding, which is SPLIT rather than downgraded:
  //    only the half about to be reported as inherited is worth asking about.
  for (const file of outsideFiles(issue)) files.add(file);
  return [...files];
}

/**
 * The findings the classification is about to set aside, with the files each is
 * about and the bytes those files currently hold.
 *
 * Returns nothing — having read nothing — whenever the guard cannot or need not
 * run: no change scope at all (the whole project is being gated), no reference
 * listing to compare against, a scope that already went global, or a listing in
 * an object format this build cannot reproduce (which is reported rather than
 * silently swallowed). That is what keeps a run with the feature off byte-for-byte
 * what it always was: this is a no-op with no I/O, not a cheap version of itself.
 */
export async function collectFindingByteGuardCandidates(args: {
  scope: ByteGuardScope | undefined;
  /** The assembled issue list, exactly as the classifier is about to receive it. */
  issues: CheckIssue[];
  /** This run's enumeration — the authority on a rule check's subject files. */
  pairs: VerifiedPair[];
  graph: Graph;
  /** The repo file walk, for resolving a component to its own files. `null` ⇒ fall back to rule-check subjects. */
  visibleFiles: string[] | null;
  projectRoot: string;
  /** Bytes the lock verification already read this run, keyed by absolute path. */
  alreadyRead?: ReadonlyMap<string, Buffer | null>;
}): Promise<ByteGuardGathering> {
  const precondition = guardPrecondition(args.scope);
  if (!precondition.run) return precondition.gathering;
  const { burn } = precondition;

  const known = knownPairKeys(args.pairs);
  const subjectsByPairKey = new Map<string, string[]>();
  const subjectsByNode = new Map<string, Set<string>>();
  for (const vp of args.pairs) {
    subjectsByPairKey.set(progressivePairKey(vp.pair.aspectId, vp.pair.unitKey), vp.pair.subjectFiles);
    if (vp.pair.nodePath === undefined) continue;
    let owned = subjectsByNode.get(vp.pair.nodePath);
    if (owned === undefined) {
      owned = new Set<string>();
      subjectsByNode.set(vp.pair.nodePath, owned);
    }
    for (const file of vp.pair.subjectFiles) owned.add(file);
  }

  const { ownerOf } = buildOwnerIndex(args.graph.nodes);
  // A component's own files, from the repo walk resolved through the graph's
  // path patterns — the same resolution the burn table's owner row uses. Built
  // ONCE and only when a component-keyed candidate actually needs it, since it
  // costs a pass over every visible file. Falls back to the union of the
  // component's rule-check subjects when there is no walk to read (a caller
  // that supplied no file list), which is narrower but never wrong.
  let byNode: Map<string, string[]> | undefined;
  const filesOfNode = (nodePath: string): string[] => {
    if (args.visibleFiles === null) return [...(subjectsByNode.get(nodePath) ?? [])];
    if (byNode === undefined) {
      byNode = new Map();
      for (const raw of args.visibleFiles) {
        const file = toPosixPath(raw.trim());
        const owner = ownerOf(file);
        if (owner === undefined) continue;
        const list = byNode.get(owner);
        if (list === undefined) byNode.set(owner, [file]);
        else list.push(file);
      }
    }
    return byNode.get(nodePath) ?? [...(subjectsByNode.get(nodePath) ?? [])];
  };
  const outsideFiles = (issue: CheckIssue): string[] =>
    issue.code === COVERAGE_AGGREGATE_CODE
      ? (issue.uncoveredFiles ?? []).filter((f) => !burn.files.has(f))
      : [];

  const read = makeReader(args.projectRoot, args.alreadyRead);
  const candidates: ByteGuardCandidateFromFinding[] = [];
  for (const issue of args.issues) {
    // The downgrade condition, asked of the classifier's own ladder rather than
    // restated — the candidate set is then exactly the set about to be set
    // aside, by construction, and cannot drift from it.
    if (!SCOPED_CODES.has(issue.code) || issue.severity !== 'error') continue;
    if (issue.code !== COVERAGE_AGGREGATE_CODE && issueIsInScope(issue, burn, known)) continue;

    const files = filesOfIssue(issue, subjectsByPairKey, filesOfNode, outsideFiles);
    if (files.length === 0) continue;
    const subjects: ByteGuardSubject[] = [];
    for (const file of files) {
      subjects.push({ path: file, bytes: await read(file), owner: ownerOf(file) });
    }
    const pairKey =
      issue.aspectId !== undefined && issue.aspectId !== '' && issue.unitKey !== undefined && issue.unitKey !== ''
        ? progressivePairKey(issue.aspectId, issue.unitKey)
        : undefined;
    candidates.push({ pairKey, subjects, issue });
  }
  return {
    candidates,
    pairKeysByNode: indexPairKeysByNode(args.pairs),
    unsupportedObjectFormat: false,
  };
}
