import path from 'node:path';
import { access } from 'node:fs/promises';
import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import type { Graph, OwnerResult } from '../model/types.js';
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
        return { file, nodePath, mappingPath };
      }
      if (file.startsWith(mappingPath + '/')) {
        if (!best || (best && mappingPath.length > best.mappingPath.length)) {
          best = { nodePath, mappingPath, exact: false };
        }
      }
    }
  }

  return best
    ? { file, nodePath: best.nodePath, mappingPath: best.mappingPath }
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
        // Resolve the file path relative to CWD (so subdirectory-relative paths work),
        // then make it relative to the actual repo root (where .yggdrasil/ lives).
        const repoRoot = projectRootFromGraph(graph.rootPath);
        const rawPath = options.file.trim();
        const absolute = path.resolve(cwd, rawPath);
        const repoRelative = path.relative(repoRoot, absolute).split(path.sep).join('/');
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
        }
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
