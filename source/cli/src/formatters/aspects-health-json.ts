/**
 * The machine-readable form of the rule health view (`yg aspects --health --json`).
 *
 * `yg aspects --json` (`yg-aspects/1`) is the rule INVENTORY: what rules exist,
 * their status and where they reach. The health view is a different projection
 * — per rule, how often it caught something, how often it was judged, what that
 * record reads as, and how many of its blocks a human later waived — and it
 * costs a verification pass to compute. It is its own document so the one name
 * never means two things: `yg-aspects/1` keeps its meaning unchanged.
 *
 * A layer above the agent — Horde's wave-close audit, which files a review for a
 * rule that has gone quiet — needs the signal and the plain-words reading per
 * rule without reading a table whose layout is the CLI's to change.
 *
 * `schema` is the only field a consumer must branch on; new fields may be added
 * freely within `yg-aspects-health/1`, and only a change to an EXISTING field's
 * shape takes a new schema number.
 *
 * The text table's honesty rules hold as values here: a count the question was
 * never asked of is `null`, never `0` (a rule with no recorded exposure has no
 * catch count; a pair with no verdict is counted as unverified, never as clean).
 */

export const ASPECTS_HEALTH_JSON_SCHEMA = 'yg-aspects-health/1';

export interface AspectsHealthJsonRule {
  aspect: string;
  /** Reviewer kind: `llm` | `deterministic` | `aggregate`. */
  kind: string;
  status: string;
  /** Distinct components with a pair for this rule. */
  nodes: number;
  /** Distinct type-covered files with a pair; `null` while `coverage.type_level` is off. */
  files: number | null;
  pairs: number;
  /** Pairs whose recorded refusal still holds for the current inputs. */
  refused: number;
  /** Pairs with no valid verdict on record — never counted as clean. */
  unverified: number;
  /** Live suppress markers naming this rule (wildcards are counted once, in `wildcardMarkers`). */
  suppresses: number;
  /** Declared error direction (`over` | `under` | `exact`), or `null`. */
  errs: string | null;
  /** Coarse age of the rule source (`3mo`, `1y`, `unknown`), or `null` for a rule with no source. */
  age: string | null;
  /** Violations the rule caught (refused fills); `null` when it has no recorded exposure. */
  catch: number | null;
  /** Times the reviewer judged it (approved + refused fills); `null` when never. */
  exposure: number | null;
  /** The coarse reading of catch against exposure: `active` | `quiet` | `decorative?`, or `null` with no exposure. */
  signal: string | null;
  /** The plain-words sentence the text view prints under the table for this rule, or `null` when it prints none. */
  reading: string | null;
  /** Blocks a human later waived or overturned, out of the blocks on record; `null` when the rule has blocked nothing. */
  falseBlocks: { count: number; blocks: number; thinData: boolean; reading: string | null } | null;
  /** Committed `wrong-rule` incidents naming this rule. */
  wrongRuleIncidents: number;
}

export interface AspectsHealthJsonDocument {
  schema: typeof ASPECTS_HEALTH_JSON_SCHEMA;
  rules: AspectsHealthJsonRule[];
  /** Suppress markers that apply to every rule, never attributed to one. */
  wildcardMarkers: number;
  /** The telemetry window the catch / exposure / false-block counts come from, in plain words, or `null`. */
  telemetry: string | null;
}

/** The document as printed: pretty JSON with a trailing newline. */
export function formatAspectsHealthJson(doc: AspectsHealthJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
