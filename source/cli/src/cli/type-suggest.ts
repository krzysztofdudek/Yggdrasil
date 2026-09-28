import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { classifyFile } from '../core/type-classifier.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { TypeClassCache } from '../io/type-class-cache.js';
import { renderTrace } from '../formatters/predicate-trace.js';
import {
  loadRootGitignoreStack,
  isIgnoredByStack,
  resolveGraphExclusionSet,
  describeExclusionSource,
  NO_COVERAGE_EXCLUDED,
} from '../io/repo-scanner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { warn, paint, writeOut } from './output.js';
import { exitAfterFlush } from './exit-after-flush.js';

/**
 * Core logic for `yg type-suggest --file <path>`.
 * Exported for testability. Resolves to the exit code: 1 when the file needs a
 * decision (no type's `when` matches it, or several do), 0 otherwise.
 */
export async function typeSuggestCommand(file: string, projectRoot: string): Promise<0 | 1> {
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });
  const repoRoot = projectRootFromGraph(graph.rootPath);
  const repoRelPath = toPosixPath(resolveFileArg(repoRoot, file.trim()));
  const absPath = resolve(repoRoot, repoRelPath);
  const cache = new FileContentCache();
  // A single-file, one-off diagnostic command: the persistent on-disk cache still
  // pays off across REPEATED invocations against the same file (e.g. an agent
  // probing a path, editing it, and re-running), so it is wired the same way
  // `yg owner --file` / `yg context --file` are — see core/type-coverage.ts's
  // classifySingleFile, which this command bypasses (it needs the path-only
  // pre-existence-check branch below, which classifySingleFile does not offer).
  // Gated on graph.config.coverage?.typeLevel, the same check every other
  // TypeClassCache-touching call site makes before constructing one — with the
  // tier off, `classifyFile` below still runs (path/content predicates are
  // pure and need no cache to evaluate), it just does so without ever
  // touching `.yggdrasil/.type-class-cache/`: no directory, no read, no write.
  const classCache = graph.config.coverage?.typeLevel
    ? new TypeClassCache(repoRoot, graph.architecture)
    : undefined;

  if (repoRelPath.startsWith('.yggdrasil/')) {
    writeOut(
      `\n${buildIssueMessage({
        what: `This path is inside .yggdrasil/ — auto-exempt from classification.`,
        why: 'The graph\'s own directory is never classified. Type matching does not apply here.',
        // A result, not a finding: nothing to do, so no next: line.
        next: '',
      })}\n\n`,
    );
    return 0;
  }

  // A path the one supreme exclusion filter cuts — a separate project's own
  // boundary (a nested .yggdrasil/ graph, or its own .git), or a
  // coverage.excluded root an adopter configured — is never a classification
  // candidate either, exactly like every other ownership/coverage command
  // already answers for the same path (`yg owner --file`, `yg context --file`,
  // `yg impact --file`, `yg aspect-test --file`). Without this, --file would be
  // the one command left disagreeing: it would classify the path, and on an
  // architecture with overlapping `when` predicates, send the adopter to
  // resolve an overlap `yg check` never reports and that has no consequence
  // for a path nothing enforces.
  const exclusion = await resolveGraphExclusionSet(repoRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  const exclusionSource = describeExclusionSource(repoRelPath, exclusion);
  if (exclusionSource !== null) {
    // Names WHICH of the two independent sources caused this — the same
    // distinction `file-mapping-excluded` already draws — instead of a
    // disjunction the adopter has to check both halves of.
    const cause = exclusionSource === 'nested-project'
      ? `it sits inside a separate project's own boundary (a nested .yggdrasil/ graph, or its own .git — a checkout, submodule, or worktree)`
      : `it matches a coverage.excluded root in yg-config.yaml`;
    writeOut(
      buildIssueMessage({
        what: `${repoRelPath} is excluded from graph coverage by design.`,
        why: `This path is never matched against any architecture type because ${cause}.`,
        next: '',
      }) + '\n',
    );
    return 0;
  }

  const gitignoreStack = await loadRootGitignoreStack(repoRoot);
  if (existsSync(absPath) && isIgnoredByStack(absPath, gitignoreStack)) {
    warn({
      what: `'${repoRelPath}' is matched by .gitignore.`,
      why: 'Classification still runs, but a node mapping this file would fire file-mapping-gitignored.',
      next: `Remove '${repoRelPath}' from .gitignore before mapping it, or leave it unmapped.`,
    });
  }

  if (!existsSync(absPath)) {
    writeOut(`\n(File does not exist — evaluating path predicates only)\n\n`);
    const result = await classifyFile(absPath, repoRelPath, graph, cache, classCache);
    if (result.matches.length > 0) {
      writeOut(`Matching types (path-only check):\n`);
      for (const m of result.matches) {
        writeOut(`  ${paint.dim('?')} ${m.typeId}\n`);
        const traced = renderTrace(m.trace, '      ');
        if (traced) writeOut(traced + '\n');
      }
    } else {
      writeOut(`No type's path predicate matches this file path.\n`);
    }
    writeOut(
      `\n${buildIssueMessage({
        what: `${repoRelPath} does not exist yet, so only the path predicates were evaluated.`,
        why: "A type's content predicates read the file's text; until the file exists, a path match is not yet a type match.",
        next: `create the file, then run yg type-suggest --file ${repoRelPath} again for the full check`,
      })}\n\n`,
    );
    return 0;
  }

  const result = await classifyFile(absPath, repoRelPath, graph, cache, classCache);

  if (result.matches.length === 0) {
    writeOut(`\nNo type's \`when\` matches this file.\n\n`);
    if (result.closest.length > 0) {
      writeOut(`Closest types (top 3, ranked by satisfied-fraction):\n`);
      for (const c of result.closest) {
        writeOut(
          `  ${c.typeId} — predicate evaluates to false (score: ${c.score.toFixed(2)})\n`,
        );
        const traced = renderTrace(c.trace, '      ');
        if (traced) writeOut(traced + '\n');
      }
    }
    printUnreadableTypes(result.unreadable);
    writeOut(
      `\n${buildIssueMessage({
        what: `${repoRelPath} is of no type.`,
        why: "A file no type's when matches gets none of the rules a type carries, and has no place in the architecture.",
        next:
          'one of three —\n' +
          "1. move the file under a path an existing type's when matches\n" +
          "2. change the file so it satisfies a type's content predicate\n" +
          '3. add a type that fits it to .yggdrasil/yg-architecture.yaml (an architecture change — ask the user to approve it first)',
      })}\n\n`,
    );
    return 1;
  }

  if (result.matches.length === 1) {
    writeOut(`\nMatching types:\n`);
    writeOut(`  ${paint.green('✓')} ${result.matches[0].typeId}\n`);
    const traced = renderTrace(result.matches[0].trace, '      ');
    if (traced) writeOut(traced + '\n');
    printUnreadableTypes(result.unreadable);
    writeOut('\n');
    return 0;
  }

  writeOut(`\nMultiple types match:\n`);
  for (const m of result.matches) {
    writeOut(`  ${paint.green('✓')} ${m.typeId} — full when satisfied\n`);
  }
  printUnreadableTypes(result.unreadable);
  writeOut(
    `\n${buildIssueMessage({
      what: 'The architecture has overlapping when predicates between these types.',
      why: 'A file must match exactly one type, or its rules and its place in the graph are ambiguous.',
      next: "compare each type's description and aspects in .yggdrasil/yg-architecture.yaml, and narrow one when",
    })}\n\n`,
  );
  return 1;
}

/**
 * Print types whose `when` could not be evaluated on this file at all (e.g. a
 * `content:` predicate on a file over the size limit). Distinct from a plain
 * non-match: the predicate was never actually applied to this file's content.
 */
function printUnreadableTypes(unreadable: { typeId: string; reason: string }[]): void {
  if (unreadable.length === 0) return;
  writeOut(`\nCould not be evaluated (predicate unreadable):\n`);
  for (const u of unreadable) {
    writeOut(`  ${paint.yellow('?')} ${u.typeId} — ${u.reason}\n`);
  }
}

export function registerTypeSuggestCommand(program: Command): void {
  program
    .command('type-suggest')
    .description('Suggest which node_type a file fits, based on architecture `when` predicates')
    .requiredOption('--file <path>', 'File path (relative to repo or absolute)')
    .action(async (options: { file: string }) => {
      try {
        const code = await typeSuggestCommand(options.file, process.cwd());
        if (code !== 0) await exitAfterFlush(code);
      } catch (error) {
        debugWrite(`[type-suggest] error: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'running type-suggest');
      }
    });
}
