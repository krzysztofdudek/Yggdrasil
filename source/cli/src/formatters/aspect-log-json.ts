/**
 * The machine-readable form of a rule's own history (`yg aspects log read --json`).
 *
 * A component's log has always been prose for a person to read. A rule's is
 * that too, but it is also the answer to questions a tool asks — when did this
 * rule last move, what is it standing at now, on whose evidence — so it is
 * offered as one versioned document as well.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-aspect-log/1`, and only a change to an EXISTING field's shape takes a new
 * schema number.
 */

export const ASPECT_LOG_JSON_SCHEMA = 'yg-aspect-log/1';

/**
 * The standing this entry recorded, when it recorded one.
 *
 * Present only on an entry that opens with the fixed status line — which is
 * what makes its presence meaningful: an entry with no `status` said something
 * about the rule other than where it stands.
 */
export interface AspectLogJsonStatus {
  /** Where the rule stood before. */
  from: string;
  /** Where it stands after. */
  to: string;
}

/** One entry of a rule's history, newest first in the document. */
export interface AspectLogJsonEntry {
  /** ISO 8601 UTC timestamp — the entry header, verbatim. */
  at: string;
  /** Everything written under that header, verbatim. */
  body: string;
  /** Present only on an entry that recorded a change of standing. */
  status?: AspectLogJsonStatus;
}

export interface AspectLogJsonDocument {
  schema: typeof ASPECT_LOG_JSON_SCHEMA;
  /** The rule whose history this is. */
  aspect: string;
  /** What the rule stands at right now — read from the rule, not from the log. */
  status: string;
  /** Newest first. Capped only when the caller asked for a limit. */
  entries: AspectLogJsonEntry[];
}

/** Render one history document as pretty-printed JSON with a trailing newline. */
export function formatAspectLogJson(doc: AspectLogJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
