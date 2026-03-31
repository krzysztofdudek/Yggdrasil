import { Command } from 'commander';
import { stringify as yamlStringify } from 'yaml';
import { loadGraph } from '../core/graph-loader.js';
import { findYggRoot } from '../utils/paths.js';

export function registerAspectsCommand(program: Command): void {
  program
    .command('aspects')
    .description('List aspects with metadata (YAML output)')
    .action(async () => {
      try {
        const yggRoot = await findYggRoot(process.cwd());
        const graph = await loadGraph(yggRoot);
        const output = graph.aspects
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((aspect) => {
            const entry: Record<string, unknown> = { id: aspect.id, name: aspect.name };
            if (aspect.description) entry.description = aspect.description;
            if (aspect.implies && aspect.implies.length > 0) entry.implies = aspect.implies;
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
