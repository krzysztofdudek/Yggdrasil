import type { RelationType } from './graph.js';

/**
 * Applicability filter. Evaluated by the CLI against the graph before an aspect
 * is considered effective on a node. If the predicate evaluates to false, the
 * aspect is silently skipped on that node regardless of which channel attached it.
 *
 * Combines via AND with attach-site `when` declarations.
 *
 * Top-level atomic clauses are treated as implicit `all_of`.
 */
export type WhenPredicate = BooleanClause | AtomicClause;

export type BooleanClause =
  | { all_of: WhenPredicate[] }
  | { any_of: WhenPredicate[] }
  | { not: WhenPredicate };

/**
 * An atomic clause. All fields are optional — absent fields do not constrain.
 * An empty object `{}` is therefore vacuously true. Parsers reject the empty
 * form at the attach site (at least one operator/atomic key must be present).
 */
export interface AtomicClause {
  relations?: RelationClause;
  descendants?: DescendantsClause;
  node?: NodeClause;
}

export type RelationClause = Partial<Record<RelationType, RelationMatch>>;

export interface RelationMatch {
  target_type?: string;
  /** Node path relative to model/ */
  target?: string;
  consumes_port?: string;
}

export interface DescendantsClause {
  relations?: RelationClause;
  type?: string;
  has_port?: string;
}

export interface NodeClause {
  type?: string;
  has_port?: string;
  has_mapping?: boolean;
  /** Exact node path(s) relative to model/. A list matches any of its entries. */
  id?: string | string[];
}
