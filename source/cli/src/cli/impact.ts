import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { loadGraphFromRef } from '../core/graph-from-git.js';
import { buildContext } from '../core/context-builder.js';
import { detectDrift } from '../core/drift-detector.js';
import type { Graph } from '../model/types.js';

const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

function collectReverseDependents(
  graph: Graph,
  targetNode: string,
): {
  direct: string[];
  transitive: string[];
  reverse: Map<string, Set<string>>;
  relationFrom: Map<string, { type: string; consumes?: string[] }>;
} {
  const reverse = new Map<string, Set<string>>();
  const relationFrom = new Map<string, { type: string; consumes?: string[] }>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type)) continue;
      const deps = reverse.get(rel.target) ?? new Set<string>();
      deps.add(nodePath);
      reverse.set(rel.target, deps);
      relationFrom.set(`${nodePath}->${rel.target}`, {
        type: rel.type,
        consumes: rel.consumes,
      });
    }
  }

  const direct = [...(reverse.get(targetNode) ?? [])].sort();
  const seen = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return {
    direct,
    transitive: [...seen].sort(),
    reverse,
    relationFrom,
  };
}

function buildTransitiveChains(
  targetNode: string,
  direct: string[],
  transitive: string[],
  reverse: Map<string, Set<string>>,
): string[] {
  const directSet = new Set(direct);
  const transitiveOnly = transitive.filter((t) => !directSet.has(t));
  if (transitiveOnly.length === 0) return [];

  const parent = new Map<string, string>();
  const queue: string[] = [targetNode];
  const visited = new Set<string>([targetNode]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }

  const chains: string[] = [];
  for (const node of transitiveOnly) {
    const path: string[] = [];
    let current: string | undefined = node;
    while (current) {
      path.unshift(current);
      current = parent.get(current);
    }
    if (path.length >= 2) {
      chains.push(path.map((p) => `<- ${p}`).join(' '));
    }
  }
  return chains.sort();
}

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Show reverse dependency impact for a node')
    .requiredOption('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--simulate', 'Simulate context package impact (compare HEAD vs current)')
    .action(async (options: { node: string; simulate?: boolean }) => {
      try {
        const graph = await loadGraph(process.cwd());
        const nodePath = options.node.trim().replace(/\/$/, '');

        if (!graph.nodes.has(nodePath)) {
          process.stderr.write(`Node not found: ${nodePath}\n`);
          process.exit(1);
        }

        const { direct, transitive, reverse, relationFrom } = collectReverseDependents(
          graph,
          nodePath,
        );
        const chains = buildTransitiveChains(nodePath, direct, transitive, reverse);

        const flows: string[] = [];
        for (const flow of graph.flows) {
          if (flow.nodes.includes(nodePath)) {
            flows.push(flow.name);
          }
        }

        const aspectsInScope: string[] = [];
        const targetNode = graph.nodes.get(nodePath)!;
        const targetTags = new Set(targetNode.meta.tags ?? []);
        for (const aspect of graph.aspects) {
          if (targetTags.has(aspect.tag)) {
            aspectsInScope.push(aspect.name);
          }
        }

        const knowledgeInScope: string[] = [];
        for (const k of graph.knowledge) {
          if (k.scope === 'global') {
            knowledgeInScope.push(k.path);
            continue;
          }
          if (typeof k.scope === 'object' && 'tags' in k.scope) {
            if (k.scope.tags.some((t) => targetTags.has(t))) {
              knowledgeInScope.push(k.path);
            }
            continue;
          }
          if (typeof k.scope === 'object' && 'nodes' in k.scope) {
            if (k.scope.nodes.includes(nodePath)) {
              knowledgeInScope.push(k.path);
            }
          }
        }

        const budget = graph.config.quality?.context_budget ?? { warning: 10000, error: 20000 };
        process.stdout.write(`Impact of changes in ${nodePath}:\n\n`);
        process.stdout.write('Directly dependent:\n');
        if (direct.length === 0) {
          process.stdout.write('  (none)\n');
        } else {
          for (const dep of direct) {
            const rel = relationFrom.get(`${dep}->${nodePath}`);
            const annot = rel?.consumes?.length
              ? ` (${rel.type}, you consume: ${rel.consumes.join(', ')})`
              : rel
                ? ` (${rel.type})`
                : '';
            process.stdout.write(`  <- ${dep}${annot}\n`);
          }
        }
        process.stdout.write('\nTransitively dependent:\n');
        if (chains.length === 0) {
          process.stdout.write('  (none)\n');
        } else {
          for (const chain of chains) {
            process.stdout.write(`  ${chain}\n`);
          }
        }
        process.stdout.write(`\nFlows: ${flows.length > 0 ? flows.join(', ') : '(none)'}\n`);
        process.stdout.write(
          `Aspects (scope covers node): ${aspectsInScope.length > 0 ? aspectsInScope.join(', ') : '(none)'}\n`,
        );
        process.stdout.write(
          `Knowledge (scope covers node): ${knowledgeInScope.length > 0 ? knowledgeInScope.join(', ') : '(none)'}\n`,
        );
        process.stdout.write(
          `\nTotal scope: ${transitive.length} nodes, ${flows.length} flows, ${aspectsInScope.length} aspects, ${knowledgeInScope.length} knowledge\n`,
        );

        if (options.simulate && transitive.length > 0) {
          process.stdout.write('\nChanges in context packages:\n\n');
          const baselineGraph = await loadGraphFromRef(process.cwd(), 'HEAD');
          const driftReport = await detectDrift(graph);
          const driftByNode = new Map(driftReport.entries.map((e) => [e.nodePath, e]));

          for (const dep of transitive) {
            try {
              const pkg = await buildContext(graph, dep);
              const status =
                pkg.tokenCount >= budget.error
                  ? 'error'
                  : pkg.tokenCount >= budget.warning
                    ? 'warning'
                    : 'ok';

              let baselineTokens: number | null = null;
              if (baselineGraph?.nodes.has(dep)) {
                try {
                  const baselinePkg = await buildContext(baselineGraph, dep);
                  baselineTokens = baselinePkg.tokenCount;
                } catch {
                  /* ignore */
                }
              }

              const hasDepOnTarget = graph.nodes
                .get(dep)
                ?.meta.relations?.some(
                  (r) => r.target === nodePath && STRUCTURAL_TYPES.has(r.type),
                );
              const changedLine = hasDepOnTarget
                ? `  + Changed dependency interface: ${nodePath}\n`
                : '';

              const budgetLine =
                baselineTokens !== null
                  ? `  Budget: ${baselineTokens} -> ${pkg.tokenCount} tokens (${status})\n`
                  : `  Budget: ${pkg.tokenCount} tokens (${status})\n`;

              const driftEntry = driftByNode.get(dep);
              const driftLine =
                driftEntry && driftEntry.status !== 'ok'
                  ? `  Mapped files (on-disk): ${driftEntry.status}${driftEntry.details ? ` (${driftEntry.details})` : ''}\n`
                  : driftEntry
                    ? `  Mapped files (on-disk): ok\n`
                    : '';

              process.stdout.write(`${dep}:\n${changedLine}${budgetLine}${driftLine}\n`);
            } catch {
              process.stdout.write(`${dep}:\n  failed to build context\n\n`);
            }
          }
        }
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
