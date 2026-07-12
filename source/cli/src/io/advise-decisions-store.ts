/**
 * source/cli/src/io/advise-decisions-store.ts — the append-only, COMMITTED
 * register of advise decisions: the sanctioned writer (and tolerant reader) of
 * `.yggdrasil/advise-decisions.jsonl`.
 *
 * Unlike the verdict-events / drill-results sidecars (local, gitignored, write-
 * only telemetry), this ledger is COMMITTED case law: a dismiss / defer / done
 * decision is precedent that must survive across machines and merge cleanly
 * across branches (`merge=union` via `.gitattributes`). Every line binds a
 * decision to the exact evidence its attention item carried at ack time
 * (`evidenceHash`), so the decision stops applying the moment that evidence
 * changes. `reason` is MANDATORY on every line — precedent needs prose.
 *
 * `appendDecision` is the ONE writer of this file (it appends JSONL — never
 * YAML — through the shared O_APPEND single-write chokepoint). Unlike the
 * best-effort telemetry sidecars, a failed decision write is NOT swallowed: the
 * caller must learn that its dismiss / defer was not recorded. `readDecisions`
 * is tolerant / fail-open exactly like the verdict-events reader — an unknown
 * `v`, a non-JSON line, or a mis-shaped record is counted (`skipped`) and
 * dropped, never thrown, and a missing file is a valid empty register.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { appendToDebugLog } from './debug-log-writer.js';

/** The advise-decisions register's filename, relative to the `.yggdrasil/` graph
 *  root. COMMITTED (case law — never gitignored); merges by union across branches. */
export const ADVISE_DECISIONS_FILENAME = 'advise-decisions.jsonl';

/** The kinds of decision a line may record. `done` (law materialized — hidden
 *  permanently) is reserved: no v1 subcommand emits it, but the reader / feed
 *  must accept it now so a future or hand-appended closure is honored. */
export type AdviseAction = 'dismiss' | 'defer' | 'done';

/**
 * One line of the committed advise-decisions register. `v` is the line-schema
 * version — a reader treats an absent `v` as v1 (forward-tolerance, like the
 * telemetry sidecars).
 */
export interface AdviseDecision {
  /** Line-schema version. Readers treat an absent `v` as v1. */
  v: 1;
  /** ISO 8601 UTC timestamp — from the command's clock at ack time. */
  ts: string;
  /** The nomination id this decision acts on (`<classKey>:<key>`). */
  id: string;
  action: AdviseAction;
  /** Binds the decision to the exact evidence the nomination carried at ack time.
   *  When the current nomination's evidence no longer hashes to this, the stale
   *  decision stops matching and the item returns as new. */
  evidenceHash: string;
  /** `defer` only — the bare ISO date (`YYYY-MM-DD`) the item stays hidden until. */
  until?: string;
  /** Human-signed justification. MANDATORY — precedent needs prose. */
  reason: string;
}

const KNOWN_ACTIONS = new Set<AdviseAction>(['dismiss', 'defer', 'done']);

/** Result of reading the committed advise-decisions register. */
export interface ReadDecisionsResult {
  /** Parsed decisions, in file (append) order. */
  decisions: AdviseDecision[];
  /** Count of dropped lines: unknown `v`, non-JSON, or a mis-shaped record. */
  skipped: number;
}

/** Type guard: a parsed JSON value that is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Append one decision to the committed register under `yggRootPath` (the
 * `.yggdrasil/` graph root). The ONLY writer of this file: one decision = one
 * complete JSON line written through the shared O_APPEND single-write chokepoint.
 *
 * A failed write REJECTS (it is not swallowed) — a lost decision is a real
 * failure the caller must surface, not silent telemetry loss.
 */
export async function appendDecision(yggRootPath: string, decision: AdviseDecision): Promise<void> {
  appendToDebugLog(
    path.join(yggRootPath, ADVISE_DECISIONS_FILENAME),
    JSON.stringify(decision) + '\n',
  );
}

/**
 * Read the committed advise-decisions register under `yggRootPath`. Tolerant and
 * fail-open (see the module header): a missing file yields an empty register; an
 * unknown `v`, a non-JSON line, or a record missing a required field is counted
 * in `skipped` and dropped, never thrown.
 */
export function readDecisions(yggRootPath: string): ReadDecisionsResult {
  const filePath = path.join(yggRootPath, ADVISE_DECISIONS_FILENAME);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    // Missing register (or any read error) is a valid empty state — a repo that
    // has never recorded a decision has no file yet.
    return { decisions: [], skipped: 0 };
  }

  const decisions: AdviseDecision[] = [];
  let skipped = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    if (!isPlainObject(parsed)) {
      skipped += 1;
      continue;
    }

    // Absent `v` ≙ v1; any other version is an unknown future shape.
    const v = parsed.v;
    if (v !== undefined && v !== 1) {
      skipped += 1;
      continue;
    }

    // Required fields must be present and well-typed, or the record is mis-shaped
    // and dropped (fail-open — a garbled line never crashes the feed).
    const { ts, id, action, evidenceHash, reason, until } = parsed;
    if (
      typeof ts !== 'string' ||
      typeof id !== 'string' ||
      typeof action !== 'string' ||
      !KNOWN_ACTIONS.has(action as AdviseAction) ||
      typeof evidenceHash !== 'string' ||
      typeof reason !== 'string' ||
      (until !== undefined && typeof until !== 'string')
    ) {
      skipped += 1;
      continue;
    }

    decisions.push({
      v: 1,
      ts,
      id,
      action: action as AdviseAction,
      evidenceHash,
      reason,
      ...(until !== undefined ? { until } : {}),
    });
  }

  return { decisions, skipped };
}
