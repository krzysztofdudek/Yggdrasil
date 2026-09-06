/**
 * The machine-readable form of the attention feed (`yg advise --json`).
 *
 * The feed is written for a person and for an agent that reads prose. A layer
 * above the agent — an architect's queue, a wave close, a tool that handed
 * proposals in and wants to see what became of them — needs the same items
 * without parsing sentences, and above all needs each item's PROVENANCE: what
 * this graph found itself, and what another tool proposed.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-advise/1`, and only a change to an EXISTING field's shape takes a new
 * schema number.
 */

export const ADVISE_JSON_SCHEMA = 'yg-advise/1';

/**
 * Where an item came from, when it did not come from this graph's own signals.
 * Absent on every item the graph derived itself — which is what makes its
 * presence meaningful rather than decorative.
 */
export interface AdviseJsonProvenance {
  /** The tool that measured it. */
  source: string;
  /** The commit it was measured at, or null when the producer named none. */
  at: string | null;
}

/** One attention item, exactly as the feed ranks it. */
export interface AdviseJsonItem {
  /** Stable id — what a dismiss or defer names. */
  id: string;
  what: string;
  why: string;
  next: string;
  /**
   * Binds the item to the evidence it rests on. A decision taken against this
   * hash stops applying the moment the evidence moves.
   */
  evidenceHash: string;
  /** Present only on an item another tool proposed. */
  provenance?: AdviseJsonProvenance;
  /** Why the item is currently hidden, when it is. */
  suppressed?: { action: 'dismiss' | 'defer' | 'done'; until?: string; reason: string };
}

export interface AdviseJsonDocument {
  schema: typeof ADVISE_JSON_SCHEMA;
  /** One line per signal class — the same aggregates the text view heads with. */
  attention: string[];
  /** The ranked, currently-visible items. Never capped here: the cap is a rendering choice. */
  items: AdviseJsonItem[];
  /** Items a recorded decision currently hides, with the decision that hides them. */
  suppressed: AdviseJsonItem[];
}

/** Render one advise document as pretty-printed JSON with a trailing newline. */
export function formatAdviseJson(doc: AdviseJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
