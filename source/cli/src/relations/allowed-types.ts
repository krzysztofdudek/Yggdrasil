/**
 * Compatibility re-export. allowedRelationTypes/RELATION_TYPES moved to
 * core/allowed-relation-types.ts (a pure engine function with no relations-
 * pass-specific dependencies) so both the relation-conformance pass and the
 * live type-relation gate (relations/type-gate.ts) can share one
 * implementation without the gate needing a relations-adapter-to-
 * relations-adapter edge for something that is really engine-layer logic.
 */
export { allowedRelationTypes, RELATION_TYPES } from '../core/allowed-relation-types.js';
