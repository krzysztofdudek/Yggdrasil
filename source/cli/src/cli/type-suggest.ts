import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { classifyFile } from '../core/type-classifier.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { renderTrace } from '../formatters/predicate-trace.js';
import {
  loadRootGitignoreStack,
  isIgnoredByStack,
  resolveGraphExclusionSet,
  isExcludedFromGraph,
  NO_COVERAGE_EXCLUDED,
} from '../io/repo-scanner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { buildIssueMessage } from '../formatters/message-builder.js';

/**
 * Core logic for `yg type-suggest --file <path>`.
 * Exported for testability.
 */
export async function typeSuggestCommand(file: string, projectRoot: string): Promise<void> {
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });
  const repoRoot = projectRootFromGraph(graph.rootPath);
  const repoRelPath = toPosixPath(resolveFileArg(repoRoot, file.trim()));
  const absPath = resolve(repoRoot, repoRelPath);
  const cache = new FileContentCache();

  if (repoRelPath.startsWith('.yggdrasil/')) {
    process.stdout.write(
      `\nThis path is inside .yggdrasil/ — auto-exempt from classification.\n` +
        `Type matching does not apply here.\n\n`,
    );
    return;
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
  if (isExcludedFromGraph(repoRelPath, exclusion)) {
    process.stdout.write(
      buildIssueMessage({
        what: `${repoRelPath} is excluded from graph coverage by design.`,
        why: `This path sits inside a separate project's own boundary (a nested .yggdrasil/ graph, or its own .git — a checkout, submodule, or worktree), or matches a coverage.excluded root, so no architecture type is ever matched against it.`,
        next: `No action needed.`,
      }) + '\n',
    );
    return;
  }

  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  if (existsSync(absPath) && isIgnoredByStack(absPath, gitignoreStack)) {
    process.stderr.write(
      chalk.yellow(
        `\nWarning: '${repoRelPath}' is matched by .gitignore.\n` +
          `Classification will run, but a node mapping this file would fire\n` +
          `file-mapping-gitignored. Proceeding with classification for context.\n\n`,
      ),
    );
  }

  if (!existsSync(absPath)) {
    process.stdout.write(`\n(File does not exist — evaluating path predicates only)\n\n`);
    const result = await classifyFile(absPath, repoRelPath, graph, cache);
    if (result.matches.length > 0) {
      process.stdout.write(`Matching types (path-only check):\n`);
      for (const m of result.matches) {
        process.stdout.write(`  ${chalk.dim('?')} ${m.typeId}\n`);
        const traced = renderTrace(m.trace, '      ');
        if (traced) process.stdout.write(traced + '\n');
      }
    } else {
      process.stdout.write(`No type's path predicate matches this file path.\n`);
    }
    process.stdout.write(
      `\nNEXT\n  Create the file, then re-run yg type-suggest for full validation.\n\n`,
    );
    return;
  }

  const result = await classifyFile(absPath, repoRelPath, graph, cache);

  if (result.matches.length === 0) {
    process.stdout.write(`\nNo type's \`when\` matches this file.\n\n`);
    if (result.closest.length > 0) {
      process.stdout.write(`Closest types (top 3, ranked by satisfied-fraction):\n`);
      for (const c of result.closest) {
        process.stdout.write(
          `  ${c.typeId} — predicate evaluates to false (score: ${c.score.toFixed(2)})\n`,
        );
        const traced = renderTrace(c.trace, '      ');
        if (traced) process.stdout.write(traced + '\n');
      }
    }
    printUnreadableTypes(result.unreadable);
    process.stdout.write(
      `\nNEXT\n  Three options:\n` +
        `  1. Move file under a path matching an existing type's when\n` +
        `  2. Refactor file to satisfy a type's content predicate\n` +
        `  3. Add a new type to yg-architecture.yaml that fits this file\n\n`,
    );
    return;
  }

  if (result.matches.length === 1) {
    process.stdout.write(`\nMatching types:\n`);
    process.stdout.write(`  ${chalk.green('✓')} ${result.matches[0].typeId}\n`);
    const traced = renderTrace(result.matches[0].trace, '      ');
    if (traced) process.stdout.write(traced + '\n');
    printUnreadableTypes(result.unreadable);
    process.stdout.write('\n');
    return;
  }

  process.stdout.write(`\nMultiple types match:\n`);
  for (const m of result.matches) {
    process.stdout.write(`  ${chalk.green('✓')} ${m.typeId} — full when satisfied\n`);
  }
  printUnreadableTypes(result.unreadable);
  process.stdout.write(
    `\nNEXT\n  Architecture has overlapping when between types.\n` +
      `  Check each type's description and aspects in yg-architecture.yaml.\n\n`,
  );
}

/**
 * Print types whose `when` could not be evaluated on this file at all (e.g. a
 * `content:` predicate on a file over the size limit). Distinct from a plain
 * non-match: the predicate was never actually applied to this file's content.
 */
function printUnreadableTypes(unreadable: { typeId: string; reason: string }[]): void {
  if (unreadable.length === 0) return;
  process.stdout.write(`\nCould not be evaluated (predicate unreadable):\n`);
  for (const u of unreadable) {
    process.stdout.write(`  ${chalk.yellow('?')} ${u.typeId} — ${u.reason}\n`);
  }
}

export function registerTypeSuggestCommand(program: Command): void {
  program
    .command('type-suggest')
    .description('Suggest which node_type a file fits, based on architecture `when` predicates')
    .requiredOption('--file <path>', 'File path (relative to repo or absolute)')
    .action(async (options: { file: string }) => {
      try {
        await typeSuggestCommand(options.file, process.cwd());
      } catch (error) {
        debugWrite(`[type-suggest] error: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'running type-suggest');
      }
    });
}
