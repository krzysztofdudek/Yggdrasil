import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { syncDriftState } from '../core/drift-detector.js';
import { normalizeMappingPaths } from '../utils/paths.js';

export function registerDriftSyncCommand(program: Command): void {
  program
    .command('drift-sync')
    .description('Record current file hash after resolving drift')
    .option('--node <path>', 'Node path to sync')
    .option('--recursive', 'Also sync all descendant nodes')
    .option('--all', 'Sync all nodes with mappings')
    .action(async (options: { node?: string; recursive?: boolean; all?: boolean }) => {
      try {
        if (!options.node && !options.all) {
          process.stderr.write("Error: either '--node <path>' or '--all' is required\n");
          process.exit(1);
        }

        const graph = await loadGraph(process.cwd());

        let nodesToSync: string[];

        if (options.all) {
          nodesToSync = [...graph.nodes.entries()]
            .filter(([, n]) => normalizeMappingPaths(n.meta.mapping).length > 0)
            .map(([p]) => p)
            .sort();
        } else {
          const nodePath = options.node!.trim().replace(/^\.\//, '').replace(/\/+$/, '');

          if (!graph.nodes.has(nodePath)) {
            await syncDriftState(graph, nodePath); // will throw with proper error
            return;
          }

          nodesToSync = [nodePath];
          if (options.recursive) {
            const prefix = nodePath + '/';
            for (const [p] of graph.nodes) {
              if (p.startsWith(prefix)) {
                nodesToSync.push(p);
              }
            }
            nodesToSync.sort();
          }
        }

        for (const np of nodesToSync) {
          const node = graph.nodes.get(np)!;
          if (normalizeMappingPaths(node.meta.mapping).length === 0) {
            if (!options.all && !options.recursive && np === options.node) {
              await syncDriftState(graph, np); // will throw with proper error
            }
            continue;
          }
          const { previousHash, currentHash } = await syncDriftState(graph, np);
          process.stdout.write(chalk.green(`Synchronized: ${np}\n`));
          process.stdout.write(
            `  Hash: ${previousHash ? previousHash.slice(0, 8) : 'none'} -> ${currentHash.slice(0, 8)}\n`,
          );
        }
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
