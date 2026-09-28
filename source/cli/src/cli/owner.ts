import path from 'node:path';
import { access } from 'node:fs/promises';
import { Command } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Graph, OwnerResult } from '../model/graph.js';
import { normalizeProjectRelativePath, projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import type { OwnerIndex } from '../relations/owner-index.js';
import {
  resolveGraphExclusionSet,
  isExcludedFromGraph,
  isCoverageExcludedPath,
  describeExclusionSource,
  describeExclusionCause,
  NO_COVERAGE_EXCLUDED,
  walkRepoFiles,
} from '../io/repo-scanner.js';
import type { GraphExclusionSet } from '../io/repo-scanner.js';
import { classifySingleFileCached, computeTypeCoverageCached, singleFileClassifierCached, type SingleFileClassification } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { computeExpectedPairs } from '../core/pairs.js';
import { computeTypeAspectCascade } from '../core/type-effective.js';
import { describeCascadeCycle } from '../formatters/type-visibility-text.js';
import { unverifiedVerdictCaveat } from '../core/type-visibility.js';
import { verifyPairs } from '../core/verify-lock.js';
import { readLock } from '../io/lock-store.js';
import { scanUncoveredFiles } from '../core/check.js';
import { runProjectRelationPass } from '../relations/pass.js';
import type { TypedEdgeIndex } from '../relations/pass.js';
import { writeOut, count, failAndExit } from './output.js';
import { findCandidateOwners } from '../core/graph/files.js';

function normalizeForMatch(inputPath: string): string {
  return toPosixPath(inputPath.trim());
}

/**
 * `index`, when given, is used as-is instead of a fresh `buildOwnerIndex` —
 * `resolveOwnersBatch` below builds it once and passes it to every file in a
 * `yg owner --files` run, instead of rebuilding the same node → mapping index
 * per file. Every existing caller omits it and gets the original behavior.
 */
export function findOwner(graph: Graph, projectRoot: string, rawPath: string, index?: OwnerIndex): OwnerResult {
  const file = normalizeForMatch(normalizeProjectRelativePath(projectRoot, rawPath));

  // Node selection comes from the canonical hierarchy-first resolver so `yg
  // owner` / `yg context --file` / `yg impact --file` name the SAME node the
  // gate verifies the file under (a descendant wins even when it maps a
  // shorter/broader pattern than its ancestor). The presentation fields are
  // derived from the winning entry's kind: 'exact' and 'glob' both render as a
  // direct mapping; 'directory' renders as coverage via an ancestor directory.
  const entry = (index ?? buildOwnerIndex(graph.nodes)).ownerEntryOf(file);
  if (!entry) return { file, nodePath: null };

  return { file, nodePath: entry.nodePath, mappingPath: entry.mapping, direct: entry.kind !== 'directory' };
}

/**
 * `findOwner`, then override its verdict when the resolved file is excluded
 * from the graph — a separate project's own boundary (a nested `.yggdrasil/`
 * graph, or a nested `.git` checkout/submodule/worktree), or a
 * `coverage.excluded` root an adopter configured — regardless of whether the
 * winning mapping entry SWEPT the file in (`directory` or `glob` kind) or
 * NAMES it exactly (`exact` kind): exclusion cuts everything it matches, with
 * no carve-out for an explicit claim. `findOwner` matches mapping TEXT only —
 * it has no filesystem or config awareness — so a mapping entry of any kind
 * can textually "own" a file that `expandMappingPathsWithinOwnGraph` (the
 * guard every enforcement, billing, and read-allowance path already applies)
 * would never hand the node. Reports an excluded file as having no owner,
 * same as a genuinely unmapped one: every caller below goes on to say so
 * honestly ("no graph coverage" for a truly unmapped path, "excluded from
 * graph coverage by design" for this one), instead of naming a node whose
 * rules never actually run against it.
 *
 * Every command that answers an ownership or cost question for ONE file goes
 * through this wrapper, never the raw `findOwner`: `yg owner --file`, `yg
 * context --file`, `yg impact --file` (its blast-radius/cost estimate is
 * meaningless for a file nothing enforces), and `aspect-test.ts`'s ownership
 * pre-check (deciding whether `--file` should refuse with "has a component of
 * its own"). `findOwner` itself stays the pure, synchronous, text-only
 * resolver this wrapper is built on — exported only because its own
 * tie-break behavior (which node wins when two mappings match equally) is
 * unit-tested directly against it, not because any other production caller
 * needs the unguarded answer.
 *
 * `opts.index` and `opts.exclusion`, when given, replace the fresh
 * `buildOwnerIndex` / `resolveGraphExclusionSet` this function would
 * otherwise compute — `resolveOwnersBatch` shares one of each across a whole
 * `yg owner --files` run instead of paying for them per file. Every existing
 * caller omits `opts` and gets the original per-call behavior.
 */
export async function findOwnerWithinOwnGraph(
  graph: Graph,
  projectRoot: string,
  rawPath: string,
  opts?: { index?: OwnerIndex; exclusion?: GraphExclusionSet },
): Promise<OwnerResult> {
  const result = findOwner(graph, projectRoot, rawPath, opts?.index);
  if (!result.nodePath) return result;
  const exclusion = opts?.exclusion ?? await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  if (isExcludedFromGraph(result.file, exclusion)) {
    return { file: result.file, nodePath: null };
  }
  return result;
}

/**
 * The live type-relation gate's edge index for one `yg owner --file`
 * invocation, computed ONCE — never per file, never per aspect. Classifies
 * every uncovered file in the repo (not just the one being queried) so the
 * relation pass can recognize an import reaching ANY type-covered file as
 * such, seeds the SAME pass with that classification, and returns its
 * `typedEdges`. Without this, a `relations:` atom on the queried file's
 * attached rules would read the conservative always-false a caller with no
 * edge index falls back to, even though `yg check` — which classifies and
 * resolves the same way — would answer differently.
 */
async function computeRelationEdgesForOwner(graph: Graph, projectRoot: string): Promise<TypedEdgeIndex> {
  const repoFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, repoFiles);
  const typeCoverage = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  const relResult = await runProjectRelationPass(graph, projectRoot, typeCoverage.covered);
  return relResult.typedEdges;
}

/** Schema id of `yg owner --json`. */
const OWNER_JSON_SCHEMA = 'yg-owner/1';

/** Who owns a file, as `yg owner --json` reports it. */
export interface OwnerJsonDocument {
  schema: typeof OWNER_JSON_SCHEMA;
  file: string;
  /**
   * `node`: a component maps it; `type`: its architecture type alone covers it;
   * `unmapped`: it exists and nothing covers it; `missing`: no such file;
   * `excluded`: coverage never looks at it, by design.
   */
  kind: 'node' | 'type' | 'unmapped' | 'missing' | 'excluded';
  node: string | null;
  type: string | null;
  /** For a node owner: whether a mapping names the file itself (false: an ancestor directory does). */
  direct: boolean | null;
  mappingPath: string | null;
  /** For a type owner: whether any of the type's rules apply to the file. */
  enforced: boolean | null;
  excludedBecause: string | null;
  /**
   * For an unmapped file: the components that map other files in its
   * directory, most first — the likely owners to add it to (empty when none
   * does, and for every other kind). Added in 6.1.0.
   */
  candidates: Array<{ node: string; sameDirEntries: number }>;
  /** The command that shows the file's rules, when there is one. */
  next: string | null;
}

const EMPTY_OWNER: Omit<OwnerJsonDocument, 'schema' | 'file' | 'kind'> = {
  node: null, type: null, direct: null, mappingPath: null, enforced: null, excludedBecause: null, candidates: [], next: null,
};

/** Schema id of `yg owner --files --json`. */
const OWNER_BATCH_JSON_SCHEMA = 'yg-owner-batch/1';

/**
 * One file's answer within `yg owner --files --json` — the same facts as a
 * single `yg-owner/1` document, minus the two that cost a whole-repo relation
 * pass to compute (`enforced`) or exist only to steer a human reader to a
 * next command (`next`): a batch answers many files at once and is meant for
 * a program, not a terminal. `unit` is the one field a single-file answer
 * never carries — the grouping key a territory resolver (Horde, 447) needs: a
 * node's own path, or `type:<id>@<top-level directory>` for a file no node
 * maps but an architecture type alone covers (§8 of the family vision
 * design). Everything else answers null — there is nothing to group an
 * unmapped, missing, excluded or invalid file under.
 */
export interface OwnerBatchEntry {
  file: string;
  /** Same five kinds as `yg-owner/1`, plus `invalid` for a path this batch could not resolve at all (e.g. it names something outside the project root) — a batch never aborts on one bad entry the way `yg owner --file` aborts the whole run. */
  kind: 'node' | 'type' | 'unmapped' | 'missing' | 'excluded' | 'invalid';
  node: string | null;
  type: string | null;
  unit: string | null;
  direct: boolean | null;
  mappingPath: string | null;
  excludedBecause: string | null;
  candidates: Array<{ node: string; sameDirEntries: number }>;
  /** Set only for kind 'invalid': why the path could not be resolved. */
  error: string | null;
}

/** The whole `yg owner --files --json` document: one entry per input file, in input order — duplicates in the input produce duplicate entries. */
export interface OwnerBatchJsonDocument {
  schema: typeof OWNER_BATCH_JSON_SCHEMA;
  files: OwnerBatchEntry[];
}

const EMPTY_BATCH_ENTRY: Omit<OwnerBatchEntry, 'file' | 'kind'> = {
  node: null, type: null, unit: null, direct: null, mappingPath: null, excludedBecause: null, candidates: [], error: null,
};

/** The first path segment of a repo-relative file, or `.` for a file directly at the repository root — the "top-level directory" half of a type unit (`type:<id>@<top-level dir>`). */
function topLevelDirOf(file: string): string {
  const slash = file.indexOf('/');
  return slash === -1 ? '.' : file.slice(0, slash);
}

/** Shared, per-batch state `resolveOwnersBatch` computes once and every file in the batch reuses — the whole point of the batch form over N separate `yg owner --file` runs. */
interface OwnerBatchContext {
  index: OwnerIndex;
  exclusion: GraphExclusionSet;
  typeLevel: boolean;
  /** Classifies one file by type, through one type-class cache for the whole batch. */
  classify: (file: string) => Promise<SingleFileClassification>;
}

/**
 * Resolve one already-repo-relative file against the shared batch context —
 * the same disjunction `yg owner --file` applies in the same order
 * (structurally-exempt path, then a configured exclusion, then type-level
 * coverage, then plain existence), but answering the leaner batch shape:
 * never the whole-repo relation pass, never a lock read, so a type-covered
 * entry's `type` and `unit` are always populated but its enforcement is not
 * — `yg owner --file --json` is where a caller pays that cost, for one file.
 * Nor does it stop at an aspect `implies` cycle as `--file` does: the cycle
 * only blocks resolving the file's rules, never its owner, and `yg check`
 * reports it.
 */
async function resolveOneOwnerForBatch(graph: Graph, repoRoot: string, file: string, ctx: OwnerBatchContext): Promise<OwnerBatchEntry> {
  const raw = findOwner(graph, repoRoot, file, ctx.index);
  const nodeExcluded = raw.nodePath !== null && isExcludedFromGraph(raw.file, ctx.exclusion);

  if (raw.nodePath && !nodeExcluded) {
    return {
      file: raw.file, kind: 'node', ...EMPTY_BATCH_ENTRY,
      node: raw.nodePath, unit: raw.nodePath,
      direct: raw.direct !== false, mappingPath: raw.mappingPath ?? null,
    };
  }

  const absPath = path.resolve(repoRoot, raw.file);
  let exists = true;
  try { await access(absPath); } catch (e: unknown) { debugWrite(`[owner --files] access check failed for ${raw.file}: ${e instanceof Error ? e.message : String(e)}`); exists = false; }

  if (isCoverageExcludedPath(raw.file)) {
    return { file: raw.file, kind: 'excluded', ...EMPTY_BATCH_ENTRY, excludedBecause: "it sits inside git internals or the graph's own .yggdrasil/ directory" };
  }
  if (isExcludedFromGraph(raw.file, ctx.exclusion)) {
    const cause = describeExclusionCause(describeExclusionSource(raw.file, ctx.exclusion)!);
    return { file: raw.file, kind: 'excluded', ...EMPTY_BATCH_ENTRY, excludedBecause: cause };
  }
  if (exists && ctx.typeLevel) {
    const classification = await ctx.classify(raw.file);
    if (classification.bucket === 'covered') {
      return {
        file: raw.file, kind: 'type', ...EMPTY_BATCH_ENTRY,
        type: classification.typeId, unit: `type:${classification.typeId}@${topLevelDirOf(raw.file)}`,
      };
    }
  }
  if (exists) {
    const candidates = findCandidateOwners(graph, raw.file);
    return {
      file: raw.file, kind: 'unmapped', ...EMPTY_BATCH_ENTRY,
      candidates: candidates.map((c) => ({ node: c.nodePath, sameDirEntries: c.fileCount })),
    };
  }
  return { file: raw.file, kind: 'missing', ...EMPTY_BATCH_ENTRY };
}

/**
 * `yg owner --files`'s engine: resolve ownership for a whole list of files
 * against ONE loaded graph — one `buildOwnerIndex`, one
 * `resolveGraphExclusionSet`, one `FileContentCache` and one type-class
 * cache, all built here and
 * shared across every file, instead of the graph load and index build that N
 * separate `yg owner --file` invocations would each pay for again. This is
 * the resolver a territory computation (Horde, issue 447 / the family vision
 * design §8) calls in bulk: the `unit` on each entry is what it groups files
 * by.
 *
 * Deliberately lighter than the single-file JSON answer — see
 * `resolveOneOwnerForBatch`'s doc for exactly what it does not compute and
 * why. A file whose path cannot be resolved at all (outside the project
 * root, or empty) becomes an `invalid` entry with `error` set, rather than
 * aborting every other file's answer.
 */
async function resolveOwnersBatch(graph: Graph, repoRoot: string, rawFiles: readonly string[]): Promise<OwnerBatchEntry[]> {
  const ctx: OwnerBatchContext = {
    index: buildOwnerIndex(graph.nodes),
    exclusion: await resolveGraphExclusionSet(repoRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED),
    typeLevel: graph.config.coverage?.typeLevel === true,
    classify: singleFileClassifierCached(graph, new FileContentCache()),
  };

  const entries: OwnerBatchEntry[] = [];
  for (const rawFile of rawFiles) {
    try {
      const repoRelative = resolveFileArg(repoRoot, rawFile);
      entries.push(await resolveOneOwnerForBatch(graph, repoRoot, repoRelative, ctx));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugWrite(`[owner --files] ${rawFile}: ${msg}`);
      entries.push({
        file: toPosixPath(rawFile.trim()), kind: 'invalid', ...EMPTY_BATCH_ENTRY,
        error: msg,
      });
    }
  }
  return entries;
}

/**
 * `--files`'s value: a comma-separated list, or standard input — one path per
 * line — when the value is `-` (the same convention `yg advise import -`
 * already uses for "read the document from stdin"). Blank lines and
 * surrounding whitespace are dropped either way, and so is a byte-order mark
 * at the start of standard input.
 */
async function readBatchFileList(filesOption: string): Promise<string[]> {
  if (filesOption === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    // A list saved by a Windows editor can open with a UTF-8 byte-order mark;
    // it is not part of the first path.
    return Buffer.concat(chunks).toString('utf-8').replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return filesOption.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The plain-text line for one batch entry — `yg owner --files` without `--json`. */
function batchEntryLine(entry: OwnerBatchEntry): string {
  switch (entry.kind) {
    case 'node': return `${entry.file} -> ${entry.node}`;
    case 'type': return `${entry.file} -> ${entry.unit}`;
    case 'excluded': return `${entry.file} -> (excluded from graph coverage: ${entry.excludedBecause})`;
    case 'invalid': return `${entry.file} -> (could not be resolved: ${entry.error})`;
    case 'missing': return `${entry.file} -> (no graph coverage: file not found)`;
    case 'unmapped': return `${entry.file} -> (no graph coverage)`;
  }
}

async function runOwnerBatch(filesOption: string, json: boolean): Promise<void> {
  const rawFiles = await readBatchFileList(filesOption);
  if (rawFiles.length === 0) {
    failAndExit({
      what: '--files named no file.',
      why: 'yg owner --files resolves ownership for a list of files, and the list — or standard input, with --files - — was empty.',
      next: 'Pass a comma-separated list (yg owner --files a.ts,b.ts) or pipe newline-separated paths in with --files -.',
    }, 'usage');
  }
  const graph = await loadGraphOrAbort(process.cwd());
  initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
  const repoRoot = projectRootFromGraph(graph.rootPath);
  const entries = await resolveOwnersBatch(graph, repoRoot, rawFiles);
  if (json) {
    writeOut(`${JSON.stringify({ schema: OWNER_BATCH_JSON_SCHEMA, files: entries }, null, 2)}\n`);
    return;
  }
  writeOut(`${entries.map(batchEntryLine).join('\n')}\n`);
}

export function registerOwnerCommand(program: Command): void {
  program
    .command('owner')
    .description('Find which graph node owns a source file')
    .option('--file <path>', 'File path (relative to repository root)')
    .option(
      '--files <list>',
      'Batch form: a comma-separated list of file paths, or "-" to read them one per line from standard input. ' +
        'Resolves the whole list against one loaded graph and prints a yg-owner-batch/1 document under --json ' +
        "(plain text otherwise) — for a caller that needs many files at once, " +
        'never --file in a loop.',
    )
    .option('--json', 'Print the answer as a yg-owner/1 JSON document (yg-owner-batch/1 with --files)')
    .action(async (options: { file?: string; files?: string; json?: boolean }) => {
      try {
        if (options.file && options.files) {
          failAndExit({
            what: '--file and --files cannot be used together.',
            why: 'yg owner answers about one file with --file, or a whole list at once with --files — never both in the same run.',
            next: 'Re-run with only one of --file or --files.',
          }, 'usage');
        }
        if (options.files !== undefined) {
          await runOwnerBatch(options.files, options.json === true);
          return;
        }
        // One answer, two forms: the text a person reads, or the yg-owner/1
        // document — the same facts, so a consumer never parses the sentence.
        const answer = (doc: Omit<OwnerJsonDocument, 'schema'>, text: string): void => {
          writeOut(options.json === true ? `${JSON.stringify({ schema: OWNER_JSON_SCHEMA, ...doc }, null, 2)}\n` : text);
        };
        if (!options.file) {
          // Emit a structured what/why/next error instead of Commander's bare
          // "required option not specified" line.
          failAndExit({
                what: '--file is required.',
                why: 'yg owner resolves which graph node owns a specific source file, so it needs that file path.',
                next: 'Re-run as: yg owner --file <path>',
              }, 'usage');
        }
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const repoRoot = projectRootFromGraph(graph.rootPath);
        const repoRelative = resolveFileArg(repoRoot, options.file);
        const result = await findOwnerWithinOwnGraph(graph, repoRoot, repoRelative);

        if (!result.nodePath) {
          // Distinguish "file doesn't exist" from "file exists but not mapped"
          const absPath = path.resolve(repoRoot, result.file);
          let exists = true;
          try { await access(absPath); } catch (e: unknown) { debugWrite(`[owner] access check failed: ${e instanceof Error ? e.message : String(e)}`); exists = false; }
          // A typed answer, not "no graph coverage": a structurally exempt path
          // (isCoverageExcludedPath — under .yggdrasil/, or a .git segment) is
          // never a classification candidate — the ordinary coverage walk never
          // enumerates it, so classifyFile would never see it either. A path
          // excluded by the one supreme filter (isExcludedFromGraph — a nested-
          // project boundary or a coverage.excluded root) stays exempt too. Both
          // fall through to the plain message below regardless of the flag.
          const coverage = graph.config.coverage;
          const exclusionSet = await resolveGraphExclusionSet(repoRoot, coverage ?? NO_COVERAGE_EXCLUDED);
          const typeMatch = exists && coverage?.typeLevel
              && !isCoverageExcludedPath(result.file) && !isExcludedFromGraph(result.file, exclusionSet)
            ? await classifySingleFileCached(graph, result.file, new FileContentCache())
            : undefined;
          if (isCoverageExcludedPath(result.file)) {
            // Same fact `yg context --file` already reports for the identical
            // path, in the same words: an excluded file is gone from this
            // graph's coverage, not "unmapped" — advising the adopter to add
            // it to a node's mapping would send them to write a mapping entry
            // that `file-mapping-excluded` immediately refuses, a contradiction
            // between the two commands' NEXT lines that this branch removes by
            // answering the truth up front instead of falling into the generic
            // unmapped message below. This structural exemption (git internals,
            // or the graph's own directory) is unconditional — it has nothing to
            // do with an adopter's config, so it is named on its own rather than
            // folded into the config-driven disjunction below.
            answer(
              { ...EMPTY_OWNER, file: result.file, kind: 'excluded', excludedBecause: "it sits inside git internals or the graph's own .yggdrasil/ directory" },
              buildIssueMessage({
                what: `${result.file} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because it sits inside git internals or the graph's own .yggdrasil/ directory, so it cannot and need not be mapped to a node here.`,
                // A result, not a finding: nothing to do, so no next: line.
                next: '',
              }) + '\n',
            );
          } else if (isExcludedFromGraph(result.file, exclusionSet)) {
            // Names WHICH of the two independent config/filesystem-derived
            // sources caused this — the same distinction `yg type-suggest
            // --file` and `file-mapping-excluded` already draw — instead of
            // asking the reader to check both against their own config and
            // their own filesystem. `describeExclusionSource` cannot return
            // null here: `isExcludedFromGraph` just confirmed this path is
            // excluded by one of exactly the two sources it covers.
            const cause = describeExclusionCause(describeExclusionSource(result.file, exclusionSet)!);
            answer(
              { ...EMPTY_OWNER, file: result.file, kind: 'excluded', excludedBecause: cause },
              buildIssueMessage({
                what: `${result.file} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because ${cause}, so it cannot and need not be mapped to a node here.`,
                // A result, not a finding: nothing to do, so no next: line.
                next: '',
              }) + '\n',
            );
          } else if (typeMatch?.bucket === 'covered') {
            // Run the relation pass exactly once for this invocation — its
            // typed-edge index is threaded into BOTH the cycle pre-check below
            // and this file's own type-coverage input, so a `relations:` atom
            // in an aspect's `when:` is answered from the SAME real,
            // statically-resolved imports `yg check` enforces against, not the
            // conservative always-false a caller with no edge index falls
            // back to.
            const edges = await computeRelationEdgesForOwner(graph, repoRoot);
            // An aspect `implies` cycle reachable from this type stops the
            // cascade before it can decide what applies — computeTypeAspectCascade
            // absorbs the cycle into a `cycle` marker rather than an empty
            // "nothing applies" result (see its own doc). Say so plainly,
            // naming the cycle, instead of computing hasEnforcement below and
            // reporting the file as covered with zero enforcement, which would
            // be false: the type's rules were never resolved, not
            // resolved-and-absent. yg check's own static aspect-implies-cycle
            // error is unaffected — it still fires and still blocks, on its
            // own separate path. Shares its wording with yg context --file's
            // identical check (and yg check's own report of the same fact)
            // via describeCascadeCycle, so the surfaces cannot disagree.
            const cascadeCycle = computeTypeAspectCascade(graph, result.file, typeMatch.typeId, edges).cycle;
            if (cascadeCycle) {
              failAndExit({
                what: `${result.file} matches type '${typeMatch.typeId}', but its rules could not be worked out.`,
                why: describeCascadeCycle(cascadeCycle),
                next: `Run yg check to see the blocking aspect-implies-cycle error, then remove one implies edge in .yggdrasil/aspects/. This file's rules cannot be evaluated until the cycle is fixed.`,
              }, 'command-error');
            }
            // Enumerates pairs scoped to THIS ONE FILE (a single-entry covered
            // map), never the whole-repo classification map, for the pairs
            // themselves — mirrors build-context.ts's own typed-file path. The
            // relation-edge index above is a SEPARATE, wider computation (the
            // whole repo, so an import into any other type-covered file
            // resolves correctly) threaded in here only for `edges`.
            const typeCoverageInput = { covered: new Map([[result.file, typeMatch.typeId]]), ambiguousPaths: [], edges };
            const { pairs } = await computeExpectedPairs(graph, { typeCoverage: typeCoverageInput });
            const nodelessPairs = pairs.filter((p) => p.nodePath === undefined);
            const hasEnforcement = nodelessPairs.length > 0;
            // Architecture-level "enforced" is not "verified" — name how many
            // of this file's own rules the lock does NOT currently hold a
            // valid verdict for. Runs the exact same per-pair verification
            // `yg check` performs (core/verify-lock.ts#verifyPairs, scoped to
            // just these few pairs — cheap on top of the whole-project pair
            // walk above, never a second one), so a stale entry (this file
            // edited since the verdict was recorded) counts here exactly as
            // it would in `yg check`'s own qualified "N unverified" wording,
            // not only a pair the lock has never seen at all. A garbled lock
            // is `yg check`'s own error to report — this command still
            // answers the ownership question, just without the caveat,
            // rather than failing an unrelated query.
            let caveat = '';
            if (hasEnforcement) {
              try {
                const verified = await verifyPairs(graph, readLock(graph.rootPath), nodelessPairs, typeCoverageInput);
                caveat = unverifiedVerdictCaveat(
                  verified.map((vp) => ({ aspectId: vp.pair.aspectId, verified: vp.state.kind === 'verified' || vp.state.kind === 'refused' })),
                );
              } catch (e: unknown) {
                debugWrite(`[owner] lock read failed while building the unverified caveat: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            answer(
              { ...EMPTY_OWNER, file: result.file, kind: 'type', type: typeMatch.typeId, enforced: hasEnforcement, next: `yg context --file ${result.file}` },
              `${result.file} -> type:${typeMatch.typeId}\n` +
              '  ' +
                buildIssueMessage(
                  hasEnforcement
                    ? {
                        what: `Enforced by its architecture type, not by a component${caveat}.`,
                        why: 'No node maps this file; every rule its matched type attaches still applies, or is honestly reported as attached but not enforced.',
                        next: `yg context --file ${result.file}`,
                      }
                    : {
                        what: 'Covered by its architecture type, but nothing from it enforces on this file.',
                        why: 'No node maps this file, and every rule the matched type attaches is either not a per: file rule or does not apply here — the file satisfies coverage with no enforcement.',
                        next: `yg context --file ${result.file}`,
                      },
                ) +
                '\n',
            );
          } else if (exists) {
            // The likely owners, as data: the components mapping other files in
            // its directory. An unmapped file is an ordinary answer here, not an
            // error — this is the read a report's next step sends an agent to.
            const candidates = findCandidateOwners(graph, result.file);
            const listed = candidates.map((c) => `  - ${c.nodePath} (${count(c.fileCount, 'mapping entry', 'mapping entries')} in the same directory)`).join('\n');
            answer(
              {
                ...EMPTY_OWNER,
                file: result.file,
                kind: 'unmapped',
                candidates: candidates.map((c) => ({ node: c.nodePath, sameDirEntries: c.fileCount })),
                next: candidates.length > 0 ? `yg context --node ${candidates[0].nodePath}` : null,
              },
              buildIssueMessage({
                what: candidates.length > 0
                  ? `${result.file} -> no graph coverage. Candidate owners, mapping other files in its directory:\n${listed}`
                  : `${result.file} -> no graph coverage. No component maps anything in its directory.`,
                why: 'This file exists but no graph node maps it, so its code is not verified against any aspect.',
                next: candidates.length > 0
                  ? `Add '${result.file}' to the mapping of the component that owns its code (yg context --node ${candidates[0].nodePath} shows the first one), or create a node for it.`
                  : `Create a node whose mapping covers '${result.file}', or add it to an existing node's mapping — yg tree lists the nodes.`,
              }) + '\n',
            );
          } else {
            answer(
              { ...EMPTY_OWNER, file: result.file, kind: 'missing' },
              buildIssueMessage({
                what: `${result.file} -> no graph coverage (file not found)`,
                why: 'This path does not exist on disk and is not mapped by any graph node.',
                next: `Check the path for typos; once the file exists, add it to a node's mapping in yg-node.yaml.`,
              }) + '\n',
            );
          }
        } else {
          const indirect = result.direct === false && result.mappingPath;
          answer(
            {
              ...EMPTY_OWNER,
              file: result.file,
              kind: 'node',
              node: result.nodePath,
              direct: result.direct !== false,
              mappingPath: result.mappingPath ?? null,
              next: `yg context --node ${result.nodePath}`,
            },
            `${result.file} -> ${result.nodePath}\n` +
              (indirect
                ? '  ' +
                  buildIssueMessage({
                    what: 'File has no direct mapping.',
                    why: `Context comes from ancestor directory '${result.mappingPath}'.`,
                    next: `yg context --node ${result.nodePath}`,
                  }) +
                  '\n'
                : ''),
          );
        }
      } catch (error) {
        // A --file path that resolves outside the repository is USER input, not an
        // internal bug — classify it rather than routing to the crash handler.
        const msg = error instanceof Error ? error.message : String(error);
        const outsideRoot = msg.match(/^Path is outside project root: (.+)$/);
        if (outsideRoot) {
          debugWrite(`[owner] file arg outside project root: ${msg}`);
          failAndExit({
            what: `The path '${toPosixPath(outsideRoot[1])}' is outside the project root.`,
            why: `yg owner resolves ownership only for files tracked inside the project.`,
            next: 'yg owner --file <a path inside the repository, relative to its root>',
          }, 'command-error');
        }
        abortOnUnexpectedError(error, 'resolving file owner');
      }
    });
}
