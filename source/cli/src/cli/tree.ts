import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import type { GraphNode, Graph } from '../model/graph.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { computeExpectedPairs, type TypeCoverageInput } from '../core/pairs.js';
import { readLock } from '../io/lock-store.js';
import { verifyPairs } from '../core/verify-lock.js';
import { fail } from './output.js';
import { escapeControls } from '../utils/terminal-safe.js';

/** Schema id of `yg tree --json`. */
export const TREE_JSON_SCHEMA = 'yg-tree/1';

/** One node of the tree, as `yg tree --json` reports it. */
export interface TreeJsonNode {
  path: string;
  type: string;
  /** The whole description, or null when the node has none. */
  description: string | null;
  parent: string | null;
  /** 0 for a root of the listing, one more per level below it. */
  depth: number;
}

/** The whole `yg tree --json` document. */
export interface TreeJsonDocument {
  schema: typeof TREE_JSON_SCHEMA;
  root: string | null;
  maxDepth: number | null;
  nodes: TreeJsonNode[];
  /** Files covered by their architecture type alone, repo-wide; null when type-level coverage is off. */
  typeCovered: TypeCoveredCounts | null;
}

/** Longest a listing line's description runs before it is cut (the whole text is under --long / --json). */
const SHORT_DESCRIPTION_MAX = 120;

/**
 * A description as one listing line shows it: its first sentence, whitespace
 * collapsed onto one line, cut at a word boundary past SHORT_DESCRIPTION_MAX
 * with an ellipsis. A long, multi-paragraph description used to print whole —
 * hundreds of kilobytes on a large graph, most of it spilled lines that no
 * longer started with a path.
 */
export function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const firstSentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (firstSentence.length <= SHORT_DESCRIPTION_MAX) return firstSentence;
  const slice = firstSentence.slice(0, SHORT_DESCRIPTION_MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('List graph nodes, one line each: path, type, first sentence of the description (each parent before its children)')
    .option('--root <path>', 'Show only subtree rooted at this path')
    .option('--depth <n>', 'Maximum depth', (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new InvalidArgumentError('--depth must be a non-negative integer.');
      }
      return n;
    })
    .option('--long', 'Print each description whole instead of its first sentence')
    .option('--json', 'Print the tree as a yg-tree/1 JSON document (whole descriptions)')
    .action(async (options: { root?: string; depth?: number; long?: boolean; json?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        let roots: GraphNode[];
        const scopedToRoot = Boolean(options.root?.trim());
        const rootPath = scopedToRoot ? (options.root as string).trim().replace(/\/$/, '') : null;

        if (rootPath !== null) {
          const node = graph.nodes.get(rootPath);
          if (!node) {
            fail({
              what: `Node '${rootPath}' not found.`,
              why: `The --root path must be a valid node path in the graph.`,
              next: `Run yg tree (no --root) to list all nodes, then pick a valid path.`,
            }, 'node-not-found');
            process.exit(1);
          }
          roots = [node];
        } else {
          roots = [...graph.nodes.values()]
            .filter((n) => n.parent === null)
            .sort((a, b) => a.path.localeCompare(b.path));
        }

        const nodes: TreeJsonNode[] = [];
        for (const root of roots) {
          collectNodes(root, nodes, 0, options.depth);
        }
        const counts = await typeCoveredCounts(graph);

        if (options.json === true) {
          const doc: TreeJsonDocument = {
            schema: TREE_JSON_SCHEMA,
            root: rootPath,
            maxDepth: options.depth ?? null,
            nodes,
            typeCovered: counts ?? null,
          };
          process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
          return;
        }

        for (const n of nodes) {
          const desc = n.description === null ? '' : options.long === true ? n.description : shortDescription(n.description);
          // Node paths, types and descriptions are repository text: shown, never obeyed by the terminal.
          const line = desc !== '' ? `${n.path} [${n.type}] — ${desc}` : `${n.path} [${n.type}]`;
          process.stdout.write(`${escapeControls(line)}\n`);
        }
        // An empty graph must still say it ran: a blank listing reads as a
        // failure. (--root always names an existing node, so it never lands here.)
        if (nodes.length === 0) {
          process.stdout.write('no nodes yet\nnext: yg knowledge read onboarding  (how to map existing code)\n');
        }

        const summary = counts !== undefined ? typeCoveredSummaryLine(counts, scopedToRoot) : undefined;
        if (summary) process.stdout.write(summary + '\n');
      } catch (error) {
        abortOnUnexpectedError(error, 'building the tree');
      }
    });
}

/** Files covered by their architecture type alone, split by what runs on them. */
export interface TypeCoveredCounts {
  total: number;
  /** Checked by at least one rule. */
  enforced: number;
  /** Of `enforced`: files with no recorded verdict for at least one of their rules. */
  unverifiedEnforced: number;
  /** Matched a type with nothing that applies. */
  unenforced: number;
  /** Whose rules could not be worked out (an aspect implies cycle). */
  uncomputable: number;
}

/** The type-covered counts, repo-wide; undefined when type-level coverage is off. */
async function typeCoveredCounts(graph: Graph): Promise<TypeCoveredCounts | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const projectRoot = path.dirname(graph.rootPath);
  const files = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, files);
  const coverage = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  const total = coverage.covered.size;
  if (total === 0) return { total, enforced: 0, unverifiedEnforced: 0, unenforced: 0, uncomputable: 0 };

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
  let unverifiedEnforced = 0;
  try {
    const lock = readLock(graph.rootPath);
    const nodelessPairs = expected.pairs.filter((p) => p.nodePath === undefined);
    const verified = await verifyPairs(graph, lock, nodelessPairs, typeCoverageInput);
    const unverifiedFiles = new Set<string>();
    for (const vp of verified) {
      if (vp.state.kind === 'verified' || vp.state.kind === 'refused') continue;
      for (const f of vp.pair.subjectFiles) unverifiedFiles.add(f);
    }
    for (const f of unverifiedFiles) if (enforcedFiles.has(f)) unverifiedEnforced += 1;
  } catch (e: unknown) {
    debugWrite(`[tree] lock read failed while building the unverified qualifier: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { total, enforced, unverifiedEnforced, unenforced, uncomputable };
}

/**
 * The type-covered summary line, printed AFTER the node listing. The listing
 * renders NODES only; this is the one place type-covered files are counted.
 * Always repo-wide — a type-covered file has no place in the hierarchy `--root`
 * scopes — and says so whenever `--root` narrowed the listing above it. The
 * total is split into checked, matched-but-unenforced and (when it occurs)
 * uncomputable, because a bare "N files covered" cannot tell those apart.
 */
function typeCoveredSummaryLine(c: TypeCoveredCounts, scopedToRoot: boolean): string {
  const noun = c.total === 1 ? 'type-covered file' : 'type-covered files';
  const scopeNote = scopedToRoot ? ' (repo-wide — type coverage has no subtree of its own to scope this to)' : '';
  const head = `\n${c.total} ${noun}, with no component of their own${scopeNote}`;
  if (c.total === 0) return `${head}.`;
  const enforcedNote = c.unverifiedEnforced > 0 ? ` (${c.unverifiedEnforced} with no recorded verdict for at least one of its rules)` : '';
  const parts = [`${c.enforced} checked by at least one rule${enforcedNote}`, `${c.unenforced} with nothing that applies`];
  if (c.uncomputable > 0) {
    parts.push(`${c.uncomputable} whose rules could not be worked out (aspect implies cycle)`);
  }
  return `${head}: ${parts.join(', ')}.`;
}

function collectNodes(
  node: GraphNode,
  out: TreeJsonNode[],
  depth: number,
  maxDepth: number | undefined,
): void {
  const desc = node.meta.description?.trim();
  out.push({
    path: node.path,
    type: node.meta.type,
    description: desc !== undefined && desc !== '' ? desc : null,
    parent: node.parent?.path ?? null,
    depth,
  });

  if (maxDepth !== undefined && depth >= maxDepth) return;

  const children = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
  for (const child of children) {
    collectNodes(child, out, depth + 1, maxDepth);
  }
}
