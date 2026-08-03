import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { collectAncestors, buildNodeContextData, buildFileContextData } from '../core/context-builder.js';
import { formatNodeContext } from '../formatters/context-node.js';
import { formatFileContext } from '../formatters/context-file.js';
import type { FileContextData, FileContextAspect } from '../formatters/context-file.js';
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
import type { TypeCoverageInput } from '../core/pairs.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached, classifySingleFileCached } from '../core/type-coverage.js';
import { computeTypeAspectCascade, describeCascadeCycle } from '../core/type-effective.js';
import { buildTypeVisibility, describeTypeVisibilityReason, describeChainTermination, toAppliedPairs } from '../core/type-visibility.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { readLock } from '../io/lock-store.js';
import { readLogContent, hasFreshLogEntry } from '../core/log/log-gate.js';
import type { NodeContextData, NodeAspectSubjects, NodeLogState } from '../formatters/context-node.js';
import type { Graph } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';

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
async function computeTypeCoverageForContext(graph: Graph): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const projectRoot = projectRootFromGraph(graph.rootPath);
  const repoFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, repoFiles);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
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
 * classifying every uncovered file in the repo to do it. No relation-edge
 * index is built either (that is a whole-repo parse); a `relations:` atom on
 * this file's attached rules therefore reads the conservative false, exactly
 * the documented contract for any caller running before the relation pass —
 * DERIVED_RELATIONS_NOTE says so on the rendered page itself.
 */
async function buildTypeCoveredFileContextData(graph: Graph, file: string, typeId: string): Promise<FileContextData> {
  const covered = new Map([[file, typeId]]);
  const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage: { covered, ambiguousPaths: [] } });
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
  const lock = readLock(graph.rootPath);
  const archType = graph.architecture.node_types[data.type];
  const logRequiredType = archType?.log_required ?? false;
  let required = false;
  let freshPresent = false;
  if (logRequiredType) {
    let currentFingerprint: string | undefined;
    try {
      currentFingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch (e) {
      // An unreadable mapped file makes the fingerprint uncomputable; gate state
      // cannot be honestly computed. Leave it false — the file-unreadable error
      // surfaces in yg check, which is where the user acts on it.
      if (!(e instanceof FileUnreadableError)) throw e;
      debugWrite(`[build-context] source fingerprint for ${nodePath}: ${e.message}`);
    }
    // Mapping-less nodes have an undefined fingerprint — the gate never fires.
    if (currentFingerprint !== undefined) {
      const storedFingerprint = lock.nodes[nodePath]?.source;
      required = currentFingerprint !== storedFingerprint;
    }
    const projectRoot = projectRootFromGraph(graph.rootPath);
    const logContent = await readLogContent(projectRoot, nodePath);
    freshPresent = hasFreshLogEntry(logContent, lock.nodes[nodePath]?.log);
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

export function registerBuildCommand(program: Command): void {
  const contextAction = async (options: { node?: string; file?: string }) => {
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
                const cascadeCycle = computeTypeAspectCascade(graph, result.file, typeMatch.typeId).cycle;
                if (cascadeCycle) {
                  const cycleMsg = buildIssueMessage({
                    what: `${displayFile} matches type '${typeMatch.typeId}', but its rules could not be worked out.`,
                    why: describeCascadeCycle(cascadeCycle),
                    next: `Run yg check to see the blocking aspect-implies-cycle error, then remove one implies edge in .yggdrasil/aspects/. This file's rules cannot be evaluated until the cycle is fixed.`,
                  });
                  process.stderr.write(chalk.red(`Error: ${cycleMsg}\n`));
                  process.exit(1);
                }
                const data = await buildTypeCoveredFileContextData(graph, result.file, typeMatch.typeId);
                process.stdout.write(formatFileContext(data));
                if (graph.config.signals?.attention !== false) {
                  await maybeAppendAttentionLine(graph, displayFile);
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
          process.stdout.write(formatFileContext(data));
          // Advisory structural-attention note. Default ON; the off-switch is
          // signals.attention: false (absent `signals` ⇒ ON). Read-only,
          // best-effort, non-blocking — yg context --file stays exit 0.
          if (graph.config.signals?.attention !== false) {
            await maybeAppendAttentionLine(graph, resolvedFilePath);
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
    .action(contextAction);

}
