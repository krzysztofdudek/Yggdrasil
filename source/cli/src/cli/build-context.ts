import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { buildContext, collectAncestors } from '../core/context-builder.js';
import { validate } from '../core/validator.js';
import { formatContextText } from '../formatters/context-text.js';
import type { Graph } from '../model/types.js';

/**
 * Collect the set of node paths that participate in context assembly for a given node:
 * the node itself, its ancestors, and its direct relation targets.
 */
function collectRelevantNodePaths(graph: Graph, nodePath: string): Set<string> {
  const relevant = new Set<string>();
  const node = graph.nodes.get(nodePath);
  if (!node) return relevant;

  relevant.add(nodePath);

  // Ancestors (hierarchy)
  for (const ancestor of collectAncestors(node)) {
    relevant.add(ancestor.path);
  }

  // Direct relation targets
  for (const rel of node.meta.relations ?? []) {
    relevant.add(rel.target);
  }

  return relevant;
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build-context')
    .description('Assemble a context package for one node')
    .requiredOption('--node <node-path>', 'Node path relative to .yggdrasil/model/')
    .action(async (options: { node: string }) => {
      try {
        const graph = await loadGraph(process.cwd());
        const nodePath = options.node.trim().replace(/^\.\//, '').replace(/\/$/, '');

        // Collect nodes relevant to this context assembly
        const relevantNodes = collectRelevantNodePaths(graph, nodePath);

        // Validate but only block on errors relevant to this node's context
        const validationResult = await validate(graph, 'all');
        const relevantErrors = validationResult.issues.filter(
          (issue) =>
            issue.severity === 'error' &&
            // Global errors (no nodePath) always block — e.g., E012 invalid config
            (!issue.nodePath || relevantNodes.has(issue.nodePath)),
        );
        if (relevantErrors.length > 0) {
          const totalErrors = validationResult.issues.filter((i) => i.severity === 'error').length;
          const skippedErrors = totalErrors - relevantErrors.length;
          let msg = `Error: build-context blocked by ${relevantErrors.length} error(s) affecting this node's context.\n`;
          if (skippedErrors > 0) {
            msg += `(${skippedErrors} unrelated error(s) in other nodes ignored.)\n`;
          }
          for (const err of relevantErrors) {
            const loc = err.nodePath ? `${err.nodePath}: ` : '';
            msg += `  ${err.code ?? ''} ${loc}${err.message}\n`;
          }
          process.stderr.write(msg);
          process.exit(1);
        }

        const pkg = await buildContext(graph, nodePath);
        const warningThreshold = graph.config.quality?.context_budget.warning ?? 10000;
        const errorThreshold = graph.config.quality?.context_budget.error ?? 20000;
        const budgetStatus =
          pkg.tokenCount >= errorThreshold
            ? 'error'
            : pkg.tokenCount >= warningThreshold
              ? 'warning'
              : 'ok';

        let output = formatContextText(pkg);
        output += `Budget status: ${budgetStatus}\n`;
        process.stdout.write(output);

        if (budgetStatus === 'error') {
          process.stderr.write(
            `Warning: context package exceeds error budget (${pkg.tokenCount} >= ${errorThreshold}). Consider splitting the node.\n`,
          );
        }
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
