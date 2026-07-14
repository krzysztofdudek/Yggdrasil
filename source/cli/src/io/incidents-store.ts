/**
 * source/cli/src/io/incidents-store.ts — the append-only, COMMITTED incident
 * ledger: the sanctioned writer (and tolerant reader) of `.yggdrasil/incidents.md`.
 *
 * The ledger is the tower's only EXTERNAL oracle. Every other signal (advise,
 * catch/exposure health, structural attention) is the graph reasoning about
 * itself; an incident is a human recording what actually ESCAPED enforcement and
 * how it surfaced, tagged by cause. Because it is testimony rather than derived
 * state it is COMMITTED (never gitignored) — it must survive across machines and
 * be reviewed in a diff — yet it is NOT reviewed source: it carries no aspect and
 * no reviewer ever reads it as code.
 *
 * Each entry is one markdown block: `## [<ISO UTC>] <tag>` followed by the human's
 * prose. Entries are append-only and their datetimes are STRICTLY ASCENDING. There
 * is NO hash baseline in v1: a hand-edited or reordering-merged ledger must never
 * block CI, so the only integrity signal is a non-blocking `yg check` WARNING on
 * out-of-order datetimes (see core/checks/incident-ledger).
 *
 * `appendIncident` writes through the shared O_APPEND single-write chokepoint
 * (io/debug-log-writer), exactly as the committed advise-decisions register does.
 * `readIncidents` / `countIncidents` are tolerant and fail-open: a missing file is
 * a valid empty ledger, and a line that is not a well-formed header is simply not
 * an entry — never thrown, never a crash of the feed or the validator.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { appendToDebugLog } from './debug-log-writer.js';

/** The incident ledger's filename, relative to the `.yggdrasil/` graph root.
 *  COMMITTED human testimony — never gitignored. */
export const INCIDENTS_FILENAME = 'incidents.md';

/**
 * The closed vocabulary of incident CAUSES. Each names a distinct way enforcement
 * failed to hold, so a maintainer can later see the shape of what the tower misses:
 *   - no-rule           — a concern shipped with no rule covering it at all.
 *   - wrong-rule        — a rule existed but was miscalibrated (fired wrong, or missed).
 *   - judges-blind      — the reviewer(s) could not see what mattered (blind spot).
 *   - single-judge-miss — a lone judge missed what a panel would have caught.
 *   - not-enforcement   — the escape was not an enforcement gap (process, human, external).
 */
export const INCIDENT_TAGS = [
  'no-rule',
  'wrong-rule',
  'judges-blind',
  'single-judge-miss',
  'not-enforcement',
] as const;

export type IncidentTag = (typeof INCIDENT_TAGS)[number];

/** The tag whose incidents are miscalibration evidence for the catch/exposure health story. */
export const WRONG_RULE_TAG: IncidentTag = 'wrong-rule';

/** True iff `tag` is one of the sanctioned incident causes. */
export function isValidIncidentTag(tag: string): tag is IncidentTag {
  return (INCIDENT_TAGS as readonly string[]).includes(tag);
}

/** One parsed ledger entry: its ISO datetime header value and its cause tag. */
export interface IncidentEntry {
  /** The bracketed ISO-8601 UTC datetime from the `## [<ISO>] <tag>` header. */
  datetime: string;
  /** The cause tag from the header (may be any token on a hand-edited line). */
  tag: string;
}

/** Result of reading the committed ledger. */
export interface ReadIncidentsResult {
  /** Parsed entries, in file (append) order. */
  entries: IncidentEntry[];
  /** True when the file exists on disk (absent → a valid empty ledger). */
  present: boolean;
}

/**
 * A ledger entry HEADER: `## [<ISO UTC>] <tag>`. The bracketed value must be an
 * ISO-8601 UTC datetime (the exact shape `Date#toISOString` emits) so a line in a
 * human's prose that merely starts with `##` can never be mis-read as an entry —
 * only a real, machine-shaped header counts. The tag is whatever non-space token
 * follows; the reader does not gate on the closed vocabulary (a hand-edited tag is
 * still an entry), the CLI validates the vocabulary at write time.
 */
const HEADER_RE = /^##\s+\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\]\s+(\S+)\s*$/;

/** One-time preamble written when the ledger is first created — never a header. */
const LEDGER_PREAMBLE =
  `# Incident ledger\n\n` +
  `Committed human testimony — what escaped enforcement and how it surfaced, tagged by\n` +
  `cause. Append-only; one entry per incident, datetimes strictly ascending. Recorded\n` +
  `only with a maintainer's explicit tag and reason; never fabricate an entry.\n\n`;

/** Render one ledger entry block: the machine-shaped header plus the human's prose. */
export function formatIncidentEntry(isoDatetime: string, tag: string, reason: string): string {
  return `## [${isoDatetime}] ${tag}\n\n${reason.trim()}\n\n`;
}

/**
 * Parse a ledger's text into entries, in file order. PURE — string in, entries
 * out. Only lines matching the machine-shaped header are entries; everything else
 * (the preamble, the prose body, blank lines) is ignored. A garbled ledger yields
 * whatever well-formed headers it still has, never a throw.
 */
export function parseIncidents(text: string): IncidentEntry[] {
  const entries: IncidentEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = HEADER_RE.exec(line);
    if (m === null) continue;
    entries.push({ datetime: m[1], tag: m[2] });
  }
  return entries;
}

/**
 * Read the committed ledger under `yggRootPath` (the `.yggdrasil/` graph root).
 * Tolerant and fail-open: a missing file is a valid empty ledger, and any read
 * error degrades to the same empty state rather than throwing.
 */
export function readIncidents(yggRootPath: string): ReadIncidentsResult {
  const filePath = path.join(yggRootPath, INCIDENTS_FILENAME);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    // Missing (or unreadable) ledger is a valid empty state — a repo that has never
    // recorded an incident has no file yet, and that absence is honest, not an error.
    return { entries: [], present: false };
  }
  return { entries: parseIncidents(content), present: true };
}

/**
 * Aggregate counts for the advise reality-counter: the total number of recorded
 * incidents and how many are tagged `wrong-rule`. An absent ledger reads honestly
 * as `{ total: 0, wrongRule: 0 }`.
 */
export function countIncidents(yggRootPath: string): { total: number; wrongRule: number } {
  const { entries } = readIncidents(yggRootPath);
  let wrongRule = 0;
  for (const e of entries) if (e.tag === WRONG_RULE_TAG) wrongRule += 1;
  return { total: entries.length, wrongRule };
}

/**
 * Append one incident to the committed ledger under `yggRootPath`. The ONLY writer
 * of this file: one incident = one complete markdown block written through the
 * shared O_APPEND single-write chokepoint (never a full-file rewrite). The clock is
 * INJECTED (`isoDatetime` is computed at the CLI boundary), so this store keeps no
 * `Date.now` of its own. When the ledger does not yet exist the one-time preamble is
 * written ahead of the first entry; the ledger is COMMITTED, so — unlike the
 * gitignored telemetry sidecars — it never self-ensures a gitignore line.
 */
export function appendIncident(
  yggRootPath: string,
  entry: { tag: string; reason: string; isoDatetime: string },
): void {
  const filePath = path.join(yggRootPath, INCIDENTS_FILENAME);
  let existing: string;
  try {
    existing = readFileSync(filePath, 'utf-8');
  } catch {
    // Absent ledger → first write; the preamble is prepended below.
    existing = '';
  }
  const block = formatIncidentEntry(entry.isoDatetime, entry.tag, entry.reason);
  const text = existing.trim() === '' ? LEDGER_PREAMBLE + block : block;
  appendToDebugLog(filePath, text);
}
