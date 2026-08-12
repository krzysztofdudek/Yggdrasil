/**
 * source/cli/src/cli/progressive-view.ts — the read-only progressive VIEW line
 * for `yg check`: how much of this run's issue set the current change is
 * accountable for, measured against the committed reference branch named in
 * `yg-config.yaml`.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is not a gate. Nothing here changes a severity, an issue code, an issue's
 * membership in the report, or the exit code. It reads the result the command
 * already computed and prints ONE sentence above it. That is deliberate, and
 * the sentence says so itself: the numbers exist so the split can be measured
 * on real repositories before anything is allowed to act on it.
 *
 * ── The guarantee that outranks everything else here ────────────────────────
 * With no reference configured, this module must be indistinguishable from not
 * existing: no git process, no file read, no output, no cost. That is why
 * {@link buildProgressiveViewLine} asks the preflight table whether there is
 * anything to do at all BEFORE any probe runs, and why every failure inside it
 * is caught and turned into "print nothing". An informational line must never
 * be able to fail a build.
 *
 * ── Why the classification below is deliberately conservative ───────────────
 * An issue is reported OUTSIDE only when it can be positively attributed to
 * something the change did not reach. Anything this module cannot attribute —
 * an issue with no pair, component or file identity on it, or one naming a pair
 * this module's own enumeration never saw — counts as IN SCOPE. Over-counting
 * makes the measurement pessimistic; under-counting would claim a real finding
 * is none of the change's business, which is the one direction that must never
 * happen, even in a view. The emission-site identity work that lets several
 * repo-level findings be attributed precisely is separate, later work; until it
 * lands, those findings simply read as in scope.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Graph } from '../model/graph.js';
import { LOCK_NONDET_FILE_NAME } from '../model/lock.js';
import type { CheckIssue } from '../core/check-contract.js';
import { computeExpectedPairs, type ExpectedPair, type TypeCoverageInput } from '../core/pairs.js';
import { scanUncoveredFiles } from '../core/check-coverage-scan.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import {
  computeBurnSet,
  configVocabularyChanged,
  progressivePairKey,
  type BurnSet,
} from '../core/progressive-scope.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { readLock } from '../io/lock-store.js';
import {
  changedFilesAgainst,
  getFileAtRef,
  getMergeBase,
  getToplevelAndPrefix,
  gitlinkPaths,
  hasCleanWorktree,
  isAncestor,
  isShallowRepository,
  pathExistsAtRef,
  treesIdentical,
  type ChangedFiles,
} from '../utils/git-introspect.js';
import { toPosixPath } from '../utils/posix.js';
import { debugWrite } from '../utils/debug-log.js';
import { resolveProgressiveState, type PreflightProbes } from './progressive-preflight.js';

/** Repo-relative POSIX location of the two committed files this module reads at the reference. */
const YGG_DIR = '.yggdrasil';
const CONFIG_FILE = `${YGG_DIR}/yg-config.yaml`;
const COMMITTED_LOCK_FILE = `${YGG_DIR}/${LOCK_NONDET_FILE_NAME}`;

/** Unit-key prefix for a pair whose unit IS one file (`model/lock.ts`'s `fileUnit`). */
const FILE_UNIT_PREFIX = 'file:';

export interface ProgressiveViewInput {
  graph: Graph;
  /** The directory the graph's paths are relative to — and, for a scoped run, the git top level. */
  projectRoot: string;
  /** The disk walk the command already performed, reused for the type-level lattice. */
  coverageVisibleFiles: string[];
  /** Whether `--full` was passed. */
  fullFlag: boolean;
  /** The finished report's issue set — the thing being split. */
  issues: CheckIssue[];
}

/**
 * The split itself: how many of the run's issues the change is accountable for,
 * and how many were already there and stay untouched by it.
 */
export interface ProgressiveSplit {
  inScope: number;
  outside: number;
  /**
   * The change reached something no per-issue attribution can bound (the
   * architecture, or the vocabulary the configuration gives the graph), so every
   * issue is in scope by construction. Carried as its own field so the sentence
   * can say that plainly instead of leaving a reader to infer it from a zero.
   */
  global: boolean;
}

/**
 * Which pair keys this module's OWN enumeration produced. Used only to tell
 * "this pair exists and the change did not reach it" (outside) from "the
 * enumeration never saw this pair at all" (unattributable ⇒ in scope). Without
 * that distinction, a pair the enumeration missed would be silently reported as
 * none of the change's business — exactly the claim this module must never make.
 */
function knownPairKeys(pairs: ExpectedPair[]): Set<string> {
  const keys = new Set<string>();
  for (const pair of pairs) keys.add(progressivePairKey(pair.aspectId, pair.unitKey));
  return keys;
}

/** The repo-relative file an issue is about, when its unit key names one. */
function fileSubjectOf(issue: CheckIssue): string | undefined {
  if (issue.unitKey !== undefined && issue.unitKey.startsWith(FILE_UNIT_PREFIX)) {
    return issue.unitKey.slice(FILE_UNIT_PREFIX.length);
  }
  return undefined;
}

/**
 * Is this ONE issue something the change is accountable for?
 *
 * A ladder of decreasing precision: each branch returns a real verdict only
 * where the issue carries an identity the burn set can be probed with, and
 * everything falling through the bottom is unattributable and counts as in
 * scope, per this module's conservative direction.
 */
function issueIsInScope(issue: CheckIssue, graph: Graph, burn: BurnSet, known: Set<string>): boolean {
  // 1. A pair-derived finding names its pair exactly. If this module's own
  //    enumeration never produced that pair, it cannot speak to it at all.
  if (issue.aspectId !== undefined && issue.unitKey !== undefined) {
    const key = progressivePairKey(issue.aspectId, issue.unitKey);
    if (burn.pairKeys.has(key)) return true;
    return !known.has(key);
  }

  // 2. A component-keyed finding. `nodePath` is trusted only when it really is
  //    a component: several finding kinds put a synthetic label there (a rule's
  //    id dressed as a path), and probing the burn set with one would answer
  //    "outside" about something that was never a component to begin with.
  if (issue.nodePath !== undefined && graph.nodes.has(issue.nodePath)) {
    if (burn.nodePaths.has(issue.nodePath)) return true;
    // A component's log is its own channel: writing a log entry re-gates that
    // log and nothing else, so a log finding is the change's business for that
    // edit even though nothing else about the component moved.
    return burn.logOnlyNodePaths.has(issue.nodePath);
  }

  // 3. A per-file finding that named its file through the unit key.
  const file = fileSubjectOf(issue);
  if (file !== undefined) return burn.files.has(file);

  // 4. A coverage finding carrying a whole list of files. Any one of them being
  //    part of the change makes the whole finding the change's business — it is
  //    one finding and cannot be half-outside.
  if (issue.uncoveredFiles !== undefined) {
    return issue.uncoveredFiles.some((f) => burn.files.has(f));
  }

  // 5. Nothing to attribute it by.
  return true;
}

/** Split the run's issues. Pure — every fact it needs is already resolved. */
export function splitIssuesByScope(
  issues: CheckIssue[],
  graph: Graph,
  burn: BurnSet,
  pairs: ExpectedPair[],
): ProgressiveSplit {
  if (burn.global) return { inScope: issues.length, outside: 0, global: true };
  const known = knownPairKeys(pairs);
  let inScope = 0;
  for (const issue of issues) {
    if (issueIsInScope(issue, graph, burn, known)) inScope++;
  }
  return { inScope, outside: issues.length - inScope, global: false };
}

/**
 * The sentence. It states a ratio, names the reference it was measured against,
 * and says plainly that nothing about the build changed because of it — a number
 * that looks like a gate but is not one would be worse than no number at all.
 *
 * Deliberately NOT reported here: how many files the change touched. A change
 * can reach rules through inputs that are not themselves counted as changed
 * files, so a file count printed beside this ratio would invite the reading
 * "nothing changed, therefore nothing is in scope", which can be false.
 */
export function renderProgressiveViewLine(split: ProgressiveSplit, reference: string): string {
  // The denominator is derived from the split rather than passed alongside it:
  // the two halves ARE the whole report by construction, and a separately
  // supplied total is a number that can disagree with them.
  const total = split.inScope + split.outside;
  const outside = split.global
    ? '0 outside; this change reaches the whole graph'
    : `${split.outside} outside`;
  return `progressive view: ${split.inScope} of ${total} issue(s) within scope of ${reference} (${outside}) — gate unchanged in this build`;
}

/**
 * Every pair key that HELD a committed verdict at the reference, read from the
 * committed reviewer lock as it stood there.
 *
 * `null` means "could not be read", and a caller MUST treat that as a reason to
 * print nothing rather than as an empty set. The two are not interchangeable: an
 * empty set is the positive claim "the reference held no verdicts", which
 * switches OFF the check that notices a change deleting verdicts outright. Only
 * ONE situation earns that claim — the file was genuinely not there at the
 * reference — and only because that absence can be proven.
 *
 * Proving it takes a second question. Reading the file back EMPTY does not prove
 * it: a path that is absent at the reference and a path that is present there as
 * a zero-byte or whitespace-only blob both read back as the empty string, and
 * the second is a truncated or emptied verdict record — precisely the change
 * this row exists to notice. So an empty read asks the reference's tree whether
 * the path was there at all, and anything short of a confirmed absence declines
 * to answer.
 *
 * Only the committed file is read. Deterministic verdicts live in a gitignored
 * local cache, so reading those too would make a cold clone look like a change
 * that deleted every verdict in the repository.
 */
async function readBaseVerdictPairKeys(
  projectRoot: string,
  mergeBase: string,
): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await getFileAtRef(projectRoot, mergeBase, COMMITTED_LOCK_FILE);
  } catch (error) {
    debugWrite(`[progressive] committed lock unreadable at the reference: ${String(error)}`);
    return null;
  }
  if (text.trim() === '') {
    // Empty content is ambiguous — see this function's doc. A CONFIRMED absence
    // is the only reading that earns the empty set; a present-but-empty record
    // (and a probe that could not answer) falls back instead.
    const present = await pathExistsAtRef(projectRoot, mergeBase, COMMITTED_LOCK_FILE);
    if (present === false) return new Set();
    debugWrite(
      `[progressive] committed lock at the reference read back empty and could not be confirmed absent (present=${String(present)})`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    debugWrite(`[progressive] committed lock at the reference is not readable JSON: ${String(error)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (verdicts === null || typeof verdicts !== 'object' || Array.isArray(verdicts)) return null;
  const keys = new Set<string>();
  for (const [aspectId, units] of Object.entries(verdicts as Record<string, unknown>)) {
    if (units === null || typeof units !== 'object' || Array.isArray(units)) return null;
    for (const unitKey of Object.keys(units as Record<string, unknown>)) {
      keys.add(progressivePairKey(aspectId, unitKey));
    }
  }
  return keys;
}

/**
 * Did the part of the configuration that changes what the graph MEANS move
 * between the reference and here? Fails closed: a text that cannot be obtained
 * on either side answers "yes", which reads the run as reaching the whole graph
 * rather than guessing that nothing moved.
 */
async function didConfigVocabularyMove(projectRoot: string, mergeBase: string): Promise<boolean> {
  let baseText: string | null;
  try {
    const raw = await getFileAtRef(projectRoot, mergeBase, CONFIG_FILE);
    // Nothing to compare against — the file was absent at the reference, or was
    // there and empty. Unlike the verdict record above, the two need no telling
    // apart here: both make every key in the current file new to the reference,
    // and both therefore fall the same, safe way.
    baseText = raw.trim() === '' ? null : raw;
  } catch {
    baseText = null;
  }
  let headText: string;
  try {
    headText = await readFile(path.join(projectRoot, CONFIG_FILE), 'utf-8');
  } catch {
    return true;
  }
  return configVocabularyChanged(baseText, headText);
}

/**
 * The type-level classification this run's pair universe depends on, when the
 * repository opted into it. Absent otherwise — which is also exactly the shape
 * enumeration had before that tier existed.
 *
 * The statically-resolved import edges are deliberately NOT resolved here: that
 * is a full parse of every mapped source file, and this is one informational
 * line. Their only effect is on rules whose applicability is written in terms of
 * a file's real dependencies; where such a rule exists, its pair may be missing
 * from this enumeration, and the conservative direction (an unknown pair counts
 * as in scope) keeps that a pessimistic count rather than a false "outside".
 */
async function resolveTypeCoverage(
  graph: Graph,
  coverageVisibleFiles: string[],
): Promise<TypeCoverageInput | undefined> {
  if (graph.config.coverage?.typeLevel !== true) return undefined;
  const uncovered = scanUncoveredFiles(graph, coverageVisibleFiles);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/**
 * Does a submodule pointer appear among the changed paths?
 *
 * The preflight table's field is a plain boolean because the row it feeds is a
 * refusal — there is no third answer that table could act on. So this collapses
 * three inputs into two answers, and it collapses them AWAY from reassurance:
 * a run that could not enumerate the repository's submodule pointers, or could
 * not enumerate its own changed paths, reports the blocking value. Answering
 * `false` there would be claiming "no submodule here" on the strength of not
 * having looked, and a pointer to another repository's commit is exactly the
 * thing path-based scoping cannot reason about.
 *
 * (A missing changed-path set is separately, and more precisely, refused by the
 * table's own earlier row, so that half never decides an outcome on its own —
 * it is written this way to keep the rule one rule rather than two.)
 */
export function resolveSubmoduleGitlinkInDiff(
  gitlinks: Set<string> | null,
  touched: ChangedFiles | null,
): boolean {
  if (gitlinks === null || touched === null) return true;
  for (const file of touched.files) {
    if (gitlinks.has(file)) return true;
  }
  return false;
}

/**
 * Is git's work-tree top level the same directory the graph's paths are relative
 * to? Compared in POSIX form, and against the resolved form too: git reports the
 * real directory, while the project root can arrive through a symlinked parent
 * (a temp directory on many systems), and reading those two spellings of one
 * directory as a mismatch would decline to scope a perfectly ordinary
 * repository.
 */
function toplevelMatchesProjectRoot(toplevel: string, projectRoot: string): boolean {
  if (toplevel === toPosixPath(projectRoot)) return true;
  try {
    return toplevel === toPosixPath(realpathSync(projectRoot));
  } catch {
    return false;
  }
}

/** Resolve every git fact the preflight table decides over. */
async function probeProgressiveState(
  projectRoot: string,
  reference: string,
  fullFlag: boolean,
): Promise<{ probes: PreflightProbes; mergeBase: string | null }> {
  const mergeBase = await getMergeBase(projectRoot, 'HEAD', reference).catch(() => null);
  const [isAncestorHeadRef, worktreeClean, shallow, toplevel] = await Promise.all([
    isAncestor(projectRoot, 'HEAD', reference),
    hasCleanWorktree(projectRoot),
    isShallowRepository(projectRoot),
    getToplevelAndPrefix(projectRoot),
  ]);
  const [treesIdenticalHeadMb, touched, gitlinks] =
    mergeBase === null
      ? ([null, null, null] as const)
      : await Promise.all([
          treesIdentical(projectRoot, 'HEAD', mergeBase),
          changedFilesAgainst(projectRoot, mergeBase),
          gitlinkPaths(projectRoot, mergeBase),
        ]);

  return {
    mergeBase,
    probes: {
      configReference: reference,
      fullFlag,
      mergeBase,
      isAncestorHeadRef,
      worktreeClean,
      treesIdenticalHeadMb,
      touched,
      toplevelMatchesProjectRoot:
        toplevel === null ? null : toplevelMatchesProjectRoot(toplevel.toplevel, projectRoot),
      shallow,
      submoduleGitlinkInDiff: resolveSubmoduleGitlinkInDiff(gitlinks, touched),
    },
  };
}

/** The whole measurement, once the reference is known to exist. */
async function measure(input: ProgressiveViewInput, reference: string): Promise<string | null> {
  const { graph, projectRoot, coverageVisibleFiles, fullFlag, issues } = input;

  const { probes, mergeBase } = await probeProgressiveState(projectRoot, reference, fullFlag);
  const state = resolveProgressiveState(probes);
  if (state.mode !== 'scoped' && state.mode !== 'honest-empty') return null;
  // Both remaining modes have a merge-base and a touched set by construction;
  // narrowing here keeps that a checked fact rather than an asserted one.
  if (mergeBase === null || probes.touched === null) return null;

  // An unreadable committed lock at the reference is NOT an empty one — see
  // readBaseVerdictPairKeys. Nothing honest can be said without it.
  const baseVerdictPairKeys = await readBaseVerdictPairKeys(projectRoot, mergeBase);
  if (baseVerdictPairKeys === null) return null;

  const typeCoverage = await resolveTypeCoverage(graph, coverageVisibleFiles);
  const { pairs } = await computeExpectedPairs(graph, { typeCoverage });

  const lock = readLock(graph.rootPath);
  const touchedListsByPairKey = new Map<string, Array<[string, string]>>();
  for (const pair of pairs) {
    const entry = lock.verdicts[pair.aspectId]?.[pair.unitKey];
    // PRESENT-with-an-empty-list and ABSENT mean different things to the burn
    // table: a stored verdict that observed nothing is warm, no stored verdict
    // at all is cold. Set the key only when an entry really exists.
    if (entry !== undefined) {
      touchedListsByPairKey.set(progressivePairKey(pair.aspectId, pair.unitKey), entry.touched ?? []);
    }
  }

  const burn = computeBurnSet({
    touched: probes.touched.files,
    graph,
    pairs,
    touchedListsByPairKey,
    baseVerdictPairKeys,
    configVocabularyChanged: await didConfigVocabularyMove(projectRoot, mergeBase),
  });

  return renderProgressiveViewLine(splitIssuesByScope(issues, graph, burn, pairs), reference);
}

/**
 * The line to print above the report, or `null` when there is nothing honest to
 * say — which covers all of: no reference configured, `--full`, a state the
 * preflight table declines to scope from, and any failure while gathering the
 * inputs. Printing nothing is always a safe outcome: the report and the exit
 * code are produced entirely without this.
 */
export async function buildProgressiveViewLine(input: ProgressiveViewInput): Promise<string | null> {
  const reference = input.graph.config.progressive?.reference;

  // The two rows that need no probe at all, answered by the SAME table that
  // answers every other row — the table's contract is that both are reachable
  // with every probe still at its zero value, so asking it here costs nothing
  // and keeps the doctrine in one place instead of duplicating two conditions.
  const withoutProbes = resolveProgressiveState({
    configReference: reference,
    fullFlag: input.fullFlag,
    mergeBase: null,
    isAncestorHeadRef: null,
    worktreeClean: null,
    treesIdenticalHeadMb: null,
    touched: null,
    toplevelMatchesProjectRoot: null,
    shallow: null,
    submoduleGitlinkInDiff: false,
  });
  if (withoutProbes.mode === 'off' || withoutProbes.mode === 'full') return null;

  try {
    return await measure(input, reference as string);
  } catch (error) {
    // An informational line must never be able to fail a run. Every anticipated
    // path already returns null above; this is the backstop for the ones that
    // cannot be anticipated, and it records what happened rather than
    // swallowing it silently.
    debugWrite(
      `[progressive] view line skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
