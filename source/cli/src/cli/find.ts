import type { Command } from 'commander';
import { debugWrite } from '../utils/debug-log.js';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { buildIndex, createMiniSearch } from '../io/find-index.js';
import type { IndexedDocument, TypeCoveredIndexEntry } from '../io/find-index.js';
import { toPosixPath } from '../utils/posix.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { fail, writeOut, warn } from './output.js';

const TOP_N = 5;

/** Schema id of `yg find --json`. */
export const FIND_JSON_SCHEMA = 'yg-find/1';

/** One ranked result, as `yg find --json` reports it. */
export interface FindJsonResult {
  kind: 'node' | 'aspect' | 'file';
  /** A node's path (a valid --node argument), a rule's id, or a file's path. */
  id: string;
  type: string | null;
  /** A rule's default status; null for anything else. */
  status: string | null;
  description: string;
  /** Relevance relative to the best match (1 for the top result). */
  score: number;
  matched: string[];
  /** The command that shows this result's context, or null for a rule (read its file). */
  next: string | null;
}

/** The address a result is passed on by: a node without its `model/` prefix, a rule by id. */
function resultId(doc: IndexedDocument): string {
  const p = toPosixPath(doc.path);
  if (doc.kind === 'node') return p.replace(/^model\//, '');
  if (doc.kind === 'aspect') return p.replace(/^aspects\//, '').replace(/\/(yg-aspect\.yaml|content\.md|check\.mjs)$/, '');
  return p;
}

export async function findCommand(query: string, projectRoot: string, opts: { json?: boolean } = {}): Promise<number> {
  if (!query || query.trim() === '') {
    fail({
          what: 'Query is required',
          why: 'yg find needs at least one keyword to search.',
          next: 'Usage: yg find "<query keywords>"',
        });
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
  const docs = await buildIndex(graph, typeCoverage, (m) => { warn(m); });
  if (docs.length === 0) {
    writeOut(opts.json === true
      ? `${JSON.stringify({ schema: FIND_JSON_SCHEMA, query: query.trim(), results: [] }, null, 2)}\n`
      : 'Empty graph, nothing to search.\n');
    return 0;
  }

  const ms = createMiniSearch();
  ms.addAll(docs);
  const results = ms.search(query.trim()).slice(0, TOP_N);
  if (opts.json === true) {
    const maxScoreJson = results[0]?.score ?? 0;
    const rows: FindJsonResult[] = [];
    for (const r of results) {
      const doc = docs.find((d) => d.id === r.id);
      if (!doc) continue;
      const id = resultId(doc);
      rows.push({
        kind: doc.kind,
        id,
        type: doc.type ?? null,
        status: doc.kind === 'aspect' ? (doc.status ?? 'enforced') : null,
        description: doc.description,
        score: maxScoreJson > 0 ? Number(((r.score ?? 0) / maxScoreJson).toFixed(2)) : 0,
        matched: [...new Set((r.terms ?? []).map((t) => t.toLowerCase()))],
        next: doc.kind === 'node' ? `yg context --node ${id}` : doc.kind === 'file' ? `yg context --file ${id}` : null,
      });
    }
    writeOut(`${JSON.stringify({ schema: FIND_JSON_SCHEMA, query: query.trim(), results: rows }, null, 2)}\n`);
    return 0;
  }
  if (results.length === 0) {
    writeOut('No matches.\n');
    writeOut(
      '\nnext: run yg tree for the full graph, or re-query with sharper keywords.\n',
    );
    return 0;
  }

  // Normalize the raw MiniSearch relevance scores (TF-IDF-ish, unbounded and
  // query-dependent — e.g. 2.94) to a 0–1 scale RELATIVE to the best match, so
  // the rendered score is interpretable: the top result is 1.00 and the rest are
  // its fraction. results are score-sorted, so results[0] carries the max.
  const maxScore = results[0]?.score ?? 0;
  writeOut('Top entry points (ranked by relevance):\n\n');
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
    writeOut(`${i + 1}. ${docPath.padEnd(40)} score: ${score}\n`);
    writeOut(`   Kind: ${doc.kind}\n`);
    if (doc.type) writeOut(`   Type: ${doc.type}\n`);
    if (doc.kind === 'aspect') {
      writeOut(`   status: ${doc.status ?? 'enforced'}\n`);
    }
    writeOut(`   Description: "${doc.description}"\n`);
    if (matched) writeOut(`   Matched: ${matched}\n`);
    writeOut('\n');
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
      writeOut(`next: yg context --node ${nodeArg}\n`);
    } else if (topDoc.kind === 'file') {
      writeOut(`next: yg context --file ${toPosixPath(topDoc.path)}\n`);
    } else {
      writeOut(
        `next: read .yggdrasil/${toPosixPath(topDoc.path)} — this is a rule, not an entry-point node (do not pass it to --node).\n`,
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
    .option('--json', 'Print the ranked results as a yg-find/1 JSON document')
    .action(async (query: string, options: { json?: boolean }) => {
      try {
        const exit = await findCommand(query, process.cwd(), { json: options.json === true });
        process.exit(exit);
      } catch (error) {
        debugWrite(`[find] registerFindCommand action failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'running find');
      }
    });
}
