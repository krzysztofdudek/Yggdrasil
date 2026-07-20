import path from 'node:path';
import { access } from 'node:fs/promises';
import chalk from 'chalk';
import { Command } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Graph, OwnerResult } from '../model/graph.js';
import { normalizeMappingPaths, normalizeProjectRelativePath, projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import { mappingEntryMatchesFile, isGlobPattern } from '../utils/mapping-path.js';

function normalizeForMatch(inputPath: string): string {
  return toPosixPath(inputPath.trim());
}

export function findOwner(graph: Graph, projectRoot: string, rawPath: string): OwnerResult {
  const file = normalizeForMatch(normalizeProjectRelativePath(projectRoot, rawPath));
  let best: { nodePath: string; mappingPath: string; exact: boolean } | null = null;

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizeForMatch)
      .filter((mappingPath) => mappingPath.length > 0);

    for (const mappingPath of mappingPaths) {
      if (isGlobPattern(mappingPath)) {
        if (mappingEntryMatchesFile(mappingPath, file)) {
          // Glob match: treat as direct (the pattern names the file explicitly)
          if (
            !best ||
            mappingPath.length > best.mappingPath.length ||
            (mappingPath.length === best.mappingPath.length && nodePath < best.nodePath)
          ) {
            best = { nodePath, mappingPath, exact: true };
          }
        }
      } else {
        if (file === mappingPath) {
          return { file, nodePath, mappingPath, direct: true };
        }
        if (file.startsWith(mappingPath + '/')) {
          if (
            !best ||
            mappingPath.length > best.mappingPath.length ||
            (mappingPath.length === best.mappingPath.length && nodePath < best.nodePath)
          ) {
            best = { nodePath, mappingPath, exact: false };
          }
        }
      }
    }
  }

  return best
    ? { file, nodePath: best.nodePath, mappingPath: best.mappingPath, direct: best.exact }
    : { file, nodePath: null };
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
        const result = findOwner(graph, repoRoot, repoRelative);

        if (!result.nodePath) {
          // Distinguish "file doesn't exist" from "file exists but not mapped"
          const absPath = path.resolve(repoRoot, result.file);
          let exists = true;
          try { await access(absPath); } catch (e: unknown) { debugWrite(`[owner] access check failed: ${e instanceof Error ? e.message : String(e)}`); exists = false; }
          if (exists) {
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
