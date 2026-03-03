import { Command } from 'commander';
import { stringify as yamlStringify } from 'yaml';
import { loadGraph } from '../core/graph-loader.js';
import { findYggRoot } from '../utils/paths.js';

export function registerFlowsCommand(program: Command): void {
  program
    .command('flows')
    .description('List flows with metadata (YAML output)')
    .action(async () => {
      try {
        const yggRoot = await findYggRoot(process.cwd());
        const graph = await loadGraph(yggRoot);
        const output = graph.flows
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((flow) => {
            const entry: Record<string, unknown> = {
              name: flow.name,
              participants: flow.nodes.length,
              nodes: flow.nodes.sort(),
            };
            if (flow.aspects && flow.aspects.length > 0) entry.aspects = flow.aspects;
            return entry;
          });
        process.stdout.write(yamlStringify(output));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            `Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`,
          );
        } else {
          process.stderr.write(`Error: ${(error as Error).message}\n`);
        }
        process.exit(1);
      }
    });
}
