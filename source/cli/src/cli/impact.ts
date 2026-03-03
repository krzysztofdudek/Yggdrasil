import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { loadGraphFromRef } from '../core/graph-from-git.js';
import {
  buildContext,
  collectAncestors,
  collectEffectiveAspectIds,
} from '../core/context-builder.js';
import { detectDrift } from '../core/drift-detector.js';
import type { Graph } from '../model/types.js';

const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

export function collectReverseDependents(
  graph: Graph,
  targetNode: string,
): {
  direct: string[];
  allDependents: string[];
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
    allDependents: [...seen].sort(),
    reverse,
    relationFrom,
  };
}

export function buildTransitiveChains(
  targetNode: string,
  direct: string[],
  allDependents: string[],
  reverse: Map<string, Set<string>>,
): string[] {
  const directSet = new Set(direct);
  const transitiveOnly = allDependents.filter((t) => !directSet.has(t));
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
    if (path.length >= 3) {
      chains.push(path.slice(1).map((p) => `<- ${p}`).join(' '));
    }
  }
  return chains.sort();
}

export function collectDescendants(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const result: string[] = [];
  const stack = [...node.children];
  while (stack.length > 0) {
    const child = stack.pop()!;
    result.push(child.path);
    stack.push(...child.children);
  }
  return result.sort();
}

async function runSimulation(
  graph: Graph,
  nodePaths: Iterable<string>,
  targetNodePath: string | null,
): Promise<void> {
  const budget = graph.config.quality?.context_budget ?? { warning: 10000, error: 20000 };
  process.stdout.write('\nChanges in context packages:\n\n');
  const baselineGraph = await loadGraphFromRef(process.cwd(), 'HEAD');
  const driftReport = await detectDrift(graph);
  const driftByNode = new Map(driftReport.entries.map((e) => [e.nodePath, e]));

  for (const dep of nodePaths) {
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

      const hasDepOnTarget =
        targetNodePath &&
        graph.nodes
          .get(dep)
          ?.meta.relations?.some(
            (r) => r.target === targetNodePath && STRUCTURAL_TYPES.has(r.type),
          );
      const changedLine = hasDepOnTarget
        ? `  + Changed dependency interface: ${targetNodePath}\n`
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

async function handleAspectImpact(
  graph: Graph,
  aspectId: string,
  simulate?: boolean,
): Promise<void> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    process.stderr.write(`Aspect not found: ${aspectId}\n`);
    process.exit(1);
  }

  const affected: Array<{ path: string; source: string }> = [];
  for (const [nodePath] of graph.nodes) {
    const effective = collectEffectiveAspectIds(graph, nodePath);
    if (effective.has(aspectId)) {
      const node = graph.nodes.get(nodePath)!;
      const ownAspects = new Set(node.meta.aspects ?? []);
      if (ownAspects.has(aspectId)) {
        affected.push({ path: nodePath, source: 'own' });
      } else {
        let fromHierarchy = false;
        let anc = node.parent;
        while (anc) {
          if ((anc.meta.aspects ?? []).includes(aspectId)) {
            fromHierarchy = true;
            break;
          }
          anc = anc.parent;
        }
        if (fromHierarchy) {
          affected.push({ path: nodePath, source: `hierarchy from ${anc!.path}` });
        } else {
          const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
          const flow = graph.flows.find(
            (f) =>
              (f.aspects ?? []).includes(aspectId) &&
              f.nodes.some((n) => ancestorPaths.has(n)),
          );
          affected.push({ path: nodePath, source: flow ? `flow: ${flow.name}` : 'implied' });
        }
      }
    }
  }

  affected.sort((a, b) => a.path.localeCompare(b.path));

  const propagatingFlows = graph.flows
    .filter((f) => (f.aspects ?? []).includes(aspectId))
    .map((f) => f.name);

  const impliedBy = graph.aspects
    .filter((a) => (a.implies ?? []).includes(aspectId))
    .map((a) => a.id);
  const implies = aspect.implies ?? [];

  process.stdout.write(`Impact of changes in aspect ${aspectId}:\n\n`);
  process.stdout.write(`Affected nodes (${affected.length}):\n`);
  if (affected.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const { path: p, source } of affected) {
      process.stdout.write(`  ${p} (${source})\n`);
    }
  }
  process.stdout.write(
    `\nFlows propagating this aspect: ${propagatingFlows.length > 0 ? propagatingFlows.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(`Implied by: ${impliedBy.length > 0 ? impliedBy.join(', ') : '(none)'}\n`);
  process.stdout.write(`Implies: ${implies.length > 0 ? implies.join(', ') : '(none)'}\n`);
  process.stdout.write(`\nTotal scope: ${affected.length} nodes, ${propagatingFlows.length} flows\n`);

  if (simulate && affected.length > 0) {
    await runSimulation(
      graph,
      affected.map((a) => a.path),
      null,
    );
  }
}

async function handleFlowImpact(
  graph: Graph,
  flowName: string,
  simulate?: boolean,
): Promise<void> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) {
    process.stderr.write(`Flow not found: ${flowName}\n`);
    process.exit(1);
  }

  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    if (graph.nodes.has(nodePath)) {
      participants.add(nodePath);
      for (const desc of collectDescendants(graph, nodePath)) {
        participants.add(desc);
      }
    }
  }

  const sorted = [...participants].sort();
  const flowAspects = flow.aspects ?? [];

  process.stdout.write(`Impact of changes in flow ${flow.name}:\n\n`);
  process.stdout.write('Participants:\n');
  if (sorted.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const p of sorted) {
      const isDeclared = flow.nodes.includes(p);
      const suffix = isDeclared ? '' : ' (descendant)';
      process.stdout.write(`  ${p}${suffix}\n`);
    }
  }
  process.stdout.write(
    `\nFlow aspects: ${flowAspects.length > 0 ? flowAspects.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(`\nTotal scope: ${sorted.length} nodes\n`);

  if (simulate && sorted.length > 0) {
    await runSimulation(graph, sorted, null);
  }
}

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Show reverse dependency impact for a node, aspect, or flow')
    .option('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--aspect <id>', 'Aspect id (directory path under aspects/)')
    .option('--flow <name>', 'Flow name (directory name under flows/)')
    .option('--simulate', 'Simulate context package impact (compare HEAD vs current)')
    .action(
      async (options: { node?: string; aspect?: string; flow?: string; simulate?: boolean }) => {
        try {
          const modeCount = [options.node, options.aspect, options.flow].filter(Boolean).length;
          if (modeCount === 0) {
            process.stderr.write(
              'Error: one of --node, --aspect, or --flow is required\n',
            );
            process.exit(1);
          }
          if (modeCount > 1) {
            process.stderr.write(
              'Error: --node, --aspect, and --flow are mutually exclusive\n',
            );
            process.exit(1);
          }

          const graph = await loadGraph(process.cwd());

          if (options.aspect) {
            await handleAspectImpact(graph, options.aspect.trim(), options.simulate);
            return;
          }
          if (options.flow) {
            await handleFlowImpact(graph, options.flow.trim(), options.simulate);
            return;
          }

          const nodePath = options.node!.trim().replace(/^\.\//, '').replace(/\/+$/, '');

          if (!graph.nodes.has(nodePath)) {
            process.stderr.write(`Node not found: ${nodePath}\n`);
            process.exit(1);
          }

          const { direct, allDependents, reverse, relationFrom } = collectReverseDependents(
            graph,
            nodePath,
          );
          const chains = buildTransitiveChains(nodePath, direct, allDependents, reverse);

          const flows: string[] = [];
          for (const flow of graph.flows) {
            if (flow.nodes.includes(nodePath)) {
              flows.push(flow.name);
            }
          }

          const targetEffective = collectEffectiveAspectIds(graph, nodePath);
          const aspectsInScope: string[] = [];
          for (const aspect of graph.aspects) {
            if (targetEffective.has(aspect.id)) {
              aspectsInScope.push(aspect.name);
            }
          }

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

          const descendants = collectDescendants(graph, nodePath);
          if (descendants.length > 0) {
            process.stdout.write('\nDescendants (hierarchy impact):\n');
            for (const desc of descendants) {
              process.stdout.write(`  ${desc}\n`);
            }
          }

          process.stdout.write(
            `\nFlows: ${flows.length > 0 ? flows.join(', ') : '(none)'}\n`,
          );
          process.stdout.write(
            `Aspects (scope covers node): ${aspectsInScope.length > 0 ? aspectsInScope.join(', ') : '(none)'}\n`,
          );

          const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
          if (targetEffective.size > 0) {
            for (const [p] of graph.nodes) {
              if (p === nodePath) continue;
              const nodeEffective = collectEffectiveAspectIds(graph, p);
              const shared = [...targetEffective].filter((id) => nodeEffective.has(id));
              if (shared.length > 0) {
                coAspectNodes.push({ path: p, shared });
              }
            }
          }
          if (coAspectNodes.length > 0) {
            process.stdout.write('Nodes sharing aspects:\n');
            for (const { path: p, shared } of coAspectNodes.sort((a, b) =>
              a.path.localeCompare(b.path),
            )) {
              process.stdout.write(`  ${p} (${shared.join(', ')})\n`);
            }
          }

          const allAffected = new Set([...allDependents, ...descendants]);
          process.stdout.write(
            `\nTotal scope: ${allAffected.size} nodes, ${flows.length} flows, ${aspectsInScope.length} aspects\n`,
          );

          if (options.simulate && allAffected.size > 0) {
            await runSimulation(graph, allAffected, nodePath);
          }
        } catch (error) {
          process.stderr.write(`Error: ${(error as Error).message}\n`);
          process.exit(1);
        }
      },
    );
}
