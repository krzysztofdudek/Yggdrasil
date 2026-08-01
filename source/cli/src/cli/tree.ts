import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { GraphNode, Graph } from '../model/graph.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverage } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { computeExpectedPairs, type TypeCoverageInput } from '../core/pairs.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Display graph structure as a flat list')
    .option('--root <path>', 'Show only subtree rooted at this path')
    .option('--depth <n>', 'Maximum depth', (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new InvalidArgumentError('--depth must be a non-negative integer.');
      }
      return n;
    })
    .action(async (options: { root?: string; depth?: number }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        let roots: GraphNode[];
        const scopedToRoot = Boolean(options.root?.trim());

        if (scopedToRoot) {
          const rootPath = (options.root as string).trim().replace(/\/$/, '');
          const node = graph.nodes.get(rootPath);
          if (!node) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Node '${rootPath}' not found.`,
              why: `The --root path must be a valid node path in the graph.`,
              next: `Run yg tree (no --root) to list all nodes, then pick a valid path.`,
            })}\n`));
            process.exit(1);
          }
          roots = [node];
        } else {
          roots = [...graph.nodes.values()]
            .filter((n) => n.parent === null)
            .sort((a, b) => a.path.localeCompare(b.path));
        }

        const lines: string[] = [];
        for (const root of roots) {
          collectNodes(root, lines, 0, options.depth);
        }

        for (const line of lines) {
          process.stdout.write(line + '\n');
        }

        const summary = await typeCoveredSummaryLine(graph, scopedToRoot);
        if (summary) process.stdout.write(summary + '\n');
      } catch (error) {
        abortOnUnexpectedError(error, 'building the tree');
      }
    });
}

/**
 * The optional type-covered summary line, printed AFTER the node listing.
 * `undefined` when the flag is off — byte-identical to today in that case.
 * The tree's node listing renders NODES only (no synthetic entry for a
 * type-covered file); this is the one place their count is surfaced.
 *
 * A type-covered file has no place in the graph hierarchy `--root` scopes —
 * unlike a node, it carries no parent/child structure to narrow. Rather than
 * fabricate a scoped count from a heuristic that could silently be wrong for
 * a real project's source layout, the count is always repo-wide, and an
 * explicit "repo-wide" qualifier is added whenever `--root` narrowed the node
 * listing above it — so the line can never be misread as "these files are
 * under the subtree you asked for".
 *
 * The total is split the same way the portal's own residue chips split it —
 * checked (at least one applicable rule), unenforced (matched a type with
 * nothing that applies), and, when it occurs, uncomputable (an aspect
 * `implies` cycle stopped the type's rules from ever being resolved for the
 * file — the honest answer there is unknown, never folded into "nothing
 * applies"). Bare "N files satisfied" would read as a single, undifferentiated
 * pass; a reader cannot tell "checked" from "matched but unguarded" from a
 * count alone, which is exactly the ambiguity `yg owner --file` and the
 * portal's own ledger already resolve per file.
 */
async function typeCoveredSummaryLine(graph: Graph, scopedToRoot: boolean): Promise<string | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const projectRoot = path.dirname(graph.rootPath);
  const files = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, files);
  const coverage = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  const count = coverage.covered.size;
  const noun = count === 1 ? 'file is' : 'files are';
  const scopeNote = scopedToRoot ? ' (repo-wide — the type-level lattice has no subtree of its own to scope this to)' : '';
  const head = `\n${count} ${noun} satisfied by the type-level lattice, no component of their own${scopeNote}`;
  if (count === 0) return `${head}.`;

  // The SAME nodeless expected-pair computation `yg check` and the portal both read this split
  // from — never a re-implementation of "what counts as enforced".
  const typeCoverageInput: TypeCoverageInput = {
    covered: coverage.covered,
    ambiguousPaths: coverage.ambiguous.map((a) => a.file),
  };
  const expected = await computeExpectedPairs(graph, { typeCoverage: typeCoverageInput });
  const enforcedFiles = new Set<string>();
  for (const p of expected.pairs) {
    if (p.nodePath !== undefined) continue;
    for (const f of p.subjectFiles) enforcedFiles.add(f);
  }
  const uncomputableFiles = new Set(expected.uncomputableTypeCoverage.map((u) => u.file));
  let enforced = 0;
  let unenforced = 0;
  let uncomputable = 0;
  for (const file of coverage.covered.keys()) {
    if (uncomputableFiles.has(file)) uncomputable += 1;
    else if (enforcedFiles.has(file)) enforced += 1;
    else unenforced += 1;
  }
  const parts = [`${enforced} checked by at least one rule`, `${unenforced} with nothing that applies`];
  if (uncomputable > 0) {
    parts.push(`${uncomputable} whose rules could not be worked out (aspect implies cycle)`);
  }
  return `${head}: ${parts.join(', ')}.`;
}

function collectNodes(
  node: GraphNode,
  lines: string[],
  depth: number,
  maxDepth: number | undefined,
): void {
  const desc = node.meta.description?.trim();
  const line = desc
    ? `${node.path} [${node.meta.type}] — ${desc}`
    : `${node.path} [${node.meta.type}]`;
  lines.push(line);

  if (maxDepth !== undefined && depth >= maxDepth) return;

  const children = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
  for (const child of children) {
    collectNodes(child, lines, depth + 1, maxDepth);
  }
}
