import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { collectAncestors, buildNodeContextData, buildFileContextData } from '../core/context-builder.js';
import { formatNodeContext } from '../formatters/context-node.js';
import { formatFileContext } from '../formatters/context-file.js';
import { validate } from '../core/validator.js';
import { findOwner } from './owner.js';
import { normalizeMappingPaths, projectRootFromGraph } from '../utils/paths.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Graph } from '../model/graph.js';

type CandidateNode = { nodePath: string; fileCount: number };

function findCandidateNodes(graph: Graph, unmappedFile: string): CandidateNode[] {
  const dir = unmappedFile.replace(/\/[^/]+$/, '');
  if (!dir || dir === unmappedFile) return [];

  const candidates = new Map<string, number>();

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    let count = 0;
    for (const mp of mappingPaths) {
      const mpNorm = mp.replace(/\\/g, '/').replace(/\/+$/, '');
      const mpDir = mpNorm.replace(/\/[^/]+$/, '');
      if (mpDir === dir) {
        count++;
      }
    }
    if (count > 0) {
      candidates.set(nodePath, count);
    }
  }

  return Array.from(candidates.entries())
    .map(([nodePath, fileCount]) => ({ nodePath, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function collectRelevantNodePaths(graph: Graph, nodePath: string): Set<string> {
  const relevant = new Set<string>();
  const node = graph.nodes.get(nodePath);
  if (!node) return relevant;

  relevant.add(nodePath);

  // Ancestors (hierarchy)
  for (const ancestor of collectAncestors(node)) {
    relevant.add(ancestor.path);
  }

  // Direct relation targets + their ancestors
  for (const rel of node.meta.relations ?? []) {
    relevant.add(rel.target);
    const target = graph.nodes.get(rel.target);
    if (target) {
      for (const ancestor of collectAncestors(target)) {
        relevant.add(ancestor.path);
      }
    }
  }

  return relevant;
}

export function registerBuildCommand(program: Command): void {
  const contextAction = async (options: { node?: string; file?: string }) => {
      try {
        if (!options.node && !options.file) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: "No target specified.",
            why: "Either '--node <path>' or '--file <path>' is required.",
            next: "Run: yg context --node <path> or yg context --file <path>",
          }) + '\n'));
          process.exit(1);
        }
        if (options.node && options.file) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: "Conflicting options.",
            why: "'--node' and '--file' are mutually exclusive.",
            next: "Use one or the other, not both.",
          }) + '\n'));
          process.exit(1);
        }

        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        let nodePath: string;
        let resolvedFilePath: string | undefined;

        if (options.file) {
          const repoRoot = projectRootFromGraph(graph.rootPath);
          const result = findOwner(graph, repoRoot, options.file.trim());
          if (!result.nodePath) {
            const candidates = findCandidateNodes(graph, result.file);
            if (candidates.length > 0) {
              let candidatesList = '';
              for (const c of candidates) {
                candidatesList += `  - ${c.nodePath} (${c.fileCount} file${c.fileCount === 1 ? '' : 's'} in same dir)\n`;
              }
              const msg = buildIssueMessage({
                what: `${result.file} has no graph coverage.`,
                why: `File is not mapped to any node. Other files in the same directory are mapped to these nodes:\n${candidatesList}This suggests the file should be added to one of them.`,
                next: 'Use: yg context --node <node-path>',
              });
              process.stderr.write(chalk.red(`${msg}\n`));
            } else {
              const noGraphMsg = buildIssueMessage({
                what: `${result.file} has no graph coverage.`,
                why: 'File is not mapped to any node and no candidate nodes found in the same directory.',
                next: 'Add the file to an existing node mapping, or create a new node.',
              });
              process.stderr.write(chalk.red(`${noGraphMsg}\n`));
            }
            process.exit(1);
          }
          process.stderr.write(`${result.file} -> ${result.nodePath}\n`);
          nodePath = result.nodePath;
          resolvedFilePath = result.file;
        } else {
          nodePath = options.node!.trim().replace(/^\.\//, '').replace(/\/$/, '');
        }

        const relevantNodes = collectRelevantNodePaths(graph, nodePath);

        const validationResult = await validate(graph, 'all');
        const relevantErrors = validationResult.issues.filter(
          (issue) =>
            issue.severity === 'error' &&
            (!issue.nodePath || relevantNodes.has(issue.nodePath)),
        );
        if (relevantErrors.length > 0) {
          const totalErrors = validationResult.issues.filter((i) => i.severity === 'error').length;
          const skippedErrors = totalErrors - relevantErrors.length;
          let errorList = '';
          for (const err of relevantErrors) {
            const loc = err.nodePath ? `${err.nodePath}: ` : '';
            errorList += `  ${err.code ?? ''} ${loc}${err.message}\n`;
          }
          let whyText = 'Context cannot be assembled when structural errors exist.';
          if (skippedErrors > 0) {
            whyText += ` (${skippedErrors} unrelated error(s) in other nodes ignored.)`;
          }
          const msg = buildIssueMessage({
            what: `build-context blocked by ${relevantErrors.length} error${relevantErrors.length === 1 ? '' : 's'} affecting this node's context.`,
            why: whyText,
            next: `Run yg check and fix the listed errors first:\n${errorList}`,
          });
          process.stderr.write(chalk.red(`Error: ${msg}\n`));
          process.exit(1);
        }

        if (resolvedFilePath) {
          const data = buildFileContextData(graph, resolvedFilePath, nodePath);
          process.stdout.write(formatFileContext(data));
        } else {
          const data = buildNodeContextData(graph, nodePath);
          process.stdout.write(formatNodeContext(data));
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            chalk.red(buildIssueMessage({
              what: 'No .yggdrasil/ directory found.',
              why: 'Yggdrasil is not initialized in this project.',
              next: "Run 'yg init' to initialize.",
            }) + '\n'),
          );
        } else {
          process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
        }
        process.exit(1);
      }
  };

  // Primary command: `yg context`
  program
    .command('context')
    .description('Assemble a context package for one node')
    .option('--node <node-path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .action(contextAction);

}
