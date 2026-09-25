/**
 * The result of classifying one file against the architecture's node types: the
 * types whose `when` predicate matched, the closest near-misses, and the types that
 * could not be evaluated. Pure types, in the model layer so the classification cache
 * (a persistence adapter) can store them without depending on the classifier engine.
 * `core/type-classifier.ts` re-exports these names.
 */
import type { PredicateTrace } from './file-when.js';

export type TypeMatch = {
  typeId: string;
  trace: PredicateTrace;
};

export type ClosestType = {
  typeId: string;
  trace: PredicateTrace;
  score: number;
};

export type UnreadableType = {
  typeId: string;
  reason: string;
  /** Why the file could not be evaluated: a genuine read failure, or over the content-scan size limit. */
  kind: 'read' | 'too-large';
};

export type ClassificationResult = {
  matches: TypeMatch[];
  closest: ClosestType[];
  unreadable: UnreadableType[];
};
