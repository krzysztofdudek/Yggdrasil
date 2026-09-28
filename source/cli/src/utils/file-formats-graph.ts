/**
 * source/cli/src/utils/file-formats-graph.ts — the schemas of the graph's own
 * files: yg-node.yaml, yg-architecture.yaml, yg-aspect.yaml, the
 * yg-aspect.adapt.yaml a consumer writes beside an installed rule, and
 * yg-flow.yaml.
 *
 * A block whose parser takes its accepted and retired keys from it is exported
 * on its own as well as inside its file's schema. See file-schema.ts for what a
 * schema drives.
 */

import { ASPECT_STATUS_VALUES, ERRS_DIRECTION_VALUES, STATUS_INHERIT_VALUES } from '../model/graph.js';
import type { Field, FieldType, FileFormatSchema, ObjectType } from './file-schema.js';

const RELATION_TYPE_VALUES = ['calls', 'uses', 'extends', 'implements', 'emits', 'listens'] as const;

const stringList = (nonEmpty = false): FieldType => ({ kind: 'list', of: { kind: 'string', nonEmpty } });

/** A rule attached at a site (a node, a port, a type, a flow): its id, or { id, when, status }. */
const ATTACHMENT_OBJECT: ObjectType = {
  kind: 'object',
  fields: {
    id: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The rule id — its directory path under aspects/.' },
    when: { type: { kind: 'predicate', grammar: 'node' }, description: 'Attach the rule here only where this node predicate holds (yg knowledge read conditional-aspects).' },
    status: { type: { kind: 'string', values: ASPECT_STATUS_VALUES }, description: 'Raise the rule\'s status at this site; lowering it is refused.' },
  },
};

const ATTACHMENTS: FieldType = { kind: 'list', of: { kind: 'oneOf', of: [{ kind: 'string', nonEmpty: true }, ATTACHMENT_OBJECT] } };

// ============================================================
// yg-node.yaml
// ============================================================

/** One entry of a node's `relations:`. */
export const NODE_RELATION: ObjectType = {
  kind: 'object',
  fields: {
    target: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The node depended on, as its path under model/.' },
    type: { type: { kind: 'string', values: RELATION_TYPE_VALUES }, required: true, description: 'calls, uses, extends and implements are structural and must form no cycle; emits and listens are events and must be paired.' },
    portNames: { type: stringList(), description: 'The target\'s ports this relation enters through; each port\'s rules then apply to this node. Absent means the implicit `default` port; an empty list is refused.' },
    consumes: { type: stringList(), description: 'Deprecated alias of portNames; declaring both is refused.' },
    event_name: { type: { kind: 'string' }, description: 'A label for the event channel of an emits or listens relation. Documentation only: pairing compares node paths.' },
  },
  retired: { failure: 'removed in 4.0.0' },
};

/** One entry of a node's `ports:`. */
export const NODE_PORT: ObjectType = {
  kind: 'object',
  fields: {
    description: { type: { kind: 'string', nonEmpty: true }, required: 'yes, except on a port named `default`', description: 'What the port provides.' },
    aspects: { type: ATTACHMENTS, description: 'Rules a node relating through this port must satisfy (channel 6).' },
  },
  retired: {
    version: "removed in 6.0.0: Yggdrasil no longer records contract versions",
    test: "removed in 6.0.0: Yggdrasil no longer runs contract tests",
  },
};

/** Why a malformed per-node ceiling is not refused: it can only fall back to the stricter global one. */
const OVERRIDE_TOLERATED = 'an override missing either field, or with a limit below 1, leaves the global ceiling in force';

/** A node's `max_direct_relations:` override. */
export const NODE_MAX_DIRECT_RELATIONS: ObjectType = {
  kind: 'object',
  fields: {
    limit: { type: { kind: 'integer', min: 1 }, required: true, description: 'This node\'s own relation ceiling, above or below the global quality.max_direct_relations.', tolerated: OVERRIDE_TOLERATED },
    reason: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'Why this node gets its own ceiling.', tolerated: OVERRIDE_TOLERATED },
  },
};

/** The top level of a yg-node.yaml. */
export const NODE_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    name: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'Display name.' },
    type: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'A node type yg-architecture.yaml defines.' },
    description: { type: { kind: 'string' }, required: 'yes (description-missing without it)', description: 'What the component does; shown in context output.' },
    aspects: { type: ATTACHMENTS, description: 'Rules attached to this node and every node under it (channel 1).' },
    relations: { type: { kind: 'list', of: NODE_RELATION }, description: 'This node\'s dependencies on other nodes. A code dependency on a mapped node that is not declared here is refused (relation-undeclared-dependency).' },
    mapping: { type: stringList(true), description: 'Files, directories and globs this node owns, relative to the repository root. An empty list is refused.' },
    ports: { type: { kind: 'map', key: 'port', of: NODE_PORT }, description: 'Named entry points, each with the rules a relation entering through it must satisfy.' },
    max_direct_relations: {
      type: NODE_MAX_DIRECT_RELATIONS,
      description: 'A reviewed override of the high-fan-out ceiling for this node only.',
      tolerated: OVERRIDE_TOLERATED,
    },
  },
  retired: {
    sizeExempt: 'removed in 5.0.0 with the per-node character budget; the per-tier max_prompt_chars cap replaced it',
  },
};

export const NODE_FORMAT: FileFormatSchema = {
  name: 'node',
  file: '.yggdrasil/model/<path>/yg-node.yaml',
  summary: 'Node definition — type, mapping, aspects, relations, ports.',
  root: NODE_ROOT,
};

// ============================================================
// yg-architecture.yaml
// ============================================================

/** `relations:` of a node type: the allowed targets per relation type, and the default for the rest. */
const ARCHITECTURE_RELATIONS: ObjectType = {
  kind: 'object',
  fields: {
    ...Object.fromEntries(
      RELATION_TYPE_VALUES.map((t): [string, Field] => [t, { type: stringList(), description: `Node types a ${t} relation may target (\`*\` for any); an empty list allows none.` }]),
    ),
    default: { type: { kind: 'string', values: ['allow', 'deny'] }, description: 'What a relation type not listed here may target.', default: 'allow' },
  },
};

/** One entry of `node_types:`. */
export const ARCHITECTURE_NODE_TYPE: ObjectType = {
  kind: 'object',
  fields: {
    description: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'What a node of this type is.' },
    aspects: { type: ATTACHMENTS, description: 'Rules every node of this type carries (channel 3).' },
    parents: { type: stringList(), description: 'Node types a node of this type may sit under; `root` allows the top level. Absent: anywhere.' },
    relations: { type: ARCHITECTURE_RELATIONS, description: 'Which node types each relation type from this type may target.' },
    log_required: { type: { kind: 'boolean' }, description: 'Whether a node of this type needs a log entry when its files change since the last full yg check --approve that closed its cycle (--only-deterministic never closes one; log-cycle-open warns while none has).' },
    when: { type: { kind: 'predicate', grammar: 'file' }, description: 'The files this type classifies (path and content atoms).' },
    enforce: { type: { kind: 'string', values: ['strict'] }, description: 'strict: a file matching when must be mapped to a node of this type, and a node of this type may map only matching files.' },
  },
  retired: {
    sizeExempt: 'removed in 5.0.0 with the per-node character budget; the per-tier max_prompt_chars cap replaced it',
  },
};

/** The top level of yg-architecture.yaml. */
export const ARCHITECTURE_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    node_types: { type: { kind: 'map', key: 'type', of: ARCHITECTURE_NODE_TYPE }, description: 'The node types of this graph, by name (`*` is reserved).' },
  },
};

export const ARCHITECTURE_FORMAT: FileFormatSchema = {
  name: 'architecture',
  file: '.yggdrasil/yg-architecture.yaml',
  summary: 'Architecture — node types, default aspects, allowed parents and relations.',
  root: ARCHITECTURE_ROOT,
};

// ============================================================
// yg-aspect.yaml and yg-aspect.adapt.yaml
// ============================================================

/** One entry of a rule's `implies:`: a rule id, or { id, when, status_inherit }. */
const IMPLIES_EDGE_OBJECT: ObjectType = {
  kind: 'object',
  fields: {
    id: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The implied rule\'s id.' },
    when: { type: { kind: 'predicate', grammar: 'node' }, description: 'Imply the rule only where this node predicate holds.' },
    status_inherit: { type: { kind: 'string', values: STATUS_INHERIT_VALUES }, description: 'strictest: the implied rule takes the implier\'s status when that is higher; own-default: it keeps its own.', default: 'strictest' },
  },
};

/** A rule's `reviewer:` block. */
export const ASPECT_REVIEWER: ObjectType = {
  kind: 'object',
  fields: {
    type: { type: { kind: 'string', values: ['llm', 'deterministic', 'aggregate'] }, required: 'yes, when reviewer: is present', description: 'The rule kind; must agree with the rule source (content.md, check.mjs, or neither).' },
    tier: { type: { kind: 'string', nonEmpty: true }, description: 'The reviewer tier of yg-config.yaml a reviewer rule is judged by; the default tier when absent.' },
  },
};

/** A rule's `scope:` block. */
export const ASPECT_SCOPE: ObjectType = {
  kind: 'object',
  fields: {
    per: { type: { kind: 'string', values: ['node', 'file'] }, required: 'yes, when scope: is present', description: 'One verdict per node, or one per subject file.' },
    files: { type: { kind: 'predicate', grammar: 'file' }, description: 'Which of the unit\'s files the rule looks at (path and content atoms).' },
  },
};

/** One object entry of a rule's `references:`. */
export const ASPECT_REFERENCE: ObjectType = {
  kind: 'object',
  fields: {
    path: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'A repository-relative file.' },
    description: { type: { kind: 'string' }, description: 'What the reviewer should take from it.' },
  },
};

const ASPECT_FIELDS = {
  reviewer: { type: ASPECT_REVIEWER, description: 'Optional: the kind is inferred from the rule source.' },
  status: { type: { kind: 'string', values: ASPECT_STATUS_VALUES }, description: 'How much the rule\'s refusals count.', default: 'enforced' },
  review_by: { type: { kind: 'string', format: 'YYYY-MM-DD' }, description: 'A review date; once past, yg check warns without blocking. The user\'s to set.' },
  references: {
    type: { kind: 'list', of: { kind: 'oneOf', of: [{ kind: 'string', nonEmpty: true }, ASPECT_REFERENCE] } },
    description: 'Supporting files shown to a reviewer rule\'s reviewer (not allowed on a script rule or a bundle).',
  },
  scope: { type: ASPECT_SCOPE, description: 'Review granularity (not allowed on a bundle).', default: 'per: node' },
  companion: { type: { kind: 'string', nonEmpty: true }, description: 'A repository-relative companion module to use instead of a companion.mjs beside the rule.' },
  config: { type: { kind: 'map', key: 'key', of: { kind: 'scalar' } }, description: 'Values a package rule\'s check reads through ctx.config; only the keys its package declares.' },
  stores_content: { type: { kind: 'boolean' }, description: 'false keeps this rule\'s refusals out of the local refused-content store except for the verdict hash and the reason: no subject file is copied. Set it on a rule that detects secrets, so a refusal does not leave a second copy of the secret on disk.', default: 'true' },
} satisfies Record<string, Field>;

/** The top level of a yg-aspect.yaml. */
export const ASPECT_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    name: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'Display name.' },
    description: { type: { kind: 'string' }, required: 'yes (description-missing without it)', description: 'What the rule demands; a reviewer rule\'s reviewer is told it.' },
    reviewer: ASPECT_FIELDS.reviewer,
    status: ASPECT_FIELDS.status,
    review_by: ASPECT_FIELDS.review_by,
    errs: { type: { kind: 'string', values: ERRS_DIRECTION_VALUES }, description: 'A script rule\'s honest error direction: under means it fires only on provable violations.' },
    implies: { type: { kind: 'list', of: { kind: 'oneOf', of: [{ kind: 'string', nonEmpty: true }, IMPLIES_EDGE_OBJECT] } }, description: 'Rules this one brings with it wherever it applies (channel 7); a rule with implies: and no rule source is a bundle.' },
    when: { type: { kind: 'predicate', grammar: 'node' }, description: 'Apply the rule only to nodes where this node predicate holds.' },
    references: ASPECT_FIELDS.references,
    scope: ASPECT_FIELDS.scope,
    companion: ASPECT_FIELDS.companion,
    config: ASPECT_FIELDS.config,
    stores_content: ASPECT_FIELDS.stores_content,
  },
  retired: {
    id: "never read: a rule's id is its directory path under aspects/",
    language: 'removed in 5.0.0: a script rule reads each file\'s language from its extension',
    stability: 'removed in 4.0.0',
    anchors: 'removed in 4.0.0',
  },
};

export const ASPECT_FORMAT: FileFormatSchema = {
  name: 'aspect',
  file: '.yggdrasil/aspects/<id>/yg-aspect.yaml',
  summary: 'Aspect definition — rule kind, status, implies, when, references, scope.',
  root: ASPECT_ROOT,
};

/**
 * The adaptation's `reviewer:` and `scope:` blocks. They merge key by key over
 * the rule's own, so neither needs the key the rule's block requires: a missing
 * `type` stays the package's (the kind its rule files give it when the rule
 * declares none), a missing `per` stays the rule's (or the default `node`).
 */
const ADAPT_REVIEWER: ObjectType = {
  kind: 'object',
  fields: {
    type: { ...ASPECT_REVIEWER.fields.type, required: undefined, description: 'The package\'s kind stays in force when omitted; if set, it must agree with the rule source.' },
    tier: ASPECT_REVIEWER.fields.tier,
  },
};
const ADAPT_SCOPE: ObjectType = {
  kind: 'object',
  fields: {
    per: { ...ASPECT_SCOPE.fields.per, required: undefined, description: 'One verdict per node, or one per subject file; the rule\'s own per (or node) when omitted.' },
    files: ASPECT_SCOPE.fields.files,
  },
};

/** The top level of a yg-aspect.adapt.yaml: the keys a consumer may set over an installed rule. */
export const ASPECT_ADAPT_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    scope: { ...ASPECT_FIELDS.scope, type: ADAPT_SCOPE, description: 'Replace or narrow the rule\'s scope (merged key by key).' },
    reviewer: { ...ASPECT_FIELDS.reviewer, type: ADAPT_REVIEWER, description: 'Change the rule\'s reviewer tier (merged key by key; type stays the package\'s).' },
    review_by: ASPECT_FIELDS.review_by,
    references: { ...ASPECT_FIELDS.references, description: 'Replace the rule\'s reference files with files of this repository.' },
    status: ASPECT_FIELDS.status,
    config: { ...ASPECT_FIELDS.config, description: 'Override the defaults of the settings the package declares for this rule.' },
    companion: { ...ASPECT_FIELDS.companion, description: 'Point the rule at a companion module written in this repository.' },
    stores_content: { ...ASPECT_FIELDS.stores_content, description: 'false keeps this rule\'s refusals out of your local refused-content store except for the verdict hash and the reason — for a package rule that detects secrets.' },
  },
  refused: {
    name: 'the name identifies the rule the package published',
    description: 'the description is what the reviewer is told the rule means — changing it changes the rule, not its fit',
    implies: 'which other rules a rule pulls in is part of what the rule is',
    errs: 'the error direction states how the rule was built to fail, which only its author knows',
    when: 'when the rule applies is the package author\'s claim about where it is valid — narrow it with scope: instead',
  },
};

export const ASPECT_ADAPT_FORMAT: FileFormatSchema = {
  name: 'aspect-adapt',
  file: '.yggdrasil/aspects/packages/<owner>/<repo>/<package>/<rule>/yg-aspect.adapt.yaml',
  summary: 'Adaptation of an installed package rule — the keys a consumer may set over it.',
  root: ASPECT_ADAPT_ROOT,
};

// ============================================================
// yg-flow.yaml
// ============================================================

/** The top level of a yg-flow.yaml. */
export const FLOW_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    name: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'Display name of the business process.' },
    description: { type: { kind: 'string' }, required: 'yes (description-missing without it)', description: 'What the process does.' },
    nodes: { type: stringList(), required: 'yes, non-empty (or participants)', description: 'Participant nodes, as paths under model/; each participant\'s descendants take part too.' },
    participants: { type: stringList(), description: 'Alias of nodes.' },
    aspects: { type: ATTACHMENTS, description: 'Rules every participant carries (channel 5).' },
  },
};

export const FLOW_FORMAT: FileFormatSchema = {
  name: 'flow',
  file: '.yggdrasil/flows/<name>/yg-flow.yaml',
  summary: 'Flow definition — a business process with node participants and propagated aspects.',
  root: FLOW_ROOT,
};
