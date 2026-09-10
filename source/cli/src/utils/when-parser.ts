import type {
  WhenPredicate,
  BooleanClause,
  AtomicClause,
  RelationClause,
  RelationMatch,
  DescendantsClause,
  NodeClause,
} from '../model/when.js';
import type { RelationType, AspectStatus, StatusInherit } from '../model/graph.js';
import { ASPECT_STATUS_VALUES, STATUS_INHERIT_VALUES } from '../model/graph.js';
import { BOOLEAN_KEYS, parsePredicateBoolean } from './predicate-boolean.js';

const RELATION_TYPES = new Set<string>([
  'calls',
  'uses',
  'extends',
  'implements',
  'emits',
  'listens',
]);

const ATOMIC_KEYS = new Set<string>(['relations', 'descendants', 'node']);

/**
 * Parse a raw YAML value into a WhenPredicate. `ctx` is a human-readable
 * description of where this predicate came from, used in error messages
 * (e.g. "aspect 'error-handling/external-api-error-mapping' global when").
 */
export function parseWhen(raw: unknown, ctx: string): WhenPredicate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: when must be a YAML mapping`);
  }

  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0) {
    throw new Error(`${ctx}: when mapping must not be empty`);
  }

  const booleanKeys = keys.filter(k => BOOLEAN_KEYS.has(k));
  const atomicKeys = keys.filter(k => ATOMIC_KEYS.has(k));
  const unknownKeys = keys.filter(k => !BOOLEAN_KEYS.has(k) && !ATOMIC_KEYS.has(k));

  if (unknownKeys.length > 0) {
    const badKey = unknownKeys[0];
    // Cross-hint: file-family atoms (path, content) are valid in scope.files
    // but not in aspect when:, which filters NODES not FILES. The message
    // intentionally includes "unknown when operator '<key>'" so that existing
    // callers pattern-matching on that prefix continue to work.
    if (badKey === 'path' || badKey === 'content') {
      throw new Error(
        `${ctx}: unknown when operator '${badKey}' — \`${badKey}\` is a file atom — not valid in when:; when: filters which NODES the aspect applies to. To filter which FILES are reviewed, use scope.files:`,
      );
    }
    throw new Error(`${ctx}: unknown when operator '${badKey}' (expected one of: all_of, any_of, not, relations, descendants, node)`);
  }

  if (booleanKeys.length > 0 && atomicKeys.length > 0) {
    throw new Error(`${ctx}: when cannot mix boolean operators with atomic clauses at the same level`);
  }
  if (booleanKeys.length > 1) {
    throw new Error(`${ctx}: when can have at most one boolean operator at a level (got: ${booleanKeys.join(', ')})`);
  }

  if (booleanKeys.length === 1) {
    return parseBoolean(raw as Record<string, unknown>, booleanKeys[0], ctx);
  }

  // Implicit all_of over atomic clauses at this level
  return parseAtomic(raw as Record<string, unknown>, ctx);
}

function parseBoolean(raw: Record<string, unknown>, key: string, ctx: string): BooleanClause {
  return parsePredicateBoolean<WhenPredicate>(raw, key, ctx, parseWhen) as BooleanClause;
}

function parseAtomic(raw: Record<string, unknown>, ctx: string): AtomicClause {
  const result: AtomicClause = {};
  if ('relations' in raw) {
    result.relations = parseRelationClause(raw.relations, `${ctx}/relations`);
  }
  if ('descendants' in raw) {
    result.descendants = parseDescendantsClause(raw.descendants, `${ctx}/descendants`);
  }
  if ('node' in raw) {
    result.node = parseNodeClause(raw.node, `${ctx}/node`);
  }
  return result;
}

function parseRelationClause(raw: unknown, ctx: string): RelationClause {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: relations must be a YAML mapping keyed by relation type`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${ctx}: relations mapping must not be empty`);
  }
  const out: RelationClause = {};
  for (const [relType, match] of entries) {
    if (!RELATION_TYPES.has(relType)) {
      throw new Error(`${ctx}: unknown relation type '${relType}' (valid: ${Array.from(RELATION_TYPES).join(', ')})`);
    }
    out[relType as RelationType] = parseRelationMatch(match, `${ctx}/${relType}`);
  }
  return out;
}

function parseRelationMatch(raw: unknown, ctx: string): RelationMatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: must be a YAML mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['target_type', 'target', 'consumes_port']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(`${ctx}: unknown field '${k}' (allowed: target_type, target, consumes_port)`);
    }
  }
  const out: RelationMatch = {};
  if ('target_type' in obj) {
    if (typeof obj.target_type !== 'string' || obj.target_type.trim() === '') {
      throw new Error(`${ctx}: target_type must be a non-empty string`);
    }
    out.target_type = obj.target_type.trim();
  }
  if ('target' in obj) {
    if (typeof obj.target !== 'string' || obj.target.trim() === '') {
      throw new Error(`${ctx}: target must be a non-empty string (node path relative to model/)`);
    }
    out.target = obj.target.trim();
  }
  if ('consumes_port' in obj) {
    if (typeof obj.consumes_port !== 'string' || obj.consumes_port.trim() === '') {
      throw new Error(`${ctx}: consumes_port must be a non-empty string`);
    }
    out.consumes_port = obj.consumes_port.trim();
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${ctx}: at least one of target_type, target, consumes_port must be present`);
  }
  return out;
}

function parseDescendantsClause(raw: unknown, ctx: string): DescendantsClause {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: descendants must be a YAML mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['relations', 'type', 'has_port']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(`${ctx}: unknown field '${k}' (allowed: relations, type, has_port)`);
    }
  }
  const out: DescendantsClause = {};
  if ('relations' in obj) {
    out.relations = parseRelationClause(obj.relations, `${ctx}/relations`);
  }
  if ('type' in obj) {
    if (typeof obj.type !== 'string' || obj.type.trim() === '') {
      throw new Error(`${ctx}: type must be a non-empty string`);
    }
    out.type = obj.type.trim();
  }
  if ('has_port' in obj) {
    if (typeof obj.has_port !== 'string' || obj.has_port.trim() === '') {
      throw new Error(`${ctx}: has_port must be a non-empty string`);
    }
    out.has_port = obj.has_port.trim();
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${ctx}: at least one of relations, type, has_port must be present`);
  }
  return out;
}

function parseNodeClause(raw: unknown, ctx: string): NodeClause {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: node must be a YAML mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['type', 'has_port', 'has_mapping', 'id']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(`${ctx}: unknown field '${k}' (allowed: type, has_port, has_mapping, id)`);
    }
  }
  const out: NodeClause = {};
  if ('type' in obj) {
    if (typeof obj.type !== 'string' || obj.type.trim() === '') {
      throw new Error(`${ctx}: type must be a non-empty string`);
    }
    out.type = obj.type.trim();
  }
  if ('has_port' in obj) {
    if (typeof obj.has_port !== 'string' || obj.has_port.trim() === '') {
      throw new Error(`${ctx}: has_port must be a non-empty string`);
    }
    out.has_port = obj.has_port.trim();
  }
  if ('has_mapping' in obj) {
    if (typeof obj.has_mapping !== 'boolean') {
      throw new Error(`${ctx}: has_mapping must be a boolean`);
    }
    out.has_mapping = obj.has_mapping;
  }
  if ('id' in obj) {
    out.id = parseNodeIdField(obj.id, ctx);
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${ctx}: at least one of type, has_port, has_mapping, id must be present`);
  }
  return out;
}

function parseNodeIdField(raw: unknown, ctx: string): string | string[] {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') {
      throw new Error(`${ctx}: id must be a non-empty string or a non-empty array of non-empty strings`);
    }
    return trimmed;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error(`${ctx}: id array must not be empty`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    raw.forEach((v, i) => {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`${ctx}: id[${i}] must be a non-empty string`);
      }
      const trimmed = v.trim();
      if (seen.has(trimmed)) {
        throw new Error(`${ctx}: id contains duplicate '${trimmed}'`);
      }
      seen.add(trimmed);
      out.push(trimmed);
    });
    return out;
  }
  throw new Error(`${ctx}: id must be a non-empty string or a non-empty array of non-empty strings`);
}

/**
 * Mode for `parseAspectAttachment`:
 * - `'attach-site'` — channels 1–6 (node/architecture/flow/port). Accepts
 *   optional `status:` overriding the aspect-default per the bump rule.
 * - `'implies-edge'` — channel 7 (aspect → aspect). Accepts optional
 *   `status_inherit:` modifier ('strictest' default, 'own-default' opt-out).
 */
export type AspectAttachmentMode = 'attach-site' | 'implies-edge';

/**
 * Parse an aspect attachment list entry. Accepts either:
 * - a bare string (the aspect id; no `when`)
 * - an object `{ id: string, when?: <predicate>, status?: <AspectStatus> }`
 *   in `'attach-site'` mode, or
 *   `{ id: string, when?: <predicate>, status_inherit?: <StatusInherit> }`
 *   in `'implies-edge'` mode.
 *
 * Returns the aspect id and, if present, the parsed predicate and mode-specific
 * status field.
 */
export function parseAspectAttachment(
  raw: unknown,
  ctx: string,
  mode: AspectAttachmentMode = 'attach-site',
): { id: string; when?: WhenPredicate; status?: AspectStatus; statusInherit?: StatusInherit } {
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (id === '') {
      throw new Error(`${ctx}: aspect id must be a non-empty string`);
    }
    return { id };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id.trim() === '') {
      throw new Error(`${ctx}: object form requires 'id' as a non-empty string`);
    }
    const result: { id: string; when?: WhenPredicate; status?: AspectStatus; statusInherit?: StatusInherit } = { id: obj.id.trim() };

    // Allowed keys depend on mode — channels 1–6 carry `status:`, channel 7 carries `status_inherit:`.
    const allowed = mode === 'implies-edge'
      ? new Set(['id', 'when', 'status_inherit'])
      : new Set(['id', 'when', 'status']);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        const list = mode === 'implies-edge' ? 'id, when, status_inherit' : 'id, when, status';
        throw new Error(`${ctx}: unknown field '${k}' in aspect attachment (allowed: ${list})`);
      }
    }
    if ('when' in obj) {
      result.when = parseWhen(obj.when, `${ctx}/when`);
    }
    if (mode === 'attach-site' && 'status' in obj) {
      if (typeof obj.status !== 'string' || !ASPECT_STATUS_VALUES.includes(obj.status as AspectStatus)) {
        throw new Error(`${ctx}: status must be one of: draft, advisory, enforced (got '${String(obj.status)}')`);
      }
      result.status = obj.status as AspectStatus;
    }
    if (mode === 'implies-edge' && 'status_inherit' in obj) {
      if (typeof obj.status_inherit !== 'string' || !STATUS_INHERIT_VALUES.includes(obj.status_inherit as StatusInherit)) {
        throw new Error(`${ctx}: status_inherit must be one of: strictest, own-default (got '${String(obj.status_inherit)}')`);
      }
      result.statusInherit = obj.status_inherit as StatusInherit;
    }
    return result;
  }
  throw new Error(`${ctx}: aspect attachment must be a string or an object with 'id' (and optional 'when')`);
}
