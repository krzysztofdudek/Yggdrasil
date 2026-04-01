import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { buildContext, collectAncestors, toContextMapOutput } from '../core/context-builder.js';
import { formatContextYaml, formatFullContent } from '../formatters/context-text.js';
import { validate } from '../core/validator.js';
import { findOwner } from './owner.js';
import { normalizeMappingPaths, projectRootFromGraph } from '../utils/paths.js';
import type { Graph } from '../model/types.js';

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
  const contextAction = async (options: { node?: string; file?: string; full?: boolean }) => {
      try {
        if (!options.node && !options.file) {
          process.stderr.write("Error: either '--node <path>' or '--file <path>' is required\n");
          process.exit(1);
        }
        if (options.node && options.file) {
          process.stderr.write("Error: '--node' and '--file' are mutually exclusive\n");
          process.exit(1);
        }

        const graph = await loadGraph(process.cwd());
        let nodePath: string;

        if (options.file) {
          const repoRoot = projectRootFromGraph(graph.rootPath);
          const result = findOwner(graph, repoRoot, options.file.trim());
          if (!result.nodePath) {
            const candidates = findCandidateNodes(graph, result.file);
            if (candidates.length > 0) {
              let msg = `${result.file} -> no graph coverage\n`;
              msg += `\nCandidate nodes (other files in the same directory are mapped to these nodes):\n`;
              for (const c of candidates) {
                msg += `  - ${c.nodePath} (${c.fileCount} file${c.fileCount === 1 ? '' : 's'} in same dir)\n`;
              }
              msg += `\nUse: yg build-context --node <node-path>\n`;
              process.stderr.write(msg);
            } else {
              process.stderr.write(`${result.file} -> no graph coverage\n`);
            }
            process.exit(1);
          }
          process.stderr.write(`${result.file} -> ${result.nodePath}\n`);
          nodePath = result.nodePath;
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
        const mapOutput = toContextMapOutput(pkg, graph);

        let output = formatContextYaml(mapOutput);

        if (options.full) {
          const seen = new Set<string>();
          const allFiles: Array<{ path: string; content: string }> = [];

          async function collectFile(filePath: string): Promise<void> {
            if (seen.has(filePath)) return;
            seen.add(filePath);
            const content = await findFileContent(filePath, graph);
            if (content !== undefined) {
              allFiles.push({ path: filePath, content });
            }
          }

          // Glossary files
          for (const aspect of Object.values(mapOutput.glossary.aspects)) {
            for (const f of aspect.files) await collectFile(f);
          }
          for (const flow of Object.values(mapOutput.glossary.flows)) {
            for (const f of flow.files) await collectFile(f);
          }

          // Node files
          for (const f of mapOutput.node.files) await collectFile(f);

          // Hierarchy files
          for (const ancestor of mapOutput.hierarchy) {
            for (const f of ancestor.files ?? []) await collectFile(f);
          }

          // Dependency files (including their hierarchy)
          for (const dep of mapOutput.dependencies) {
            for (const ancestor of dep.hierarchy) {
              for (const f of ancestor.files ?? []) await collectFile(f);
            }
            for (const f of dep.files ?? []) await collectFile(f);
          }

          output += formatFullContent(allFiles);
        }

        process.stdout.write(output);
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
  };

  // Primary command: `yg context`
  program
    .command('context')
    .description('Assemble a context package for one node')
    .option('--node <node-path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--full', 'Include artifact file contents in output')
    .action(contextAction);

  // Backward-compatible alias: `yg build-context`
  program
    .command('build-context')
    .description('(alias for context) Assemble a context package for one node')
    .option('--node <node-path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--full', 'Include artifact file contents in output')
    .action(contextAction);
}

/**
 * Find file content from the loaded graph data.
 * Paths are relative to .yggdrasil/ (e.g., "model/cli/core/loader/responsibility.md").
 */
async function findFileContent(filePath: string, graph: Graph): Promise<string | undefined> {
  if (filePath.startsWith('model/')) {
    const rest = filePath.slice('model/'.length);
    const parts = rest.split('/');
    const filename = parts.pop()!;
    const nodePath = parts.join('/');
    const node = graph.nodes.get(nodePath);
    if (!node) return undefined;
    const art = node.artifacts.find((a) => a.filename === filename);
    return art?.content;
  }
  if (filePath.startsWith('aspects/')) {
    const rest = filePath.slice('aspects/'.length);
    const parts = rest.split('/');
    const aspectId = parts[0];
    const filename = parts.slice(1).join('/');
    const aspect = graph.aspects.find((a) => a.id === aspectId);
    if (!aspect) return undefined;
    const art = aspect.artifacts.find((a) => a.filename === filename);
    return art?.content;
  }
  if (filePath.startsWith('flows/')) {
    const rest = filePath.slice('flows/'.length);
    const parts = rest.split('/');
    const flowPath = parts[0];
    const filename = parts.slice(1).join('/');
    const flow = graph.flows.find((f) => f.path === flowPath);
    if (!flow) return undefined;
    const art = flow.artifacts.find((a) => a.filename === filename);
    return art?.content;
  }
  return undefined;
}
