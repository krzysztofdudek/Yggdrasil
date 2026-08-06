import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import type { AspectStatus, Graph } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export interface IndexedDocument {
  id: string;
  kind: 'node' | 'aspect' | 'file';
  path: string;
  /** For 'node': the node's type. For 'file': the matched classifying type id. Absent for 'aspect'. */
  type?: string;
  name: string;
  description: string;
  body: string;
  /** Aspect-default status — populated only for `kind: 'aspect'` documents */
  status?: AspectStatus;
}

/**
 * A type-covered file's classification, pre-flattened from
 * `computeTypeCoverage(...).covered` (a `Map<file, typeId>`) into the plain
 * array shape a caller can build once per invocation. `buildIndex` never
 * classifies on its own — a caller with the flag off, or one that has not
 * computed coverage, simply omits this argument.
 */
export interface TypeCoveredIndexEntry {
  file: string;
  typeId: string;
}

/**
 * `typeCoverage` is optional and omitted or empty produces byte-identical
 * output to today — no 'file' documents at all, so a flag-off or coverage-less
 * caller pays nothing beyond the argument itself.
 */
export async function buildIndex(graph: Graph, typeCoverage?: TypeCoveredIndexEntry[]): Promise<IndexedDocument[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const docs: IndexedDocument[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const displayPath = `model/${nodePath}/`;
    const logPath = path.join(graph.rootPath, 'model', nodePath, 'log.md');
    let body = '';
    try {
      const st = await lstat(logPath);
      if (!st.isSymbolicLink() && st.nlink === 1) {
        const raw = await readFile(logPath, 'utf-8');
        const truncated = truncateTail(raw, MAX_BODY_BYTES);
        if (truncated !== raw) {
          process.stderr.write(
            `log.md for node '${nodePath}' exceeds 1 MiB — body truncated for indexing\nLarge logs are truncated to keep search index memory bounded.\nThis does not affect append-only integrity. No action required.\n`,
          );
        }
        body = truncated;
      } else if (st.isSymbolicLink()) {
        process.stderr.write(`Warning: skipping symlinked log.md at ${path.relative(projectRoot, logPath)}\n`);
      /* v8 ignore next 2 -- hardlink (nlink>1, !symlink): skip silently; not testable without root */
      } else {
        /* skip hardlink */
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      debugWrite(`[find-index] log.md read for ${nodePath}: ${e.message}`);
      if (e.code !== 'ENOENT') {
        process.stderr.write(
          `Cannot read log.md for node '${nodePath}': ${e.message}\nNode will be indexed without log body — search results may be less relevant.\nCheck file permissions or restore from git.\n`,
        );
      }
    }

    docs.push({
      id: `node:${nodePath}`,
      kind: 'node',
      path: displayPath,
      type: node.meta.type,
      name: node.meta.name,
      description: node.meta.description ?? '',
      body,
    });
  }

  for (const aspect of graph.aspects) {
    const displayPath = `aspects/${aspect.id}`;
    let body = '';
    if (aspect.reviewer.type !== 'deterministic') {
      // only content.md (exact filename), not any *.md artifact
      const contentFiles = aspect.artifacts.filter((a) => a.filename === 'content.md');
      body = contentFiles.map((a) => a.content).join('\n\n');
    }
    docs.push({
      id: `aspect:${aspect.id}`,
      kind: 'aspect',
      path: displayPath,
      name: aspect.name,
      description: aspect.description ?? '',
      body,
      status: aspect.status ?? 'enforced',
    });
  }

  // Type-covered files: satisfied by the type-level lattice (coverage.type_level),
  // no yg-node.yaml of their own. Indexed with the MATCHED TYPE's own description
  // as searchable text (types carry required descriptions) — never a phantom node,
  // and never routed to `yg context --node`, which has nothing to look up for a
  // file no node maps. Omitted entirely when `typeCoverage` is absent or empty, so
  // a flag-off caller's output stays byte-identical to today.
  for (const entry of typeCoverage ?? []) {
    const typeDef = graph.architecture.node_types[entry.typeId];
    docs.push({
      id: `file:${entry.file}`,
      kind: 'file',
      path: entry.file,
      type: entry.typeId,
      name: path.basename(entry.file),
      description: typeDef?.description ?? '',
      body: '',
    });
  }

  return docs;
}

export function createMiniSearch(): MiniSearch<IndexedDocument> {
  return new MiniSearch<IndexedDocument>({
    fields: ['name', 'description', 'body'],
    storeFields: ['id', 'kind', 'path', 'type', 'name', 'description', 'status'],
    searchOptions: {
      boost: { description: 3, name: 2, body: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

/**
 * Truncate to maxBytes keeping tail (newest entries).
 * Cut precedence: entry-aligned → line-aligned → hard cut.
 */
function truncateTail(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= maxBytes) return content;
  const dropOffset = buf.length - maxBytes;
  let cut = dropOffset;
  const headerIdx = buf.indexOf(Buffer.from('\n## [', 'utf-8'), dropOffset);
  if (headerIdx !== -1) {
    cut = headerIdx + 1;
  } else {
    const nlIdx = buf.indexOf(0x0a, dropOffset);
    /* v8 ignore next */
    if (nlIdx !== -1 && nlIdx + 1 <= buf.length) cut = nlIdx + 1;
  }
  return buf.subarray(cut).toString('utf-8');
}
