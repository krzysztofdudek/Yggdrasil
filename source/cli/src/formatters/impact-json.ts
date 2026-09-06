/**
 * The machine-readable form of a blast-radius answer (`yg impact --node|--file --json`).
 *
 * The text view of `yg impact` is written for a person and for an agent that
 * reads prose. A layer sitting ABOVE the agent — an orchestrator ordering work
 * across components, a planner deciding what a change may touch — needs the same
 * facts without parsing sentences: which contracts the component publishes, who
 * consumes each of them, who depends on the component directly, and who is
 * carried along behind those dependents.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-impact/1`, and only a change to an EXISTING field's shape takes a new
 * schema number. Every path is repo-relative POSIX and every component path is
 * model-relative POSIX, exactly as the text view prints them.
 */

export const IMPACT_JSON_SCHEMA = 'yg-impact/1';

/** One component that consumes a port, and the relation it consumes it through. */
export interface ImpactJsonPortConsumer {
  /** Model-relative path of the consuming component. */
  node: string;
  /** Relation type the consumption is declared on — `uses`, `calls`, `emits`, … */
  relation: string;
}

/**
 * One port the subject publishes. `version` and `test` are `null` when the port
 * declares neither — the contract is then a description with nothing behind it.
 */
export interface ImpactJsonPort {
  name: string;
  version: number | null;
  test: string | null;
  consumers: ImpactJsonPortConsumer[];
}

/** One declared relation from a dependent to the subject, with the ports it names. */
export interface ImpactJsonDependentRelation {
  type: string;
  /** Ports this relation consumes — an empty list when it names none. */
  ports: string[];
}

/**
 * One component that depends on the subject. `direct` distinguishes a declared
 * edge onto the subject from one reached through other components; an indirect
 * dependent declares no relation to the subject and so carries an empty
 * `relations` list.
 */
export interface ImpactJsonDependent {
  node: string;
  direct: boolean;
  relations: ImpactJsonDependentRelation[];
}

/** One indirect dependent and the components the dependency travels through. */
export interface ImpactJsonTransitive {
  node: string;
  /** Intermediate components, subject-first — never includes the subject or `node` itself. */
  via: string[];
}

export interface ImpactJsonDocument {
  schema: typeof IMPACT_JSON_SCHEMA;
  subject: { kind: 'node'; path: string };
  ports: ImpactJsonPort[];
  dependents: ImpactJsonDependent[];
  transitive: ImpactJsonTransitive[];
}

/** Render one impact document as pretty-printed JSON with a trailing newline. */
export function formatImpactJson(doc: ImpactJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
