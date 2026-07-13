import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { collectAncestors, buildNodeContextData, buildFileContextData } from '../core/context-builder.js';
import { formatNodeContext } from '../formatters/context-node.js';
import { formatFileContext } from '../formatters/context-file.js';
import { validate } from '../core/validator.js';
import { findOwner } from './owner.js';
import { normalizeMappingPaths, projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { expandMappingPaths, hashString } from '../io/hash.js';
import { readTextFile } from '../io/graph-fs.js';
import { readFeatureFieldEntry } from '../core/feature-index-read.js';
import { FAMILY_SEP } from '../core/feature-field-schema.js';
import { getLanguageDisplayName } from '../core/graph/language-registry.js';
import { isCoverageExcludedPath } from '../io/repo-scanner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { computeExpectedPairs, computeSourceFingerprint, FileUnreadableError } from '../core/pairs.js';
import { readLock } from '../io/lock-store.js';
import { readLogContent, hasFreshLogEntry } from '../core/log/log-gate.js';
import type { NodeContextData, NodeAspectSubjects, NodeLogState } from '../formatters/context-node.js';
import type { Graph } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';

type CandidateNode = { nodePath: string; fileCount: number };

function findCandidateNodes(graph: Graph, unmappedFile: string): CandidateNode[] {
  const dir = unmappedFile.replace(/\/[^/]+$/, '');
  if (!dir || dir === unmappedFile) return [];

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
  const { pairs } = await computeExpectedPairs(graph, { includeDraft: true });
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
    // family = `${ownerNodeId}\x00${language}`; take the language half and humanize it.
    const sepAt = entry.family.indexOf(FAMILY_SEP);
    const language = sepAt >= 0 ? entry.family.slice(sepAt + 1) : entry.family;
    const lang = getLanguageDisplayName(language);
    process.stdout.write(
      `\nThis file is structurally unusual among this node's other ${lang} files — worth a closer read; no action required.\n`,
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
          const result = findOwner(graph, repoRoot, repoRelative);
          const displayFile = toPosixPath(result.file);
          if (!result.nodePath) {
            // A path the coverage scan UNCONDITIONALLY skips (git internals, or
            // the graph's own .yggdrasil/ tree) can never be enumerated for
            // coverage — suggesting "add it to a node mapping" would map a file
            // yg check will never see. Answer "excluded by design" and exit 0:
            // this is not a coverage gap, so there is genuinely nothing to fix.
            if (isCoverageExcludedPath(result.file)) {
              const excludedMsg = buildIssueMessage({
                what: `${displayFile} is excluded from graph coverage by design.`,
                why: 'This path is never scanned for coverage (git internals / the graph directory itself), so it cannot and need not be mapped to a node.',
                next: 'No action needed.',
              });
              process.stderr.write(`${excludedMsg}\n`);
              process.exit(0);
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
          process.stderr.write(`${displayFile} -> ${result.nodePath}\n`);
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
          const projectRoot = projectRootFromGraph(graph.rootPath);
          data.sourceFiles = await expandMappingPaths(projectRoot, data.sourceFiles);
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
            what: `Node '${notFound[1]}' does not exist in the graph.`,
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
