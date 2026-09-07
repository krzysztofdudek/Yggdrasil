/**
 * The machine-readable form of one component's structure (`yg node <path> --json`).
 *
 * This document answers "what IS this component" — its identity, the files it
 * owns, the components it declares a dependency on, the contracts it publishes,
 * and where it sits in the hierarchy. It deliberately carries NO rules: what
 * must be satisfied on a subject is the context package's answer
 * (`yg context --json`), and duplicating it here would give a consumer two
 * places to learn the same fact and one of them to get wrong.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within `yg-node/1`,
 * and only a change to an EXISTING field's shape takes a new schema number.
 * Component paths are model-relative POSIX; mapping entries are repo-relative
 * POSIX, exactly as the text view prints them.
 */

export const NODE_JSON_SCHEMA = 'yg-node/1';

/** One declared outgoing dependency. */
export interface NodeJsonRelation {
  target: string;
  type: string;
  /** Ports consumed from the target — an empty list when the relation names none. */
  consumes: string[];
  /** Event label, for the event relation types only. */
  event_name?: string;
}

/**
 * One published port. `version` and `test` are `null` when the port declares
 * neither — the contract is then a description with nothing behind it.
 */
export interface NodeJsonPort {
  description: string;
  version: number | null;
  test: string | null;
  /** Rule ids a consumer of this port must satisfy. */
  aspects: string[];
}

export interface NodeJsonDocument {
  schema: typeof NODE_JSON_SCHEMA;
  path: string;
  name: string;
  type: string;
  description: string;
  mapping: string[];
  relations: NodeJsonRelation[];
  ports: Record<string, NodeJsonPort>;
  /** Direct children, model-relative POSIX, sorted. */
  children: string[];
  /** Parent component, or null at the top of the hierarchy. */
  parent: string | null;
}

/** Render one component document as pretty-printed JSON with a trailing newline. */
export function formatNodeJson(doc: NodeJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
