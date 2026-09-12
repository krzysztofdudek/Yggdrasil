/**
 * The machine-readable form of the waiver inventory (`yg suppressions --json`).
 *
 * The text listing is written to be read. A layer above the agent — Horde's
 * land-time guard, comparing the waiver set of a base tree against a branch to
 * refuse a branch that adds a `yg-suppress` the base tree never had — needs
 * those facts without parsing sentences.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-suppressions/1`, and only a change to an EXISTING field's shape takes a
 * new schema number.
 *
 * This module holds only the document's shape and its pure renderer — no
 * `SuppressionsReport` import here, by design: a `formatter`-type node may only
 * `uses` a plain data type and `calls` a utility, never reach into the portal
 * facade that owns the report. `buildSuppressionsJson`, which DOES need that
 * report, lives in `cli/suppressions.ts` instead (mirrors `buildAspectsJson` in
 * `cli/aspects.ts` — the same reason `yg-aspects/1`'s builder is not in here
 * either).
 */

export const SUPPRESSIONS_JSON_SCHEMA = 'yg-suppressions/1';

export interface SuppressionsJsonRange {
  from: number;
  to: number | null;
}

export interface SuppressionsJsonMarker {
  aspect: string;
  file: string;
  line: number;
  kind: 'single' | 'disable' | 'enable' | 'file-level';
  wildcard: boolean;
  reason: string | null;
  range: SuppressionsJsonRange | null;
}

export interface SuppressionsJsonWarning {
  code: 'unknown-aspect' | 'wildcard' | 'unbounded-range' | 'waives-under';
  file: string;
  line: number;
  aspect: string | null;
  message: string;
}

export interface SuppressionsJsonTotals {
  markers: number;
  files: number;
  fileLevel: number;
}

export interface SuppressionsJsonDocument {
  schema: typeof SUPPRESSIONS_JSON_SCHEMA;
  markers: SuppressionsJsonMarker[];
  warnings: SuppressionsJsonWarning[];
  totals: SuppressionsJsonTotals;
}

/** Render one suppressions document as pretty-printed JSON with a trailing newline. */
export function formatSuppressionsJson(doc: SuppressionsJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
