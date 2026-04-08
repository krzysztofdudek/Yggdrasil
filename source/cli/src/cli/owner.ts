import path from 'node:path';
import { access } from 'node:fs/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import type { Graph, OwnerResult } from '../model/graph.js';
import { normalizeMappingPaths, normalizeProjectRelativePath, projectRootFromGraph } from '../utils/paths.js';

function normalizeForMatch(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function findOwner(graph: Graph, projectRoot: string, rawPath: string): OwnerResult {
  const file = normalizeForMatch(normalizeProjectRelativePath(projectRoot, rawPath));
  let best: { nodePath: string; mappingPath: string; exact: boolean } | null = null;

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizeForMatch)
      .filter((mappingPath) => mappingPath.length > 0);

    for (const mappingPath of mappingPaths) {
      if (file === mappingPath) {
        return { file, nodePath, mappingPath, direct: true };
      }
      if (file.startsWith(mappingPath + '/')) {
        if (!best || (best && mappingPath.length > best.mappingPath.length)) {
          best = { nodePath, mappingPath, exact: false };
        }
      }
    }
  }

  return best
    ? { file, nodePath: best.nodePath, mappingPath: best.mappingPath, direct: false }
    : { file, nodePath: null };
}

export function registerOwnerCommand(program: Command): void {
  program
    .command('owner')
    .description('Find which graph node owns a source file')
    .requiredOption('--file <path>', 'File path (relative to repository root)')
    .action(async (options: { file: string }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraph(cwd);
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        // Resolve the file path relative to CWD (so subdirectory-relative paths work),
        // then make it relative to the actual repo root (where .yggdrasil/ lives).
        const repoRoot = projectRootFromGraph(graph.rootPath);
        const rawPath = options.file.trim();
        const absolute = path.resolve(cwd, rawPath);
        const repoRelative = path.relative(repoRoot, absolute).replace(/\\/g, '/').replace(/\/+$/, '');
        const result = findOwner(graph, repoRoot, repoRelative);

        if (!result.nodePath) {
          // Distinguish "file doesn't exist" from "file exists but not mapped"
          const absPath = path.resolve(repoRoot, result.file);
          let exists = true;
          try { await access(absPath); } catch { exists = false; }
          if (exists) {
            process.stdout.write(`${result.file} -> no graph coverage\n`);
          } else {
            process.stdout.write(`${result.file} -> no graph coverage (file not found)\n`);
          }
        } else {
          process.stdout.write(`${result.file} -> ${result.nodePath}\n`);
          if (result.direct === false && result.mappingPath) {
            process.stdout.write(
              `  File has no direct mapping; context comes from ancestor directory ${result.mappingPath}. Use: yg context --node ${result.nodePath}\n`,
            );
          }
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
        }
        process.exit(1);
      }
    });
}
