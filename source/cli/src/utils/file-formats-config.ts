/**
 * source/cli/src/utils/file-formats-config.ts — the schemas of yg-config.yaml
 * and of the gitignored yg-secrets.yaml overlay laid over it.
 *
 * A block whose parser takes its accepted and retired keys from it is exported
 * on its own as well as inside the file's schema. See file-schema.ts for what a
 * schema drives.
 */

import { KNOWN_PROVIDERS, PROVIDER_DEFAULT_MODELS, providersWithDefaultModel } from './known-providers.js';
import type { Field, FieldType, FileFormatSchema, ObjectType } from './file-schema.js';

/** A tier's `config:` — the provider settings. */
export const TIER_CONFIG: ObjectType = {
  kind: 'object',
  fields: {
    model: { type: { kind: 'string', nonEmpty: true }, required: `yes, except for ${providersWithDefaultModel()}`, description: `The provider's model identifier; when it is absent, ${Object.entries(PROVIDER_DEFAULT_MODELS).map(([p, m]) => `${p} uses ${m}`).join(', ')}.` },
    endpoint: { type: { kind: 'string' }, required: 'yes, for openai-compatible', description: 'The API endpoint URL (ollama defaults to `http://localhost:11434`).' },
    temperature: { type: { kind: 'number', min: 0 }, description: 'Sampling temperature; the CLI providers ignore it.', default: '0' },
    timeout: { type: { kind: 'number' }, description: 'Per-call timeout in seconds, a positive number.', default: '300 for the CLI providers and ollama, 60 for the hosted APIs' },
    api_key: { type: { kind: 'string' }, description: 'The provider API key; put it in yg-secrets.yaml, never in the committed file.' },
  },
  retired: {
    max_tokens: 'removed in 5.0.0; the reviewer no longer caps its reply',
    context_length_field: 'never read by any release since 5.0.0',
    references: 'removed in 5.0.0 with the per-tier reference size caps; the per-tier max_prompt_chars cap replaced them',
  },
};

/** One entry of `reviewer.tiers:`. */
export const REVIEWER_TIER: ObjectType = {
  kind: 'object',
  fields: {
    provider: { type: { kind: 'string', values: KNOWN_PROVIDERS }, required: true, description: 'Which reviewer the tier calls.' },
    consensus: { type: { kind: 'integer', min: 1 }, required: true, description: '1 for a single call, or an odd number for a majority vote.' },
    config: { type: TIER_CONFIG, required: true, description: 'The provider settings.' },
    max_prompt_chars: { type: { kind: 'integer', min: 1 }, description: 'The longest prompt a reviewer pair on this tier may send (prompt-too-large above it).', default: '50000' },
  },
};

/** The `reviewer:` block. */
export const CONFIG_REVIEWER: ObjectType = {
  kind: 'object',
  fields: {
    default: { type: { kind: 'string', nonEmpty: true }, required: 'yes, with more than one tier', description: 'The tier a reviewer rule without reviewer.tier uses.' },
    tiers: { type: { kind: 'map', key: 'tier', of: REVIEWER_TIER }, required: 'yes, at least one', description: 'Named reviewer configurations; a tier name starts with a letter and `default` is reserved.' },
  },
};

export const CONFIG_QUALITY: ObjectType = {
  kind: 'object',
  fields: {
    max_direct_relations: { type: { kind: 'integer', min: 1 }, description: 'The relation count above which a node gets the high-fan-out warning.', default: '10' },
  },
  retired: {
    max_node_chars: 'removed in 5.0.0 with the per-node character budget; the per-tier max_prompt_chars cap replaced it',
    max_mapping_source_files: 'removed in 5.0.0 with the wide-node warning',
  },
};

export const CONFIG_COVERAGE: ObjectType = {
  kind: 'object',
  fields: {
    required: { type: { kind: 'list', of: { kind: 'string' } }, description: 'Repository-relative roots every file under which must be covered.', default: '["/"]' },
    excluded: { type: { kind: 'list', of: { kind: 'string' } }, description: 'Roots removed from every check, not only from coverage: an excluded file gets no coverage finding, no review pair, no type classification and no rule read, even when a node\'s mapping names it. A subtree with its own nested .yggdrasil/ or its own .git is excluded the same way.', default: '[]' },
    type_level: { type: { kind: 'boolean' }, description: 'Enforce per: file rules of classifying types on files no node maps. Read from the committed file only.', default: 'false' },
  },
};

export const CONFIG_SIGNALS: ObjectType = {
  kind: 'object',
  fields: {
    attention: { type: { kind: 'boolean' }, description: 'The advisory "structurally unusual" note in yg context --file.', default: 'true' },
  },
};

export const CONFIG_EVENTS: ObjectType = {
  kind: 'object',
  fields: {
    committed_llm: { type: { kind: 'boolean' }, description: 'Keep a committed, shared record of reviewer verification events.', default: 'false' },
  },
};

export const CONFIG_PROGRESSIVE: ObjectType = {
  kind: 'object',
  fields: {
    reference: { type: { kind: 'string', nonEmpty: true }, required: 'yes, when progressive: is present', description: 'The branch a change is measured against (e.g. origin/main). Read from the committed file only.' },
  },
};

const CONFIG_TYPE_LAW: ObjectType = {
  kind: 'object',
  fields: {
    ratification: { type: { kind: 'boolean' }, description: 'A rule enforced on a node type must carry a ratification of its current version in its own log, or type-law-unratified blocks; false or absent asks for none. Read from the committed file only.', default: 'false' },
  },
};

const CONFIG_RULES_ARTIFACTS: ObjectType = {
  kind: 'object',
  fields: {
    agents_md: { type: { kind: 'boolean' }, description: 'Write and check the Yggdrasil block in AGENTS.md.', default: 'true' },
    claude_md: { type: { kind: 'boolean' }, description: 'Write and check the @AGENTS.md import in CLAUDE.md (refused while agents_md is off).', default: 'true' },
    clinerules: { type: { kind: 'boolean' }, description: 'Write and check .clinerules/yggdrasil.md.', default: 'true' },
  },
};

/** The top level of yg-config.yaml. */
export const CONFIG_ROOT: ObjectType = {
  kind: 'object',
  fields: {
    version: {
      type: { kind: 'string' },
      required: true,
      description: 'The graph schema version, a quoted three-part string managed by yg init --upgrade.',
      tolerated: 'a version that is not a string is refused before the file is parsed, by every command that loads the graph and by yg init --upgrade, each with its own message',
    },
    quality: { type: CONFIG_QUALITY, description: 'Quality thresholds.' },
    reviewer: { type: CONFIG_REVIEWER, required: 'once a reviewer rule is in effect', description: 'The reviewer tiers reviewer rules are judged by.' },
    parallel: { type: { kind: 'integer', min: 1 }, description: 'Reviewer-rule pairs reviewed at once.', default: '1' },
    debug: { type: { kind: 'boolean' }, description: 'Append all CLI output to .yggdrasil/.debug.log.', default: 'false' },
    auto_approve: { type: { kind: 'oneOf', of: [{ kind: 'boolean', only: false }, { kind: 'string', values: ['deterministic', 'full'] }] }, description: 'What a bare yg check fills: false nothing, deterministic the script pairs, full every pair (held back under CI).', default: 'false' },
    signals: { type: CONFIG_SIGNALS, description: 'Attention-layer switches.' },
    events: { type: CONFIG_EVENTS, description: 'The committed-events opt-in.' },
    coverage: { type: CONFIG_COVERAGE, description: 'Which files must be mapped to a node.' },
    progressive: { type: CONFIG_PROGRESSIVE, description: 'Progressive mode: block only on what a change reaches. Absent means off.' },
    rules_artifacts: { type: CONFIG_RULES_ARTIFACTS, description: 'Which agent-rules artifacts are written and kept in sync. Read from the committed file only.' },
    type_law: { type: CONFIG_TYPE_LAW, description: 'Whether law that reaches a whole node type must be admitted before it blocks. Read from the committed file only.' },
  },
};

export const CONFIG_FORMAT: FileFormatSchema = {
  name: 'config',
  file: '.yggdrasil/yg-config.yaml',
  summary: 'Project configuration — reviewer tiers, quality, coverage, auto_approve.',
  root: CONFIG_ROOT,
};

/**
 * yg-secrets.yaml takes the same keys as yg-config.yaml and is deep-merged over
 * it; its own keys are checked under its own name, so a typo is reported where
 * it is.
 */
export const SECRETS_FORMAT: FileFormatSchema = {
  name: 'secrets',
  file: '.yggdrasil/yg-secrets.yaml',
  summary: 'Local overlay of yg-config.yaml (gitignored) — most often a tier\'s api_key, model or endpoint.',
  root: optionalObject(CONFIG_ROOT),
};

/**
 * The object, with nothing required of it at any depth: an overlay sets only
 * what it changes, so a tier's provider, consensus and config are as optional
 * in yg-secrets.yaml as the top-level blocks — the deep merge supplies the rest
 * from yg-config.yaml, and the merged result is what is held to the schema.
 */
function optionalObject(type: ObjectType): ObjectType {
  return { ...type, fields: Object.fromEntries(Object.entries(type.fields).map(([key, field]): [string, Field] => [key, optional(field)])) };
}

function optionalType(type: FieldType): FieldType {
  switch (type.kind) {
    case 'object':
      return optionalObject(type);
    case 'list':
      return { ...type, of: optionalType(type.of) };
    case 'map':
      return { ...type, of: optionalType(type.of) };
    case 'oneOf':
      return { ...type, of: type.of.map(optionalType) };
    default:
      return type;
  }
}

/** The field, with nothing required of it or of anything inside it. */
function optional(field: Field): Field {
  return {
    type: optionalType(field.type),
    description: field.description,
    ...(field.default !== undefined && { default: field.default }),
    ...(field.tolerated !== undefined && { tolerated: field.tolerated }),
  };
}
