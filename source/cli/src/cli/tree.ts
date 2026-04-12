import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import type { GraphNode } from '../model/graph.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Display graph structure as a flat list')
    .option('--root <path>', 'Show only subtree rooted at this path')
    .option('--depth <n>', 'Maximum depth', (v) => parseInt(v, 10))
    .action(async (options: { root?: string; depth?: number }) => {
      try {
        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);

        let roots: GraphNode[];

        if (options.root?.trim()) {
          const path = options.root.trim().replace(/\/$/, '');
          const node = graph.nodes.get(path);
          if (!node) {
            process.stderr.write(chalk.red(`Error: path '${path}' not found\n`));
            process.exit(1);
          }
          roots = [node];
        } else {
          roots = [...graph.nodes.values()]
            .filter((n) => n.parent === null)
            .sort((a, b) => a.path.localeCompare(b.path));
        }

        const lines: string[] = [];
        for (const root of roots) {
          collectNodes(root, lines, 0, options.depth);
        }

        for (const line of lines) {
          process.stdout.write(line + '\n');
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

function collectNodes(
  node: GraphNode,
  lines: string[],
  depth: number,
  maxDepth: number | undefined,
): void {
  const desc = node.meta.description?.trim();
  const line = desc
    ? `${node.path} [${node.meta.type}] — ${desc}`
    : `${node.path} [${node.meta.type}]`;
  lines.push(line);

  if (maxDepth !== undefined && depth >= maxDepth) return;

  const children = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
  for (const child of children) {
    collectNodes(child, lines, depth + 1, maxDepth);
  }
}
