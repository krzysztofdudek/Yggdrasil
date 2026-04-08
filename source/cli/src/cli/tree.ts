import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import type { GraphNode } from '../model/graph.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Display graph structure as a tree')
    .option('--root <path>', 'Show only subtree rooted at this path')
    .option('--depth <n>', 'Maximum depth', (v) => parseInt(v, 10))
    .action(async (options: { root?: string; depth?: number }) => {
      try {
        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);

        let roots: GraphNode[];
        let showProjectName: boolean;

        if (options.root?.trim()) {
          const path = options.root.trim().replace(/\/$/, '');
          const node = graph.nodes.get(path);
          if (!node) {
            process.stderr.write(chalk.red(`Error: path '${path}' not found\n`));
            process.exit(1);
          }
          roots = [node];
          showProjectName = false;
        } else {
          roots = [...graph.nodes.values()]
            .filter((n) => n.parent === null)
            .sort((a, b) => a.path.localeCompare(b.path));
          showProjectName = true;
        }

        if (showProjectName) {
          process.stdout.write('model/\n');
        }

        for (let i = 0; i < roots.length; i++) {
          const isLast = i === roots.length - 1;
          printNode(roots[i], '', isLast, 1, options.depth);
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

function printNode(
  node: GraphNode,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number | undefined,
): void {
  const connector = isLast ? '└── ' : '├── ';
  const name = node.path.split('/').pop() ?? node.path;
  const type = `[${node.meta.type}]`;
  const tags = node.meta.aspects?.length ? ` aspects:${node.meta.aspects.join(',')}` : '';
  const blackbox = node.meta.blackbox ? ' ■ blackbox' : '';
  const relationCount = node.meta.relations?.length ?? 0;

  process.stdout.write(
    `${prefix}${connector}${name}/ ${type}${tags}${blackbox} -> ${relationCount} relations\n`,
  );

  const childPrefix = prefix + (isLast ? '    ' : '│   ');

  // Recurse into children
  if (maxDepth !== undefined && depth >= maxDepth) return;

  const children = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 0; i < children.length; i++) {
    printNode(children[i], childPrefix, i === children.length - 1, depth + 1, maxDepth);
  }
}
