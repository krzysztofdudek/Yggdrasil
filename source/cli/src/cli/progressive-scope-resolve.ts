/**
 * source/cli/src/cli/progressive-scope-resolve.ts — resolve the CHANGE SCOPE a
 * `yg check` run gates against: which of this run's obligations the current
 * change is accountable for, measured against the reference branch the project
 * names in `yg-config.yaml`.
 *
 * ── What this module does and does not decide ───────────────────────────────
 * It answers exactly one question — "what did this change reach?" — and hands
 * the answer to the engine as plain data. It does NOT decide what any single
 * finding's severity becomes: that is one ladder, in core/check-progressive.ts,
 * and it is deliberately the only one. This module once carried a second,
 * simplified copy of that ladder for an informational preview line; the two
 * could disagree about the same finding, so the preview and its copy are gone.
 * Nothing here reads a finding at all.
 *
 * ── The guarantee that outranks everything else here ────────────────────────
 * With no reference configured, this module must be indistinguishable from not
 * existing: no git process, no file read, no output, no cost, and above all no
 * change to what the run gates. That is why {@link resolveChangeScope} asks the
 * preflight table whether there is anything to do at all BEFORE any probe runs.
 *
 * ── Which way every uncertainty falls ───────────────────────────────────────
 * Toward gating MORE. A state this module cannot resolve honestly does not
 * quietly become an empty scope — an empty scope is the positive claim "this
 * change reached nothing", which would downgrade every finding in the report.
 * It becomes the whole-project gate plus a notice naming the cause, which is
 * the same answer `yg check` gave before progressive mode existed.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Graph } from '../model/graph.js';
import { LOCK_NONDET_FILE_NAME } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { computeExpectedPairs, type TypeCoverageInput } from '../core/pairs.js';
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

export interface ChangeScopeInput {
  graph: Graph;
  /** The directory the graph's paths are relative to — and, for a scoped run, the git top level. */
  projectRoot: string;
  /** The disk walk the command already performed, reused for the type-level lattice. */
  coverageVisibleFiles: string[];
  /** Whether the whole project was explicitly demanded on this invocation. */
  fullFlag: boolean;
}

/**
 * What the command should gate this run against.
 *
 * `whole-project` and `unmeasurable` produce the SAME gate — every obligation
 * blocks, exactly as before progressive mode existed. They are separate cases
 * because only one of them owes the person an explanation: "you never asked for
 * a measurement" and "you asked and it could not be made" are different
 * situations, and collapsing them would either explain a run nobody asked
 * anything of, or silently swallow the reason a configured project's run was
 * not scoped.
 */
export type ChangeScopeDecision =
  | { kind: 'whole-project' }
  | { kind: 'scoped'; burn: BurnSet; referenceName: string }
  | { kind: 'unmeasurable'; notice: IssueMessage };

/**
 * The notice a configured project gets when its change could not be measured.
 * `cause` is the state machine's own account of WHAT went wrong — it is the
 * `why`, never the `what`, because the person's first question is about their
 * build ("what did this run actually gate?"), not about git.
 */
function unmeasurable(reference: string, cause: string): ChangeScopeDecision {
  return {
    kind: 'unmeasurable',
    notice: {
      what: `This change could not be measured against '${reference}', so this run gated the whole project.`,
      why: cause,
      next: "Fix the cause above and re-run — or run 'yg check --full' to ask for the whole-project gate on purpose, which gives this same result without this notice.",
    },
  };
}

/**
 * Every pair key that HELD a committed verdict at the reference, read from the
 * committed reviewer lock as it stood there.
 *
 * `null` means "could not be read", and a caller MUST treat that as a reason to
 * gate the whole project rather than as an empty set. The two are not
 * interchangeable: an empty set is the positive claim "the reference held no
 * verdicts", which switches OFF the check that notices a change deleting
 * verdicts outright. Only ONE situation earns that claim — the file was
 * genuinely not there at the reference — and only because that absence can be
 * proven.
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

/** The cause reported when the record above could not be read. */
const UNREADABLE_BASE_RECORD =
  'the verdict record committed at the reference could not be read, so a change that DELETED recorded verdicts cannot be told apart from one that never had them — and the second reads as inherited debt.';

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
 * is a full parse of every mapped source file, and this runs before the check
 * that will parse them anyway. Their only effect is on rules whose applicability
 * is written in terms of a file's real dependencies; where such a rule exists,
 * its pair may be missing from this enumeration, and the conservative direction
 * (a finding naming an obligation this enumeration never saw keeps blocking)
 * keeps that a pessimistic gate rather than a false "outside".
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

/** The whole measurement, once the reference is known to be configured. */
async function measure(input: ChangeScopeInput, reference: string): Promise<ChangeScopeDecision> {
  const { graph, projectRoot, coverageVisibleFiles, fullFlag } = input;

  const { probes, mergeBase } = await probeProgressiveState(projectRoot, reference, fullFlag);
  const state = resolveProgressiveState(probes);
  if (state.mode === 'off' || state.mode === 'full') return { kind: 'whole-project' };
  if (state.mode === 'global-fallback') {
    return unmeasurable(reference, state.reason ?? 'the state could not be established.');
  }
  // Both remaining modes have a merge-base and a touched set by construction;
  // narrowing here keeps that a checked fact rather than an asserted one, and
  // the impossible case still falls the safe way.
  if (mergeBase === null || probes.touched === null) {
    return unmeasurable(reference, 'the reference point and the changed-file set did not both resolve.');
  }

  // An unreadable committed record at the reference is NOT an empty one — see
  // readBaseVerdictPairKeys. There is no honest scope without it.
  const baseVerdictPairKeys = await readBaseVerdictPairKeys(projectRoot, mergeBase);
  if (baseVerdictPairKeys === null) return unmeasurable(reference, UNREADABLE_BASE_RECORD);

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

  return { kind: 'scoped', burn, referenceName: reference };
}

/**
 * What this run should gate against.
 *
 * Returns `whole-project` — silently, and without starting a single git process
 * — for the two states that were never a measurement to begin with: a project
 * that named no reference, and a run that explicitly asked for the whole
 * project. Every other outcome is either a real scope or a refusal to guess at
 * one, and a refusal always carries the notice explaining it.
 */
export async function resolveChangeScope(input: ChangeScopeInput): Promise<ChangeScopeDecision> {
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
  if (withoutProbes.mode === 'off' || withoutProbes.mode === 'full') return { kind: 'whole-project' };

  try {
    return await measure(input, reference as string);
  } catch (error) {
    // Every anticipated path already returned above; this is the backstop for
    // the ones that cannot be anticipated. It falls the same way as all of them
    // — gate everything, say so — because the alternative (an empty scope) would
    // turn an unexpected failure into a green build.
    const detail = error instanceof Error ? error.message : String(error);
    debugWrite(`[progressive] change scope could not be resolved: ${detail}`);
    return unmeasurable(
      reference as string,
      `working out what this change reached failed unexpectedly (${detail}).`,
    );
  }
}
