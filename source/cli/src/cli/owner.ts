import path from 'node:path';
import { access } from 'node:fs/promises';
import chalk from 'chalk';
import { Command } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Graph, OwnerResult } from '../model/graph.js';
import { normalizeProjectRelativePath, projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import {
  resolveGraphExclusionSet,
  isExcludedFromGraph,
  isCoverageExcludedPath,
  describeExclusionSource,
  describeExclusionCause,
  NO_COVERAGE_EXCLUDED,
  walkRepoFiles,
} from '../io/repo-scanner.js';
import { classifySingleFileCached, computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { computeExpectedPairs } from '../core/pairs.js';
import { computeTypeAspectCascade, describeCascadeCycle } from '../core/type-effective.js';
import { unverifiedVerdictCaveat } from '../core/type-visibility.js';
import { verifyPairs } from '../core/verify-lock.js';
import { readLock } from '../io/lock-store.js';
import { scanUncoveredFiles } from '../core/check.js';
import { runProjectRelationPass } from '../relations/pass.js';
import type { TypedEdgeIndex } from '../relations/pass.js';

function normalizeForMatch(inputPath: string): string {
  return toPosixPath(inputPath.trim());
}

export function findOwner(graph: Graph, projectRoot: string, rawPath: string): OwnerResult {
  const file = normalizeForMatch(normalizeProjectRelativePath(projectRoot, rawPath));

  // Node selection comes from the canonical hierarchy-first resolver so `yg
  // owner` / `yg context --file` / `yg impact --file` name the SAME node the
  // gate verifies the file under (a descendant wins even when it maps a
  // shorter/broader pattern than its ancestor). The presentation fields are
  // derived from the winning entry's kind: 'exact' and 'glob' both render as a
  // direct mapping; 'directory' renders as coverage via an ancestor directory.
  const entry = buildOwnerIndex(graph.nodes).ownerEntryOf(file);
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
 */
export async function findOwnerWithinOwnGraph(graph: Graph, projectRoot: string, rawPath: string): Promise<OwnerResult> {
  const result = findOwner(graph, projectRoot, rawPath);
  if (!result.nodePath) return result;
  const exclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
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

export function registerOwnerCommand(program: Command): void {
  program
    .command('owner')
    .description('Find which graph node owns a source file')
    .option('--file <path>', 'File path (relative to repository root)')
    .action(async (options: { file?: string }) => {
      try {
        if (!options.file) {
          // Emit a structured what/why/next error instead of Commander's bare
          // "required option not specified" line.
          process.stderr.write(
            chalk.red(
              `Error: ${buildIssueMessage({
                what: '--file is required.',
                why: 'yg owner resolves which graph node owns a specific source file, so it needs that file path.',
                next: 'Re-run as: yg owner --file <path>',
              })}\n`,
            ),
          );
          process.exit(1);
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
            process.stdout.write(
              buildIssueMessage({
                what: `${result.file} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because it sits inside git internals or the graph's own .yggdrasil/ directory, so it cannot and need not be mapped to a node here.`,
                next: `No action needed.`,
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
            process.stdout.write(
              buildIssueMessage({
                what: `${result.file} is excluded from graph coverage by design.`,
                why: `This path is never scanned for coverage because ${cause}, so it cannot and need not be mapped to a node here.`,
                next: `No action needed.`,
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
              const cycleMsg = buildIssueMessage({
                what: `${result.file} matches type '${typeMatch.typeId}', but its rules could not be worked out.`,
                why: describeCascadeCycle(cascadeCycle),
                next: `Run yg check to see the blocking aspect-implies-cycle error, then remove one implies edge in .yggdrasil/aspects/. This file's rules cannot be evaluated until the cycle is fixed.`,
              });
              process.stderr.write(chalk.red(`Error: ${cycleMsg}\n`));
              process.exit(1);
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
            process.stdout.write(`${result.file} -> type:${typeMatch.typeId}\n`);
            process.stdout.write(
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
                        why: 'No node maps this file, and every rule the matched type attaches is either not a file-level rule or does not apply here — the file satisfies coverage with no enforcement.',
                        next: `yg context --file ${result.file}`,
                      },
                ) +
                '\n',
            );
          } else if (exists) {
            process.stdout.write(
              buildIssueMessage({
                what: `${result.file} -> no graph coverage`,
                why: 'This file exists but no graph node maps it, so its code is not verified against any aspect.',
                next: `Add '${result.file}' to a node's mapping in yg-node.yaml, or create a node for it.`,
              }) + '\n',
            );
          } else {
            process.stdout.write(
              buildIssueMessage({
                what: `${result.file} -> no graph coverage (file not found)`,
                why: 'This path does not exist on disk and is not mapped by any graph node.',
                next: `Check the path for typos; once the file exists, add it to a node's mapping in yg-node.yaml.`,
              }) + '\n',
            );
          }
        } else {
          process.stdout.write(`${result.file} -> ${result.nodePath}\n`);
          if (result.direct === false && result.mappingPath) {
            process.stdout.write(
              '  ' +
                buildIssueMessage({
                  what: 'File has no direct mapping.',
                  why: `Context comes from ancestor directory '${result.mappingPath}'.`,
                  next: `yg context --node ${result.nodePath}`,
                }) +
                '\n',
            );
          }
        }
      } catch (error) {
        // A --file path that resolves outside the repository is USER input, not an
        // internal bug — classify it rather than routing to the crash handler.
        const msg = error instanceof Error ? error.message : String(error);
        const outsideRoot = msg.match(/^Path is outside project root: (.+)$/);
        if (outsideRoot) {
          debugWrite(`[owner] file arg outside project root: ${msg}`);
          process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
            what: `The path '${toPosixPath(outsideRoot[1])}' is outside the project root.`,
            why: `yg owner resolves ownership only for files tracked inside the project.`,
            next: `Pass a path inside the project root (relative to the repo).`,
          }) + '\n'));
          process.exit(1);
        }
        abortOnUnexpectedError(error, 'resolving file owner');
      }
    });
}
