/**
 * source/cli/src/roots/config.ts — the roots engine's own half of the config
 * seam. Parsing the `roots:` block lives in `io/config-parser.ts` INLINE
 * beside `signals:`/`events:`, not here: the established parse-error contract
 * is `ConfigParseError` (a parser-adapter export), and engine-layer code may
 * call neither that constructor's home module in the parser-adapter sense nor
 * `buildIssueMessage` — delegating parsing to this file would force one of
 * those two illegal edges. This file therefore holds only what is legitimately
 * engine-side: folding an already-parsed `RootsConfig` into a stable content
 * hash (spec §4.5's `configHash`, the roots model header field of the same
 * name).
 */

import type { RootsConfig } from './model.js';
import { hashString } from '../io/hash.js';

/**
 * Serialize any JSON-representable value to a canonical JSON string: object
 * keys sorted in code-point order at every level, `undefined` values dropped.
 * A self-contained copy, not a shared import: `io/type-class-cache.ts` keeps
 * its own private copy of the same handful of lines for the identical reason
 * this file does — its architecture type's `calls` allow-list has no edge to
 * wherever a shared canonical-JSON helper would legally live for THIS type
 * (roots-engine may call persistence-adapter and utility, but the one
 * existing canonical-JSON serializer in this repository lives on the `engine`
 * type, which is off that list) — so the two copies are kept in sync only by
 * intent, the same honest cost that file's own header comment names.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * sha256 of the canonical-JSON of a parsed `RootsConfig` — pure and
 * deterministic (same config object, same hash, every time; key order and
 * `undefined` entries never affect the result). This is spec §4.5's
 * `configHash`, one of the roots model header's I2a determinism inputs: two
 * builds with the same `configHash` were configured identically, whatever
 * order the adopter happened to write the `roots:` block's keys in.
 */
export function rootsConfigHash(config: RootsConfig): string {
  return hashString(canonicalJson(config));
}
