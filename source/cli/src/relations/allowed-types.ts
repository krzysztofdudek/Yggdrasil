/**
 * Compatibility re-export. allowedRelationTypes lives in
 * utils/allowed-relation-types.ts and RELATION_TYPES in model/when.ts, so the
 * relation-conformance pass, the live type-relation gate
 * (relations/type-gate.ts) and the architecture read reach (structure/) share
 * one implementation without depending on the engine layer. Existing callers
 * keep importing both from here.
 */
export { allowedRelationTypes } from '../utils/allowed-relation-types.js';
export { RELATION_TYPES } from '../model/when.js';
