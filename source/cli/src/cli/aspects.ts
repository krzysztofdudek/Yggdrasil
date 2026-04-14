import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { computeEffectiveAspects } from '../core/effective-aspects.js';
import type { Graph } from '../model/graph.js';

interface AspectUsage {
  architecture: number;
  own: number;
  implied: number;
  flow: number;
  total: number;
}

export function computeAspectUsage(graph: Graph): Map<string, AspectUsage> {
  const usage = new Map<string, AspectUsage>();
  for (const aspect of graph.aspects) {
    usage.set(aspect.id, { architecture: 0, own: 0, implied: 0, flow: 0, total: 0 });
  }

  for (const [, node] of graph.nodes) {
    const effective = computeEffectiveAspects(node, graph);
    const ownAspects = new Set(node.meta.aspects ?? []);
    const flowAspects = new Set<string>();
    for (const flow of graph.flows) {
      if (flow.nodes.includes(node.path)) {
        for (const id of flow.aspects ?? []) flowAspects.add(id);
      }
    }

    const archAspects = new Set<string>();
    if (graph.architecture) {
      const nodeTypeDef = graph.architecture.node_types[node.meta.type];
      for (const id of nodeTypeDef?.aspects ?? []) archAspects.add(id);
    }

    for (const aspectId of effective) {
      const u = usage.get(aspectId);
      if (!u) continue;
      u.total++;
      if (archAspects.has(aspectId)) u.architecture++;
      else if (flowAspects.has(aspectId)) u.flow++;
      else if (ownAspects.has(aspectId)) u.own++;
      else u.implied++;
    }
  }

  return usage;
}

export function formatAspectsOutput(graph: Graph): string {
  const usage = computeAspectUsage(graph);
  const lines: string[] = [];

  for (const aspect of graph.aspects.sort((a, b) => a.id.localeCompare(b.id))) {
    const u = usage.get(aspect.id) ?? { architecture: 0, own: 0, implied: 0, flow: 0, total: 0 };
    const displayName = aspect.description ?? aspect.name;
    lines.push(`${aspect.id} — ${displayName}`);

    if (u.total === 0) {
      lines.push(chalk.yellow(`  Used by: 0 nodes — orphaned`));
    } else {
      const parts: string[] = [];
      if (u.architecture) parts.push(`architecture: ${u.architecture}`);
      if (u.own) parts.push(`direct: ${u.own}`);
      if (u.implied) parts.push(`implied: ${u.implied}`);
      if (u.flow) parts.push(`flow: ${u.flow}`);
      lines.push(`  Used by: ${u.total} node${u.total === 1 ? '' : 's'} (${parts.join(', ')})`);
    }

    if (aspect.implies && aspect.implies.length > 0) {
      lines.push(`  Implies: ${aspect.implies.join(', ')}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

export function registerAspectsCommand(program: Command): void {
  program
    .command('aspects')
    .description('List aspects with usage stats')
    .action(async () => {
      try {
        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        process.stdout.write(formatAspectsOutput(graph));
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
