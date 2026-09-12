/**
 * The machine-readable form of the rule inventory (`yg aspects --json`).
 *
 * The text listing is written to be read. A layer above the agent asking "which
 * rules exist, what do they enforce, and is any of them running unreviewed"
 * needs those facts without parsing sentences.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-aspects/1`, and only a change to an EXISTING field's shape takes a new
 * schema number.
 */

import type { AspectStatus } from '../model/graph.js';

export const ASPECTS_JSON_SCHEMA = 'yg-aspects/1';

/** How many places a rule reaches, split by the channel it arrived through. */
export interface AspectsJsonUsage {
  /** Components where the rule is effective, however it got there. */
  nodes: number;
  /** Attached by an architecture type's defaults. */
  architecture: number;
  /** Declared on the component itself. */
  own: number;
  /** Pulled in by another rule's `implies`. */
  implied: number;
  /** Propagated from a flow the component participates in. */
  flow: number;
  /** Files governed by an architecture type alone, with no component of their own. */
  typeCovered: number;
}

/**
 * How one subject came to be governed by a rule.
 *
 * The channel names are the cascade's own: `own` (declared on the component
 * itself), `hierarchy` (declared on an ancestor component), `architecture` (an
 * architecture type's defaults, the component's own or an ancestor's), `flow` (a
 * flow the component takes part in), `port` (a port the component consumes),
 * `implied` (pulled in by another rule's `implies`), and `type` (a file governed
 * by an architecture type alone, with no component of its own).
 *
 * When several channels deliver the same rule to the same subject, the one named
 * here is the FIRST in cascade order — the same "first match wins" provenance the
 * text views (`yg context`, `yg impact`) already name for a rule on a component,
 * so the two never disagree about where a rule came from.
 */
export type AspectsJsonReachVia =
  | 'own'
  | 'hierarchy'
  | 'architecture'
  | 'flow'
  | 'port'
  | 'implied'
  | 'type';

/**
 * One subject a rule actually judges, with the standing it judges under there.
 *
 * `unit` is shaped exactly like `yg-check/1`'s own `pair.unit`, so a consumer
 * holding both documents joins them on the same `${kind}:${path}` key rather than
 * inventing a second identity for the same subject.
 */
export interface AspectsJsonReachUnit {
  /** The subject: one component, or one file governed by its architecture type. */
  unit: { kind: 'node' | 'file'; path: string };
  /** The owning component, or null for a file no component owns. */
  node: string | null;
  /**
   * Effective status on THIS subject — the standing that decides whether a
   * finding blocks here, which an attach site may raise above the rule's own
   * default. A `draft` unit is listed like any other: a rule that reaches
   * nothing and a rule that reaches ten subjects it is not yet judging are
   * different facts, and an empty list must only ever mean the first.
   */
  status: AspectStatus;
  /** Which channel delivered the rule here. */
  via: AspectsJsonReachVia;
  /**
   * Where it came from, when the channel has an origin to name: the ancestor
   * component (`hierarchy`), the architecture type (`architecture`, `type`), the
   * flow (`flow`), the port and the component publishing it (`port`), the rule
   * that implies this one (`implied`). Null for `own`, whose origin is the
   * subject itself.
   */
  from: string | null;
}

/**
 * The rule's reach, enumerated — present only under `--reach`.
 *
 * `usage` above COUNTS the places a rule reaches; this NAMES them. It is the
 * same question at a different resolution, which is why it lives in the same
 * document rather than a new one: a consumer that wants the count still reads
 * `usage` and pays nothing for it.
 *
 * The two are NOT the same tally, and neither is a check on the other. `usage`
 * counts COMPONENTS a rule is effective on; `units` lists the review pairs it
 * actually produces — one per subject file for a file-scoped rule, and none at
 * all on a component whose subject set for that rule is empty (nothing to
 * review is a vacuous pass, which the gate expects no verdict for). The channel
 * split is finer here than the one `usage` buckets by, too: an ancestor's
 * declaration and a port contract are their own words here, where `usage` folds
 * both into its `implied` count.
 *
 * A bundle (`kind: 'aggregate'`) always reports `units: []` — it has no reviewer
 * and no verdict of its own, so it judges nothing directly; what it pulls in is
 * `implies`, and each implied rule carries the reach of its own.
 */
export interface AspectsJsonReach {
  units: AspectsJsonReachUnit[];
}

/** The rule's own drill corpus — the cases it is replayed against. */
export interface AspectsJsonDrills {
  /** Cases the rule MUST refuse. */
  violates: number;
  /** Cases the rule MUST pass. */
  satisfies: number;
  total: number;
}

export interface AspectsJsonAspect {
  id: string;
  name: string;
  description: string;
  /** Reviewer kind: a judged rule, a local check, or a bundle with no reviewer of its own. */
  kind: 'llm' | 'deterministic' | 'aggregate';
  /** The reviewer tier a judged rule resolves to, when it names one. */
  tier: string | null;
  /** The rule's own default status; an attach site may raise it per component. */
  status: AspectStatus;
  /**
   * The standing request to re-examine whether the rule still earns its place,
   * as a bare `YYYY-MM-DD` date. Null when the rule names none.
   */
  reviewBy: string | null;
  /** The rule's honest error direction, on a local check that declares one. */
  errs: 'over' | 'under' | 'exact' | null;
  /** Rules this one pulls in. */
  implies: string[];
  usage: AspectsJsonUsage;
  /**
   * Every subject the rule reaches, named rather than counted — present ONLY
   * when the caller asked for it with `--reach`. Absent by default, so the
   * document a caller already reads stays byte-identical to what it was before
   * this field existed, and nobody pays the enumeration who did not ask for it.
   */
  reach?: AspectsJsonReach;
  drills: AspectsJsonDrills;
  /**
   * The last thing the rule's own history recorded — so a reader of this
   * document does not have to open files to know whether a rule has been
   * touched, when, and whether its standing moved.
   */
  log: AspectsJsonLog;
}

/**
 * A rule's history in one line: when it was last written to, and what the last
 * entry said about where the rule stands.
 *
 * `at` is null for a rule nothing has been recorded about yet — the normal state
 * of a rule nobody has had anything to say about, not an error. `statusChange`
 * is null when the last entry said something other than "this rule moved", which
 * is what makes its presence meaningful.
 */
export interface AspectsJsonLog {
  /** ISO 8601 UTC timestamp of the newest entry, or null when there is none. */
  at: string | null;
  /** The standing the newest entry recorded, when it recorded one. */
  statusChange: { from: string; to: string } | null;
}

export interface AspectsJsonDocument {
  schema: typeof ASPECTS_JSON_SCHEMA;
  aspects: AspectsJsonAspect[];
}

/** Render one rule inventory as pretty-printed JSON with a trailing newline. */
export function formatAspectsJson(doc: AspectsJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
