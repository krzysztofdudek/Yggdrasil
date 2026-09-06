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
  drills: AspectsJsonDrills;
}

export interface AspectsJsonDocument {
  schema: typeof ASPECTS_JSON_SCHEMA;
  aspects: AspectsJsonAspect[];
}

/** Render one rule inventory as pretty-printed JSON with a trailing newline. */
export function formatAspectsJson(doc: AspectsJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
