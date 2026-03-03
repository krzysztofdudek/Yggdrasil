import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { formatDependencyTree } from '../core/dependency-resolver.js';

export function registerDepsCommand(program: Command): void {
  program
    .command('deps')
    .description('Show direct and transitive node dependencies')
    .requiredOption('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--depth <n>', 'Maximum depth for tree (when using --node)', (v) => parseInt(v, 10))
    .option('--type <type>', 'Relation type filter: structural, event, all (default: all)', 'all')
    .action(async (options: { node: string; depth?: number; type?: string }) => {
      try {
        const graph = await loadGraph(process.cwd());
        const typeFilter =
          options.type === 'structural' || options.type === 'event' || options.type === 'all'
            ? options.type
            : 'all';
        const nodePath = options.node.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        const text = formatDependencyTree(graph, nodePath, {
          depth: options.depth,
          relationType: typeFilter,
        });
        process.stdout.write(text + '\n');
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
