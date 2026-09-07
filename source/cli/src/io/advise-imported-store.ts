/**
 * source/cli/src/io/advise-imported-store.ts — the append-only, COMMITTED
 * register of proposals another tool handed this graph: the sanctioned writer
 * (and tolerant reader) of `.yggdrasil/advise-imported.jsonl`.
 *
 * It is the direct sibling of the advise-decisions register beside it, and for
 * the same reason: a proposal another tool measured is a fact about this
 * repository at a commit, it must survive across machines, and it must merge
 * cleanly across branches (`merge=union` via `.gitattributes`). Every line
 * carries its producer, the schema it arrived under, the commit it was measured
 * at, and the producer's own evidence VERBATIM — nothing is re-derived here, so
 * a reader can always tell what was measured from what this graph concluded.
 *
 * IMPORTING IS NOT ACCEPTING. A line here is a proposal in the feed and nothing
 * more; dismissing, deferring or acting on it stays the user's own act, recorded
 * in the decisions register exactly as for any other attention item.
 *
 * `appendImported` is the ONE writer (JSONL through the shared O_APPEND
 * single-write chokepoint) and a failed write is NOT swallowed — the caller must
 * learn its import was not recorded. `readImported` is tolerant / fail-open like
 * every other register reader here: an unknown `v`, a non-JSON line or a
 * mis-shaped record is counted (`skipped`) and dropped, never thrown, and a
 * missing file is a valid empty register.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { appendToDebugLog } from './debug-log-writer.js';

/** The imported-proposals register's filename, relative to the `.yggdrasil/` graph
 *  root. COMMITTED (it records what another tool measured); merges by union. */
export const ADVISE_IMPORTED_FILENAME = 'advise-imported.jsonl';

/**
 * The kinds of proposal a producer may hand over. They are the graph's OWN
 * vocabulary — a relation between two components, a component that wants
 * splitting, a contract that wants naming, a rule that wants writing — so an
 * unknown kind is refused at import rather than stored as an opaque suggestion
 * nobody can act on.
 */
export type ImportedAdviceKind = 'relation' | 'split' | 'port' | 'rule';

export const IMPORTED_ADVICE_KINDS: readonly ImportedAdviceKind[] = ['relation', 'split', 'port', 'rule'];

/** One line of the committed imported-proposals register. */
export interface ImportedAdvice {
  /** Line-schema version. Readers treat an absent `v` as v1. */
  v: 1;
  /** ISO 8601 UTC timestamp — from the importing command's clock. */
  ts: string;
  /**
   * Idempotence key: the proposal's kind, its components and the commit it was
   * measured at, folded to one hash. Re-importing the same document adds
   * nothing; a document measured at a NEW commit is a new proposal, because the
   * evidence behind it was taken again.
   */
  key: string;
  /** Which tool handed this over. */
  source: string;
  /** The document schema it arrived under, kept so a later reader can tell. */
  schema: string;
  /** The commit the producer measured at, or null when it named none. */
  at: string | null;
  kind: ImportedAdviceKind;
  /** The components the proposal is about, in the producer's own order. */
  nodes: string[];
  /** For a split: the components proposed to come out of it. */
  candidates?: string[];
  /** The producer's own confidence, when it gave one. */
  confidence?: number;
  /** The producer's evidence object, kept VERBATIM — never re-derived here. */
  evidence: Record<string, unknown>;
  /** The producer's own one-line statement of the proposal. */
  text: string;
}

/** Result of reading the committed imported-proposals register. */
export interface ReadImportedResult {
  /** Parsed proposals, in file (append) order. */
  imported: ImportedAdvice[];
  /** Count of dropped lines: unknown `v`, non-JSON, or a mis-shaped record. */
  skipped: number;
}

/** Type guard: a parsed JSON value that is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Absolute path of the register for a given `.yggdrasil/` root. */
export function importedPath(yggRootPath: string): string {
  return path.join(yggRootPath, ADVISE_IMPORTED_FILENAME);
}

/**
 * Append one imported proposal to the committed register.
 *
 * Deliberately NOT best-effort: a caller that believes it recorded a proposal
 * and did not would show a feed that silently loses what another tool measured.
 */
export async function appendImported(yggRootPath: string, record: ImportedAdvice): Promise<void> {
  appendToDebugLog(importedPath(yggRootPath), `${JSON.stringify(record)}\n`);
}

/**
 * Read the committed register, tolerantly. A missing file is a valid empty
 * register; a line this build cannot understand is counted and dropped rather
 * than thrown, so one hand-edited or future-versioned line never blocks the feed.
 */
export function readImported(yggRootPath: string): ReadImportedResult {
  let raw: string;
  try {
    raw = readFileSync(importedPath(yggRootPath), 'utf-8');
  } catch {
    return { imported: [], skipped: 0 };
  }

  const imported: ImportedAdvice[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (!isPlainObject(parsed)) {
      skipped++;
      continue;
    }
    // Forward-tolerance: an absent `v` reads as v1, anything else is a line a
    // later build wrote and this one must not pretend to understand.
    const version = parsed.v === undefined ? 1 : parsed.v;
    if (version !== 1) {
      skipped++;
      continue;
    }
    if (
      typeof parsed.ts !== 'string' ||
      typeof parsed.key !== 'string' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.schema !== 'string' ||
      typeof parsed.text !== 'string' ||
      typeof parsed.kind !== 'string' ||
      !(IMPORTED_ADVICE_KINDS as readonly string[]).includes(parsed.kind) ||
      !isStringArray(parsed.nodes) ||
      !isPlainObject(parsed.evidence) ||
      !(parsed.at === null || typeof parsed.at === 'string')
    ) {
      skipped++;
      continue;
    }
    const record: ImportedAdvice = {
      v: 1,
      ts: parsed.ts,
      key: parsed.key,
      source: parsed.source,
      schema: parsed.schema,
      at: parsed.at as string | null,
      kind: parsed.kind as ImportedAdviceKind,
      nodes: parsed.nodes,
      evidence: parsed.evidence,
      text: parsed.text,
    };
    if (isStringArray(parsed.candidates)) record.candidates = parsed.candidates;
    if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
      record.confidence = parsed.confidence;
    }
    imported.push(record);
  }
  return { imported, skipped };
}
