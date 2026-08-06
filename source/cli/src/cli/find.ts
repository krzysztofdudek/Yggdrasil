import type { Command } from 'commander';
import chalk from 'chalk';
import { debugWrite } from '../utils/debug-log.js';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { buildIndex, createMiniSearch } from '../io/find-index.js';
import type { IndexedDocument, TypeCoveredIndexEntry } from '../io/find-index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { toPosixPath } from '../utils/posix.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';

const TOP_N = 5;

export async function findCommand(query: string, projectRoot: string): Promise<number> {
  if (!query || query.trim() === '') {
    process.stderr.write(
      chalk.red(
        buildIssueMessage({
          what: 'Query is required',
          why: 'yg find needs at least one keyword to search.',
          next: 'Usage: yg find "<query keywords>"',
        }),
      ) + '\n',
    );
    return 1;
  }

  // Unexpected errors are NOT caught here: they propagate to the single funnel in
  // registerFindCommand's action handler, which routes them through
  // abortOnUnexpectedError (the canonical command-contract path). loadGraphOrAbort
  // already exits cleanly on a missing graph; non-ENOENT loader failures rethrow.
  const graph = await loadGraphOrAbort(projectRoot);
  // Type-covered files (coverage.type_level) join the searchable index, keyed by
  // their matched type's own description — omitted entirely at flag-off, so a
  // flag-off caller pays no classification pass and gets byte-identical output.
  let typeCoverage: TypeCoveredIndexEntry[] | undefined;
  if (graph.config.coverage?.typeLevel) {
    const files = await walkRepoFiles(projectRoot);
    const uncovered = scanUncoveredFiles(graph, files);
    const coverage = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
    typeCoverage = [...coverage.covered.entries()].map(([file, typeId]) => ({ file, typeId }));
  }
  const docs = await buildIndex(graph, typeCoverage);
  if (docs.length === 0) {
    process.stdout.write('Empty graph, nothing to search.\n');
    return 0;
  }

  const ms = createMiniSearch();
  ms.addAll(docs);
  const results = ms.search(query.trim()).slice(0, TOP_N);
  if (results.length === 0) {
    process.stdout.write('No matches.\n');
    process.stdout.write(
      '\nNext: run yg tree for the full graph, or re-query with sharper keywords.\n',
    );
    return 0;
  }

  // Normalize the raw MiniSearch relevance scores (TF-IDF-ish, unbounded and
  // query-dependent — e.g. 2.94) to a 0–1 scale RELATIVE to the best match, so
  // the rendered score is interpretable: the top result is 1.00 and the rest are
  // its fraction. results are score-sorted, so results[0] carries the max.
  const maxScore = results[0]?.score ?? 0;
  process.stdout.write('Top entry points (ranked by relevance):\n\n');
  // The top result's document drives the terminal Next line (node vs aspect).
  let topDoc: IndexedDocument | undefined;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const doc = docs.find((d) => d.id === r.id) as IndexedDocument | undefined;
    /* v8 ignore next */
    if (!doc) continue;
    if (i === 0) topDoc = doc;
    // Collapse the matched-term list: MiniSearch fuzzy/prefix expansion can
    // surface many near-duplicate stems (order, orders, ordering, …). Dedupe
    // case-insensitively and cap the rendered list so the line stays scannable.
    const MATCHED_TERM_CAP = 6;
    const uniqueTerms: string[] = [];
    const seenTerms = new Set<string>();
    for (const term of r.terms ?? []) {
      const key = term.toLowerCase();
      if (seenTerms.has(key)) continue;
      seenTerms.add(key);
      uniqueTerms.push(term);
    }
    const shownTerms = uniqueTerms.slice(0, MATCHED_TERM_CAP);
    const overflow = uniqueTerms.length - shownTerms.length;
    const matched =
      shownTerms.join(', ') + (overflow > 0 ? ` (+${overflow} more)` : '');
    const score = (maxScore > 0 ? (r.score ?? 0) / maxScore : 0).toFixed(2);
    const docPath = toPosixPath(doc.path);
    process.stdout.write(`${i + 1}. ${docPath.padEnd(40)} score: ${score}\n`);
    process.stdout.write(`   Kind: ${doc.kind}\n`);
    if (doc.type) process.stdout.write(`   Type: ${doc.type}\n`);
    if (doc.kind === 'aspect') {
      process.stdout.write(`   status: ${doc.status ?? 'enforced'}\n`);
    }
    process.stdout.write(`   Description: "${doc.description}"\n`);
    if (matched) process.stdout.write(`   Matched: ${matched}\n`);
    process.stdout.write('\n');
  }

  // Terminal Next: derived from the TOP result's Kind. A node result is an
  // entry-point — point the agent at its full context. An aspect result is a
  // rule, not a node — tell the agent to read it and NOT pass it to --node. A
  // file result is type-covered — it has no yg-node.yaml at all, so it is
  // addressed by --file, never --node.
  if (topDoc) {
    if (topDoc.kind === 'node') {
      // Strip the leading `model/` so the path is a valid --node argument.
      const nodeArg = toPosixPath(topDoc.path).replace(/^model\//, '');
      process.stdout.write(`Next: yg context --node ${nodeArg}\n`);
    } else if (topDoc.kind === 'file') {
      process.stdout.write(`Next: yg context --file ${toPosixPath(topDoc.path)}\n`);
    } else {
      process.stdout.write(
        `Next: read .yggdrasil/${toPosixPath(topDoc.path)} — this is a rule, not an entry-point node (do not pass it to --node).\n`,
      );
    }
  }
  return 0;
}

export function registerFindCommand(program: Command): void {
  program
    .command('find')
    .description('Locate entry points (nodes / aspects / type-covered files) by natural-language query')
    .argument('<query>', 'Search keywords (English)')
    .action(async (query: string) => {
      try {
        const exit = await findCommand(query, process.cwd());
        process.exit(exit);
      } catch (error) {
        debugWrite(`[find] registerFindCommand action failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'running find');
      }
    });
}
