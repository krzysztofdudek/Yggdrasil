import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, parseDocument, isScalar } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
  ReviewerConfig,
  CoverageConfig,
  RulesArtifactsConfig,
} from '../model/graph.js';
import { DEFAULT_RULES_ARTIFACTS } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { KNOWN_PROVIDERS } from '../utils/known-providers.js';
import { loadConfigOverlay, deepMerge } from './secrets-parser.js';
import { readFileOrDefault } from './read-or-default.js';
import { debugWrite } from '../utils/debug-log.js';
import { closestKnownKey, describeUnknownKeys, findUnknownKeys, type RetiredKeys } from '../utils/known-keys.js';

export { KNOWN_PROVIDERS };

export class ConfigParseError extends Error {
  constructor(public messageData: IssueMessage, public code: string) {
    super(messageData.what);
  }
}

/** The keys `quality:` accepts. */
export const QUALITY_KEYS = ['max_direct_relations'] as const;

/** `quality:` keys an earlier release read, and what became of each. `yg init --upgrade` removes them. */
export const RETIRED_QUALITY_KEYS: RetiredKeys = {
  max_node_chars: 'removed in 5.0.0 with the per-node character budget; the per-tier max_prompt_chars cap replaced it',
  max_mapping_source_files: 'removed in 5.0.0 with the wide-node warning',
};

/** Tier `config:` keys an earlier release read, and what became of each. `yg init --upgrade` removes them. */
export const RETIRED_TIER_CONFIG_KEYS: RetiredKeys = {
  max_tokens: 'removed in 5.0.0; the reviewer no longer caps its reply',
  context_length_field: 'never read by any release since 5.0.0',
  references: 'removed in 5.0.0 with the per-tier reference size caps; the per-tier max_prompt_chars cap replaced them',
};

/**
 * The keys a tier's `config:` block accepts. Every provider reads its settings
 * from this one list; a key outside it is a typo (`modle:`) that would leave the
 * setting at its default without a word. Not every provider uses every key —
 * the CLI providers (claude-code, codex, gemini-cli, copilot-cli) take `model`
 * and `timeout` and ignore `temperature` and `endpoint` — but each key is known.
 */
export const TIER_CONFIG_KEYS = ['model', 'endpoint', 'temperature', 'timeout', 'api_key'] as const;

const DEFAULT_QUALITY: QualityConfig = {
  max_direct_relations: 10,
};

export const DEFAULT_COVERAGE: CoverageConfig = { required: ['/'], excluded: [], typeLevel: false };

/**
 * What the `version:` field of a yg-config.yaml holds, read ONE way for every
 * caller (the graph loader's schema gate, the migrator, `yg init --upgrade`,
 * `yg simulate`, and this parser's own `config.version`):
 *
 *  - `absent`     — the key is not there at all;
 *  - `string`     — a YAML string, trimmed (whether it is valid semver is the
 *                   caller's question);
 *  - `not-string` — present but not a string, most often an unquoted
 *                   `version: 5.1`, which YAML reads as the NUMBER 5.1. `shown`
 *                   is how the value reads back, for the error message.
 *
 * Distinguishing the last two from a string is the point: a reader that only
 * accepts strings turns a number or a missing line into "no version", and a gate
 * keyed on "no version" then lets the graph load unchecked.
 */
export type SchemaVersionField =
  | { kind: 'absent' }
  | { kind: 'string'; value: string }
  | { kind: 'not-string'; shown: string };

export function readSchemaVersionField(raw: Record<string, unknown>): SchemaVersionField {
  if (!Object.prototype.hasOwnProperty.call(raw, 'version') || raw.version === undefined) {
    return { kind: 'absent' };
  }
  const v = raw.version;
  if (typeof v === 'string') return { kind: 'string', value: v.trim() };
  return { kind: 'not-string', shown: typeof v === 'number' ? String(v) : JSON.stringify(v) };
}

/**
 * {@link readSchemaVersionField} over the raw text of a yg-config.yaml. Returns
 * null when the text is not a YAML mapping (or not YAML at all): that file has
 * no readable fields, and reporting it is the full config parser's job.
 */
export function parseSchemaVersionText(content: string): SchemaVersionField | null {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    debugWrite(`[config-parser] schema version read: ${(err as Error).message}`);
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const field = readSchemaVersionField(doc as Record<string, unknown>);
  if (field.kind !== 'not-string') return field;
  // Show the value as it is WRITTEN, not as YAML re-reads it: `version: 99.0`
  // parses to the number 99, and an error quoting "99" would not match the file.
  const node = parseDocument(content).get('version', true);
  if (isScalar(node) && node.range) {
    const written = content.slice(node.range[0], node.range[1]).trim();
    if (written.length > 0) return { kind: 'not-string', shown: written };
  }
  return field;
}

/**
 * Every top-level key yg-config.yaml (and its yg-secrets.yaml overlay) may carry.
 * Each sub-block already rejects keys it does not know; the top level does the
 * same, because a misspelled block name (`coverge:`, `progresive:`) would
 * otherwise fall back to its default without a word, and the configuration in
 * effect would quietly differ from the one the file appears to state.
 */
const KNOWN_TOP_LEVEL_KEYS = [
  'version', 'quality', 'reviewer', 'parallel', 'debug', 'auto_approve',
  'signals', 'events', 'coverage', 'progressive', 'rules_artifacts',
];

/**
 * One top-level key the configuration does not know, with the file it sits in
 * (`yg-config.yaml`, or the local `yg-secrets.yaml` overlay) and the known key
 * it is plausibly a typo of, when there is one.
 */
export interface UnknownConfigKey {
  file: string;
  key: string;
  suggestion?: string;
}

function findUnknownTopLevelKeys(raw: Record<string, unknown>, filename: string): UnknownConfigKey[] {
  const found: UnknownConfigKey[] = [];
  for (const key of Object.keys(raw)) {
    if (KNOWN_TOP_LEVEL_KEYS.includes(key)) continue;
    const suggestion = closestKnownKey(key, KNOWN_TOP_LEVEL_KEYS);
    found.push({ file: filename, key, ...(suggestion !== undefined && { suggestion }) });
  }
  return found;
}

/**
 * The what/why/next of one unknown top-level key. The key is ignored and the
 * rest of the file stays in effect, so the message is about the key alone; for
 * the gitignored overlay it also says why nobody else sees the error.
 */
export function unknownConfigKeyMessage(u: UnknownConfigKey): IssueMessage {
  const where = `.yggdrasil/${u.file}`;
  const local = u.file === 'yg-secrets.yaml'
    ? ' This file is local and gitignored, so CI and the rest of the team do not see this error; only this machine does.'
    : '';
  return {
    what: `${where}: unknown top-level key '${u.key}'.`,
    why: `The configuration accepts only: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}. An unrecognized key is almost always a typo, and whatever it was meant to set is not in effect: the key is ignored and the rest of the configuration applies.${local}`,
    next: u.suggestion
      ? `Did you mean '${u.suggestion}'? Rename '${u.key}' to '${u.suggestion}' in ${where}, or remove it.`
      : `Rename '${u.key}' in ${where} to one of: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}, or remove it.`,
  };
}

/**
 * A configuration that parsed except for unknown top-level keys. Thrown by
 * {@link parseConfig} for callers that treat any configuration problem as
 * fatal; the graph loader uses {@link parseConfigDetailed} instead, keeps
 * {@link config} and reports the keys.
 */
export class ConfigUnknownKeysError extends ConfigParseError {
  constructor(public unknownKeys: UnknownConfigKey[], public config: YggConfig) {
    super(unknownConfigKeyMessage(unknownKeys[0]), 'config-unknown-key');
  }
}

function parseStringArray(raw: unknown, field: string, filename: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new ConfigParseError({
      what: `${filename}: ${field} must be a list of strings (got ${JSON.stringify(raw)}).`,
      why: 'Coverage roots are repo-relative path prefixes; a non-list value cannot be matched against files.',
      next: `Set ${field} to a YAML list, e.g. ${field.split('.').pop()}: [services/]`,
    }, 'config-invalid');
  }
  return raw as string[];
}

function parseCoverage(raw: unknown, filename: string): CoverageConfig {
  if (raw === undefined) return DEFAULT_COVERAGE;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    throw new ConfigParseError({
      what: `${filename}: coverage must be a mapping`,
      why: 'coverage holds the required/excluded root lists',
      next: 'replace with `coverage: { required: ["/"], excluded: [] }`',
    }, 'config-invalid');
  }
  const cov = raw as Record<string, unknown>;
  const KNOWN_COVERAGE_KEYS = ['required', 'excluded', 'type_level'];
  for (const key of Object.keys(cov)) {
    if (!KNOWN_COVERAGE_KEYS.includes(key)) {
      throw new ConfigParseError({
        what: `${filename}: unknown key '${key}' under coverage.`,
        why: `coverage accepts only: ${KNOWN_COVERAGE_KEYS.join(', ')}. An unrecognized key is almost always a typo, and a silently ignored typo means coverage enforcement quietly differs from what the config appears to say.`,
        next: `Fix the key to one of: ${KNOWN_COVERAGE_KEYS.join(', ')}.`,
      }, 'config-coverage-unknown-key');
    }
  }
  if (cov.type_level !== undefined && typeof cov.type_level !== 'boolean') {
    throw new ConfigParseError({
      what: `${filename}: coverage.type_level must be a boolean`,
      why: 'type_level switches type-level coverage on or off — a non-boolean value is a typo, and guessing would silently enable or disable enforcement.',
      next: 'Set coverage.type_level: true or false (or remove the key; absent means false).',
    }, 'config-invalid');
  }
  const required = cov.required === undefined ? ['/'] : parseStringArray(cov.required, 'coverage.required', filename);
  const excluded = parseStringArray(cov.excluded, 'coverage.excluded', filename);

  // An explicit empty `required: []` is permitted and means "require nothing":
  // every uncovered file (outside excluded/nested) surfaces as a non-blocking
  // uncovered-advisory warning, so nothing blocks. This is intentional
  // pure-advisory adoption — visible (you still see every uncovered file as a
  // warning), not silent. (The ABSENT-block default remains ['/'] above, which
  // requires the whole repo; only an explicit [] opts into require-nothing.)

  // Coverage roots are repo-relative prefixes; ".." never matches a real repo-relative
  // path and silently mis-scopes coverage enforcement.
  for (const root of [...required, ...excluded]) {
    if (root.split('/').includes('..')) {
      throw new ConfigParseError({
        what: `${filename}: coverage root '${root}' contains a '..' segment.`,
        why: "'..' is not a valid repo-relative prefix and will never match any real repo-relative path, silently mis-scoping coverage enforcement.",
        next: 'Use a repo-relative path prefix without any ".." segments (e.g. - services/ instead of - services/../other/).',
      }, 'config-invalid');
    }
  }

  return { required, excluded, typeLevel: cov.type_level === true };
}

/** YAML key ⇄ resolved field for each of the three agent-rules artifacts, in the
 *  order they are installed. One table so the allowed-key set, the per-key type
 *  check and the resolution below can never disagree about what exists. */
const RULES_ARTIFACT_KEYS = [
  ['agents_md', 'agentsMd'],
  ['claude_md', 'claudeMd'],
  ['clinerules', 'clinerules'],
] as const satisfies ReadonlyArray<readonly [string, keyof RulesArtifactsConfig]>;

/**
 * Validate the optional `rules_artifacts` block — which of the three agent-rules
 * artifacts this repository wants written and checked.
 *
 * Absent block, or an absent key inside it, resolves to `true`: today's
 * behavior for every adopter who never touches it (all three installed by
 * `yg init`, all three compared by the committed-digest gate). The block only
 * ever turns something OFF.
 *
 * STRICT when present, for the same reason `signals` / `events` / `progressive`
 * are: the section is a tight, enumerated namespace, and a misspelled key
 * (`clinrules`) or a string value (`"false"`) would otherwise leave the repo
 * believing it had opted out while `yg check` kept reporting the artifact as
 * missing on every run — exactly the nagging this key exists to end.
 *
 * The one cross-key rule: `claude_md` may not stay on while `agents_md` is off.
 * `claude_md`'s entire content is a one-line `@AGENTS.md` import, so that
 * combination asks for a pointer to a file Yggdrasil no longer maintains —
 * refused here rather than written and left dangling.
 */
function parseRulesArtifacts(raw: unknown, filename: string): RulesArtifactsConfig {
  if (raw === undefined) return DEFAULT_RULES_ARTIFACTS;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    throw new ConfigParseError({
      what: `${filename}: rules_artifacts must be a mapping (got ${JSON.stringify(raw)}).`,
      why: 'rules_artifacts holds one boolean per agent-rules artifact (agents_md, claude_md, clinerules); a non-mapping value cannot carry them.',
      next: 'Set rules_artifacts to a mapping, e.g. `rules_artifacts: { clinerules: false }`, or remove the key to keep all three.',
    }, 'config-invalid');
  }
  const block = raw as Record<string, unknown>;
  const allowed = new Set<string>(RULES_ARTIFACT_KEYS.map(([yamlKey]) => yamlKey));
  for (const k of Object.keys(block)) {
    if (!allowed.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: unknown key '${k}' under rules_artifacts.`,
        why: `rules_artifacts accepts only: ${[...allowed].join(', ')}. A misspelled key would silently leave that artifact switched ON, so yg check would keep reporting it as missing while the config reads as though it had been turned off.`,
        next: `Remove the key, or set one of ${[...allowed].join(' / ')} to true or false.`,
      }, 'config-rules-artifacts-unknown-key');
    }
  }
  const resolved = { ...DEFAULT_RULES_ARTIFACTS };
  for (const [yamlKey, field] of RULES_ARTIFACT_KEYS) {
    const value = block[yamlKey];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ConfigParseError({
        what: `${filename}: rules_artifacts.${yamlKey} must be a boolean (got ${JSON.stringify(value)}).`,
        why: 'It switches one agent-rules artifact on or off; a non-boolean value is a typo, and guessing would either write a file the repo opted out of or stop writing one it still wants.',
        next: `Set rules_artifacts.${yamlKey} to true or false (or remove the key; absent means true).`,
      }, 'config-invalid');
    }
    resolved[field] = value;
  }
  if (resolved.claudeMd && !resolved.agentsMd) {
    throw new ConfigParseError({
      what: `${filename}: rules_artifacts has claude_md on while agents_md is off.`,
      why: 'The whole of the CLAUDE.md artifact is a single `@AGENTS.md` import line, so this asks for an import of a file Yggdrasil no longer writes or keeps in sync — a pointer that resolves to nothing the moment AGENTS.md drifts or disappears.',
      next: 'Turn both off (`agents_md: false, claude_md: false`), or leave agents_md on.',
    }, 'config-rules-artifacts-orphan-import');
  }
  return resolved;
}

/** Validate the optional quality.max_direct_relations (positive integer). */
function parseMaxDirectRelations(raw: unknown, filename: string): number {
  if (raw === undefined) return DEFAULT_QUALITY.max_direct_relations ?? 10;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ConfigParseError({
      what: `${filename}: quality.max_direct_relations must be a positive integer (got ${JSON.stringify(raw)}).`,
      why: 'It is the per-node relation-count budget; a zero, negative, or fractional value makes the threshold nonsensical.',
      next: 'Set quality.max_direct_relations to a positive integer (default 10), or remove it to use the default.',
    }, 'config-invalid');
  }
  return raw;
}

const PROVIDER_DEFAULTS: Record<string, Partial<LlmConfig>> = {
  'claude-code': { model: 'haiku' },
  'codex': { model: 'o4-mini' },
  'gemini-cli': { model: 'gemini-2.5-flash' },
};

/**
 * Parse yg-config.yaml (and, unless skipped, its yg-secrets.yaml overlay).
 * Throws {@link ConfigParseError} on any problem, unknown top-level keys
 * included ({@link ConfigUnknownKeysError}, which still carries the parsed
 * configuration).
 */
export async function parseConfig(
  filePath: string,
  opts?: { skipSecretsOverlay?: boolean },
): Promise<YggConfig> {
  const { config, unknownKeys } = await parseConfigDetailed(filePath, opts);
  if (unknownKeys.length > 0) throw new ConfigUnknownKeysError(unknownKeys, config);
  return config;
}

/**
 * {@link parseConfig}, but unknown top-level keys are returned beside the
 * configuration instead of thrown. An unknown key sets nothing, so the rest of
 * the configuration is exactly what the files say; falling back to defaults
 * because of one would drop the coverage exclusions, the reviewer and every
 * other setting over a typo. Any other problem still throws; when unknown keys
 * were found too, the thrown error carries them as `unknownKeys`.
 */
export async function parseConfigDetailed(
  filePath: string,
  opts?: { skipSecretsOverlay?: boolean },
): Promise<{ config: YggConfig; unknownKeys: UnknownConfigKey[] }> {
  let unknownKeys: UnknownConfigKey[] = [];
  try {
    const config = await parseConfigInner(filePath, opts, (found) => { unknownKeys = found; });
    return { config, unknownKeys };
  } catch (err) {
    if (err instanceof ConfigParseError && unknownKeys.length > 0) {
      (err as ConfigParseError & { unknownKeys?: UnknownConfigKey[] }).unknownKeys = unknownKeys;
    }
    throw err;
  }
}

async function parseConfigInner(
  filePath: string,
  opts: { skipSecretsOverlay?: boolean } | undefined,
  reportUnknownKeys: (found: UnknownConfigKey[]) => void,
): Promise<YggConfig> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const baseRaw = parseYaml(content) as Record<string, unknown>;

  if (!baseRaw || typeof baseRaw !== 'object' || Array.isArray(baseRaw)) {
    throw new ConfigParseError({
      what: `${filename} is empty or not a valid YAML mapping`,
      why: 'the top-level structure must be a YAML mapping with keys like reviewer, quality, parallel',
      next: 'restore the file from version control, or regenerate it via `yg init`',
    }, 'config-invalid');
  }

  // yg-secrets.yaml is a deep-merge overlay over yg-config.yaml (local, gitignored).
  // It can override any field — most often a tier's provider/model/endpoint/api_key —
  // without touching the committed config. The tier NAME is the only verdict input,
  // so an overlay never invalidates recorded baselines.
  //
  // `skipSecretsOverlay` reads the COMMITTED yg-config.yaml only: the overlay file is
  // never opened and never merged. This is the committed-only path a read-only consumer
  // (e.g. a surface that must provably never touch local secrets) uses. The DEFAULT path
  // is unchanged — the overlay is loaded and merged exactly as before.
  const overlay = opts?.skipSecretsOverlay ? undefined : await loadConfigOverlay(path.dirname(filePath));
  // Each file is checked under its own name, so a typo in the gitignored overlay
  // is reported where it actually is. Collected, not thrown: an unknown key sets
  // nothing, so parsing the rest goes on (see parseConfigDetailed).
  reportUnknownKeys([
    ...findUnknownTopLevelKeys(baseRaw, filename),
    ...(overlay ? findUnknownTopLevelKeys(overlay, 'yg-secrets.yaml') : []),
  ]);

  // coverage.type_level is committed-only: capture its value from baseRaw
  // (the committed yg-config.yaml, before any overlay merge) so a gitignored
  // yg-secrets.yaml overlay can never flip enforcement or invalidate lock
  // contents that were computed against the committed value.
  const committedCoverage = baseRaw.coverage;
  const committedTypeLevel =
    committedCoverage && typeof committedCoverage === 'object' && !Array.isArray(committedCoverage) &&
    typeof (committedCoverage as Record<string, unknown>).type_level === 'boolean'
      ? ((committedCoverage as Record<string, unknown>).type_level as boolean)
      : undefined;

  refuseUnknownNestedKeys(baseRaw, filename);
  if (overlay) refuseUnknownNestedKeys(overlay, 'yg-secrets.yaml');
  const raw = overlay ? deepMerge(baseRaw, overlay) : baseRaw;

  const versionField = readSchemaVersionField(raw);
  const version = versionField.kind === 'string' ? versionField.value : undefined;

  const qualityRaw = raw.quality;
  if (qualityRaw !== undefined && (typeof qualityRaw !== 'object' || Array.isArray(qualityRaw))) {
    throw new ConfigParseError({
      what: `${filename}: quality must be a mapping`,
      why: 'quality holds named thresholds (max_direct_relations)',
      next: 'replace with `quality: { max_direct_relations: 10 }`',
    }, 'config-invalid');
  }
  const qualityMap = qualityRaw as Record<string, unknown> | undefined;
  if (qualityMap) refuseUnknownQualityKeys(qualityMap, filename);
  const quality: QualityConfig = qualityMap
    ? {
        max_direct_relations: parseMaxDirectRelations(qualityMap.max_direct_relations, filename),
      }
    : DEFAULT_QUALITY;

  let reviewer: ReviewerConfig | undefined;

  if (raw.reviewer !== undefined) {
    if (
      raw.reviewer && typeof raw.reviewer === 'object' && !Array.isArray(raw.reviewer)
    ) {
      // reviewer: is a mapping — let parseReviewer validate the tiers structure
      // and emit specific errors (config-tiers-missing, config-tiers-empty, etc.)
      reviewer = parseReviewer(raw.reviewer as Record<string, unknown>, filename);
    } else {
      throw new ConfigParseError({
        what: `${filename} has unrecognized reviewer: shape`,
        why: 'reviewer: must be a mapping with a `tiers:` block',
        next: 'run yg schemas read config for the expected shape',
      }, 'config-invalid');
    }
  }

  let parallel: number | undefined;
  if (raw.parallel !== undefined) {
    if (typeof raw.parallel !== 'number') {
      throw new ConfigParseError({
        what: `${filename}: parallel must be a number, got ${typeof raw.parallel}`,
        why: 'parallel controls the concurrent-aspect-verification cap',
        next: 'set `parallel: <positive integer>` (e.g. parallel: 10) or remove the key',
      }, 'config-invalid');
    }
    if (!Number.isInteger(raw.parallel) || raw.parallel < 1) {
      throw new ConfigParseError({
        what: `${filename}: parallel must be a positive integer >= 1, got ${raw.parallel}`,
        why: 'parallel controls the concurrent-aspect-verification cap; values < 1 cannot make progress',
        next: 'set `parallel: <positive integer>` (e.g. parallel: 10) or remove the key',
      }, 'config-invalid');
    }
    parallel = raw.parallel;
  }

  const debug = raw.debug === true ? true : undefined;

  let auto_approve: 'deterministic' | 'full' | false | undefined;
  if (raw.auto_approve !== undefined && raw.auto_approve !== false) {
    if (raw.auto_approve !== 'deterministic' && raw.auto_approve !== 'full') {
      throw new ConfigParseError({
        what: `${filename}: auto_approve must be false, 'deterministic', or 'full' (got ${JSON.stringify(raw.auto_approve)}).`,
        why: "auto_approve controls what bare `yg check` does: false = read-only; 'deterministic' = free local fill; 'full' = full reviewer fill.",
        next: "Set auto_approve to false, deterministic, or full, or remove the key.",
      }, 'config-invalid');
    }
    auto_approve = raw.auto_approve;
  } else if (raw.auto_approve === false) {
    auto_approve = false;
  }

  // signals — optional attention-layer switches. Absent ⇒ undefined (every signal
  // at its default; today that means the advisory "structurally unusual" note in
  // `yg context --file` is ON). Tolerated when absent (like auto_approve), but
  // STRICT-validated when present: `signals` must be a mapping, `signals.attention`
  // (if given) must be boolean, and an UNKNOWN sibling is rejected — the section is
  // a tight, enumerated namespace (mirroring the reviewer section), and a misspelled
  // key (e.g. `attetnion`) would otherwise SILENTLY leave the note enabled, quietly
  // defeating an intended off-switch. No schema-version bump: an absent key changes
  // nothing about how any existing config parses.
  let signals: { attention?: boolean } | undefined;
  if (raw.signals !== undefined) {
    if (typeof raw.signals !== 'object' || Array.isArray(raw.signals) || raw.signals === null) {
      throw new ConfigParseError({
        what: `${filename}: signals must be a mapping (got ${JSON.stringify(raw.signals)}).`,
        why: 'signals holds attention-layer switches (currently `attention`); a non-mapping value cannot carry them.',
        next: 'Set signals to a mapping, e.g. `signals: { attention: false }`, or remove the signals key.',
      }, 'config-invalid');
    }
    const sig = raw.signals as Record<string, unknown>;
    const allowedSignalKeys = new Set(['attention']);
    for (const k of Object.keys(sig)) {
      if (!allowedSignalKeys.has(k)) {
        throw new ConfigParseError({
          what: `${filename}: unknown key '${k}' under signals:`,
          why: 'the signals section accepts only `attention`; a misspelled key would silently leave the advisory "structurally unusual" note enabled, defeating an intended off-switch.',
          next: "Remove the key, or set signals.attention to true or false.",
        }, 'config-signals-unknown-key');
      }
    }
    if (sig.attention !== undefined && typeof sig.attention !== 'boolean') {
      throw new ConfigParseError({
        what: `${filename}: signals.attention must be a boolean (got ${JSON.stringify(sig.attention)}).`,
        why: 'signals.attention toggles the advisory "structurally unusual" note in `yg context --file`; it is on by default, and only a boolean can switch it.',
        next: "Set signals.attention to true or false, or remove the signals key.",
      }, 'config-invalid');
    }
    signals = { attention: sig.attention as boolean | undefined };
  }

  // events — optional committed-events opt-in (RZ-14). Absent ⇒ undefined (every
  // LLM verification-fill event stays in the LOCAL, gitignored sidecar — today's
  // behavior). Tolerated when absent (like auto_approve / signals), but STRICT when
  // present: `events` must be a mapping, `events.committed_llm` (if given) must be
  // boolean, and an UNKNOWN sibling is rejected — the section is a tight, enumerated
  // namespace, and a misspelled key (e.g. `commited_llm`) would otherwise SILENTLY
  // leave the committed LLM-fill stream disabled. No schema-version bump: an absent
  // key changes nothing about how any existing config parses, and the key never
  // folds into any verdict hash (recording it invalidates no baseline).
  let events: { committed_llm?: boolean } | undefined;
  if (raw.events !== undefined) {
    if (typeof raw.events !== 'object' || Array.isArray(raw.events) || raw.events === null) {
      throw new ConfigParseError({
        what: `${filename}: events must be a mapping (got ${JSON.stringify(raw.events)}).`,
        why: 'events holds the committed-events opt-in (currently `committed_llm`); a non-mapping value cannot carry it.',
        next: 'Set events to a mapping, e.g. `events: { committed_llm: true }`, or remove the events key.',
      }, 'config-invalid');
    }
    const ev = raw.events as Record<string, unknown>;
    const allowedEventKeys = new Set(['committed_llm']);
    for (const k of Object.keys(ev)) {
      if (!allowedEventKeys.has(k)) {
        throw new ConfigParseError({
          what: `${filename}: unknown key '${k}' under events:`,
          why: 'the events section accepts only `committed_llm`; a misspelled key would silently leave the committed reviewer-fill event stream disabled.',
          next: 'Remove the key, or set events.committed_llm to true or false.',
        }, 'config-events-unknown-key');
      }
    }
    if (ev.committed_llm !== undefined && typeof ev.committed_llm !== 'boolean') {
      throw new ConfigParseError({
        what: `${filename}: events.committed_llm must be a boolean (got ${JSON.stringify(ev.committed_llm)}).`,
        why: 'events.committed_llm opts the repo into a committed, shared record of reviewer-rule fill events; only a boolean can switch it.',
        next: 'Set events.committed_llm to true or false, or remove the events key.',
      }, 'config-invalid');
    }
    events = { committed_llm: ev.committed_llm as boolean | undefined };
  }

  // progressive — the reference a progressive run measures its change against.
  // Absent ⇒ undefined (progressive mode off; every run gates the whole graph,
  // exactly as it always has). Tolerated when absent (like auto_approve /
  // signals / events), but STRICT when present: `progressive` must be a
  // mapping, an UNKNOWN sibling is rejected, and `reference` must be THERE and
  // a non-blank string. A misspelled sibling, a blank value, or a block that
  // names nothing at all would otherwise leave a repo believing it had turned
  // progressive mode on while every run silently kept its previous behavior —
  // the failure this section is strict to prevent.
  //
  // The empty mapping (`progressive: {}`, or a `progressive:` key with nothing
  // under it) is the one shape that used to slip through every guard here: it is
  // a mapping, it carries no unknown sibling, and it has no blank reference to
  // reject — so it parsed cleanly and yielded no reference, which is precisely
  // the silent no-op the two rules on either side of it exist to make
  // impossible. It is refused for the same reason and with the same kind of
  // message, so the promise this block makes ("a config that says the mode is on
  // cannot behave as if it were off") holds for every way of writing it.
  //
  // Read from `baseRaw`, NOT from the merged `raw`: this key is committed-only,
  // exactly like coverage.type_level above. The reference decides how much of
  // the graph a run answers for, so a gitignored yg-secrets.yaml must never be
  // able to introduce it or re-point it. The overlay's own copy is therefore
  // not validated either — refusing a config over a key that is guaranteed to
  // have no effect would misreport what is actually in force.
  let progressive: { reference: string } | undefined;
  const committedProgressive = baseRaw.progressive;
  if (committedProgressive !== undefined) {
    if (
      typeof committedProgressive !== 'object' ||
      Array.isArray(committedProgressive) ||
      committedProgressive === null
    ) {
      throw new ConfigParseError({
        what: `${filename}: progressive must be a mapping (got ${JSON.stringify(committedProgressive)}).`,
        why: 'progressive holds the settings a scoped run is measured against (currently `reference`); a non-mapping value cannot carry them.',
        next: 'Set progressive to a mapping, e.g. `progressive: { reference: origin/main }`, or remove the progressive key.',
      }, 'config-invalid');
    }
    const prog = committedProgressive as Record<string, unknown>;
    const allowedProgressiveKeys = new Set(['reference']);
    for (const k of Object.keys(prog)) {
      if (!allowedProgressiveKeys.has(k)) {
        throw new ConfigParseError({
          what: `${filename}: unknown key '${k}' under progressive:`,
          why: 'the progressive section accepts only `reference`; a misspelled key would silently leave the run measuring against nothing, so it would keep behaving exactly as before while the config appears to say otherwise.',
          next: 'Remove the key, or set progressive.reference to the branch to measure against (e.g. origin/main).',
        }, 'config-progressive-unknown-key');
      }
    }
    if (prog.reference === undefined) {
      throw new ConfigParseError({
        what: `${filename}: progressive is present but names no reference.`,
        why: 'reference is what the progressive block is for — it names the committed branch or ref a change is measured against (e.g. origin/main). A block that names none turns nothing on: every run would keep answering for the whole project while the config read as though changes were being measured.',
        next: 'Set progressive.reference to a ref that exists locally, e.g. `progressive: { reference: origin/main }`, or remove the progressive key.',
      }, 'config-invalid');
    }
    if (typeof prog.reference !== 'string' || prog.reference.trim() === '') {
      throw new ConfigParseError({
        what: `${filename}: progressive.reference must be a non-empty string (got ${JSON.stringify(prog.reference)}).`,
        why: 'reference names the committed branch or ref a change is measured against (e.g. origin/main); a blank or non-string value names nothing, so nothing could ever be measured.',
        next: 'Set progressive.reference to a ref that exists locally, e.g. `reference: origin/main`, or remove the progressive key.',
      }, 'config-invalid');
    }
    progressive = { reference: prog.reference.trim() };
  }

  // A fresh object, never a mutation of whatever parseCoverage returned: when
  // coverage: is absent, parseCoverage returns the shared DEFAULT_COVERAGE
  // export BY REFERENCE (core/check.ts and cli/init.ts also fall back to that
  // same export), so writing onto it here would corrupt a module-level
  // singleton every other caller relies on. Spreading into a new object forces
  // the committed value back without touching whatever was returned.
  const coverage = { ...parseCoverage(raw.coverage, filename), typeLevel: committedTypeLevel === true };

  // Read from `baseRaw`, NOT from the merged `raw`, for the same reason
  // progressive and coverage.type_level are: which agent-rules artifacts the
  // repository carries is a committed, team-wide decision. A gitignored
  // yg-secrets.yaml that could switch one off would stop `yg init` from writing
  // a file on one machine and keep writing it on every other, and would silence
  // a drift warning for exactly one developer.
  const rulesArtifacts = parseRulesArtifacts(baseRaw.rules_artifacts, filename);

  // Read from `baseRaw` too: what matters here is what the committed file says,
  // whatever a local overlay adds on top (see YggConfig.committedReviewer).
  const committedReviewer = readCommittedReviewer(baseRaw.reviewer);

  return {
    version,
    quality,
    reviewer,
    parallel,
    debug,
    auto_approve,
    signals,
    events,
    coverage,
    progressive,
    rulesArtifacts,
    ...(committedReviewer && { committedReviewer }),
  };
}

/**
 * The api_key and endpoint facts of the committed reviewer block, taken
 * leniently: the tier parser above has already refused a malformed block, so
 * anything that is not a string is simply not reported here. Undefined when the
 * committed file names neither.
 */
function readCommittedReviewer(rawReviewer: unknown): YggConfig['committedReviewer'] {
  const tiers = (rawReviewer as { tiers?: unknown } | undefined)?.tiers;
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return undefined;
  const apiKeyTiers: string[] = [];
  const endpoints: Record<string, string> = {};
  for (const [name, tier] of Object.entries(tiers as Record<string, unknown>)) {
    const cfg = (tier as { config?: unknown } | null)?.config;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const c = cfg as Record<string, unknown>;
    if (c.api_key !== undefined && c.api_key !== null && c.api_key !== '') apiKeyTiers.push(name);
    if (typeof c.endpoint === 'string' && c.endpoint.trim() !== '') endpoints[name] = c.endpoint.trim();
  }
  if (apiKeyTiers.length === 0 && Object.keys(endpoints).length === 0) return undefined;
  return { apiKeyTiers: apiKeyTiers.sort(), endpoints };
}

/**
 * The `rules_artifacts` block ALONE, read straight off the committed
 * `.yggdrasil/yg-config.yaml`.
 *
 * `yg init` needs this one answer before it installs anything, in situations
 * where the full config is not loadable and must not be required to be: a
 * project mid-migration, one whose reviewer section is incomplete, or one being
 * upgraded from a schema this CLI has not migrated yet. Running the whole of
 * parseConfig there would make an unrelated configuration problem abort the
 * command whose job is to repair the project.
 *
 * So the file-level failures degrade to the defaults (all three artifacts on —
 * today's behavior): an absent file, an unreadable one, a YAML document that is
 * not a mapping. A `rules_artifacts` block that IS present and malformed still
 * throws, because that is the one case where defaulting would write files the
 * user explicitly asked not to have.
 */
export async function readRulesArtifactsConfig(yggRoot: string): Promise<RulesArtifactsConfig> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const content = await readFileOrDefault(configPath, null, '[config-parser] readRulesArtifactsConfig');
  if (content === null) return DEFAULT_RULES_ARTIFACTS;
  let raw: unknown;
  try {
    raw = parseYaml(content) as unknown;
  } catch (err) {
    debugWrite(`[config-parser] readRulesArtifactsConfig: ${configPath} is not valid YAML (${(err as Error).message}) -> defaults`);
    return DEFAULT_RULES_ARTIFACTS;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_RULES_ARTIFACTS;
  return parseRulesArtifacts((raw as Record<string, unknown>).rules_artifacts, path.basename(configPath));
}

function parseReviewer(raw: Record<string, unknown>, filename: string): ReviewerConfig {
  const allowedTopKeys = new Set(['default', 'tiers']);
  for (const k of Object.keys(raw)) {
    if (!allowedTopKeys.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: unknown key '${k}' under reviewer:`,
        why: 'the reviewer section accepts only `default` and `tiers`',
        next: "move provider-specific settings into a tier's config: section",
      }, 'config-reviewer-unknown-key');
    }
  }

  const tiersRaw = raw.tiers;
  if (!tiersRaw || typeof tiersRaw !== 'object' || Array.isArray(tiersRaw)) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.tiers is missing or not a mapping`,
      why: 'tiers are the only way to declare reviewer configurations',
      next: 'add `reviewer.tiers: { default-tier: { provider: ..., consensus: 1, config: { model: ... } } }`',
    }, 'config-tiers-missing');
  }

  const tiers: Record<string, LlmConfig> = {};
  const tierNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
  for (const [tierName, tierRawAny] of Object.entries(tiersRaw as Record<string, unknown>)) {
    if (tierName === 'default') {
      throw new ConfigParseError({
        what: `${filename}: tier name 'default' is reserved`,
        why: 'a tier named "default" is visually identical to reviewer.default pointing to itself',
        next: 'rename the tier (referenced by aspects via reviewer.tier:)',
      }, 'config-tier-name-reserved');
    }
    if (!tierNameRegex.test(tierName)) {
      throw new ConfigParseError({
        what: `${filename}: tier name '${tierName}' is invalid`,
        why: 'tier names must start with a letter and contain only letters, digits, underscore, or hyphen (max 63 chars)',
        next: `rename the tier (regex: ${tierNameRegex.source})`,
      }, 'config-tier-name-invalid');
    }
    tiers[tierName] = parseTier(tierName, tierRawAny, filename);
  }

  if (Object.keys(tiers).length === 0) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.tiers is empty`,
      why: 'at least one tier must be defined',
      next: 'add at least one tier entry',
    }, 'config-tiers-empty');
  }

  let defaultName: string | undefined;
  if ('default' in raw) {
    if (typeof raw.default !== 'string') {
      throw new ConfigParseError({
        what: `${filename}: reviewer.default must be a string`,
        why: 'default references a tier by name',
        next: `set reviewer.default to one of: ${Object.keys(tiers).join(', ')}`,
      }, 'config-default-tier-unknown');
    }
    if (!tiers[raw.default]) {
      throw new ConfigParseError({
        what: `${filename}: reviewer.default is '${raw.default}' but no tier '${raw.default}' is configured`,
        why: 'reference must match a tier name',
        next: `use one of: ${Object.keys(tiers).join(', ')}`,
      }, 'config-default-tier-unknown');
    }
    defaultName = raw.default;
  } else if (Object.keys(tiers).length > 1) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.default is required when multiple tiers are configured`,
      why: 'with multiple tiers, the default must be chosen explicitly',
      next: `set reviewer.default to one of: ${Object.keys(tiers).join(', ')}`,
    }, 'config-default-tier-missing');
  }

  return { default: defaultName, tiers };
}

/**
 * Refuse a `quality:` key the configuration does not accept, naming the file it
 * sits in. Called on the committed file and on the local overlay SEPARATELY,
 * before they are merged, so a key in the gitignored yg-secrets.yaml is reported
 * where it is — the same rule the top-level unknown-key check follows.
 */
function refuseUnknownQualityKeys(qualityMap: Record<string, unknown>, filename: string): void {
  const unknownQuality = findUnknownKeys(qualityMap, QUALITY_KEYS, RETIRED_QUALITY_KEYS);
  if (unknownQuality.length > 0) {
    throw new ConfigParseError({
      what: `${filename}: ${describeUnknownKeys('quality', unknownQuality, QUALITY_KEYS)}`,
      why: 'quality holds the named thresholds the check measures against; a misspelled one leaves its threshold at the default while the file appears to set it.',
      next: unknownQuality[0].retired !== undefined
        ? `Delete quality.${unknownQuality[0].key} from ${filename}.`
        : unknownQuality[0].suggestion !== undefined
        ? `Rename quality.${unknownQuality[0].key} to quality.${unknownQuality[0].suggestion}, or remove it.`
        : `Remove quality.${unknownQuality[0].key}, or rename it to one of: ${QUALITY_KEYS.join(', ')}.`,
    }, 'config-quality-unknown-key');
  }
}

/** Refuse a key a tier's `config:` does not accept, naming the file it sits in (see refuseUnknownQualityKeys). */
function refuseUnknownTierConfigKeys(c: Record<string, unknown>, name: string, filename: string): void {
  const unknownConfigKeys = findUnknownKeys(c, TIER_CONFIG_KEYS, RETIRED_TIER_CONFIG_KEYS);
  if (unknownConfigKeys.length > 0) {
    throw new ConfigParseError({
      what: `${filename}: ${describeUnknownKeys(`tier '${name}' config`, unknownConfigKeys, TIER_CONFIG_KEYS)}`,
      why: "a tier's config: holds the provider settings every reviewer call of that tier is made with; a misspelled one leaves its setting at the provider's default while the file appears to set it.",
      next: unknownConfigKeys[0].retired !== undefined
        ? `Delete '${unknownConfigKeys[0].key}' from reviewer.tiers.${name}.config.`
        : unknownConfigKeys[0].suggestion !== undefined
        ? `Rename '${unknownConfigKeys[0].key}' to '${unknownConfigKeys[0].suggestion}' under reviewer.tiers.${name}.config, or remove it.`
        : `Remove '${unknownConfigKeys[0].key}' from reviewer.tiers.${name}.config.`,
    }, 'config-tier-unknown-key');
  }
}

/**
 * Check one file's `quality:` and tier `config:` blocks for unknown keys before
 * the overlay is merged, so each finding names the file that carries it.
 * Shape problems are left to the full parse after the merge.
 */
function refuseUnknownNestedKeys(raw: Record<string, unknown>, filename: string): void {
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isMapping(raw.quality)) refuseUnknownQualityKeys(raw.quality, filename);
  const reviewer = raw.reviewer;
  if (!isMapping(reviewer) || !isMapping(reviewer.tiers)) return;
  for (const [tierName, tier] of Object.entries(reviewer.tiers)) {
    if (isMapping(tier) && isMapping(tier.config)) refuseUnknownTierConfigKeys(tier.config, tierName, filename);
  }
}

/**
 * The first setting of a tier's `config:` whose value has the wrong type, or null.
 * An empty value (`timeout:` with nothing after it) reads as absent, as before.
 * `model` has its own check below (it may also come from a provider default).
 */
function tierConfigTypeError(c: Record<string, unknown>): { key: string; problem: string; fix: string } | null {
  if (c.temperature !== undefined && c.temperature !== null && (typeof c.temperature !== 'number' || !Number.isFinite(c.temperature) || c.temperature < 0)) {
    return { key: 'temperature', problem: 'must be a number >= 0', fix: 'to a number such as 0' };
  }
  if (c.timeout !== undefined && c.timeout !== null && (typeof c.timeout !== 'number' || !Number.isFinite(c.timeout) || c.timeout <= 0)) {
    return { key: 'timeout', problem: 'must be a positive number of seconds', fix: 'to a number of seconds such as 300' };
  }
  if (c.endpoint !== undefined && c.endpoint !== null && typeof c.endpoint !== 'string') {
    return { key: 'endpoint', problem: 'must be a URL string', fix: 'to a URL string' };
  }
  if (c.api_key !== undefined && c.api_key !== null && typeof c.api_key !== 'string') {
    return { key: 'api_key', problem: 'must be a string', fix: 'to the key as a string (in yg-secrets.yaml, never the committed file)' };
  }
  return null;
}

function parseTier(name: string, raw: unknown, filename: string): LlmConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is not a mapping`,
      why: 'each tier is a mapping with provider, consensus, config',
      next: 'replace with `{ provider: ..., consensus: 1, config: { model: ... } }`',
    }, 'config-tier-invalid');
  }
  const t = raw as Record<string, unknown>;

  if (!t.provider) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing provider:`,
      why: 'each tier must declare which provider implements it',
      next: `add 'provider: <one-of-known>' (see KNOWN_PROVIDERS)`,
    }, 'config-tier-provider-missing');
  }
  if (typeof t.provider !== 'string' || !(KNOWN_PROVIDERS as readonly string[]).includes(t.provider)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' declares unknown provider '${String(t.provider)}'`,
      why: 'provider must be one the CLI knows how to invoke',
      next: `use one of: ${KNOWN_PROVIDERS.join(', ')}`,
    }, 'config-tier-provider-unknown');
  }

  if (!('consensus' in t)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing consensus:`,
      why: 'consensus is the number of independent reviewer votes per aspect; each tier declares its own',
      next: 'add `consensus: 1` (single call) or an odd number >= 3 for majority vote',
    }, 'config-tier-consensus-invalid');
  }
  const consensusRaw = t.consensus;
  if (!Number.isInteger(consensusRaw) || (consensusRaw as number) < 1 || (consensusRaw as number) % 2 === 0) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' has invalid consensus '${consensusRaw}'`,
      why: 'consensus must be a positive odd integer; even values cannot break ties; < 1 is nonsensical',
      next: 'use 1 (single call) or an odd number >= 3 for majority vote',
    }, 'config-tier-consensus-invalid');
  }

  if (!('config' in t)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing config:`,
      why: 'provider-specific settings live in config:',
      next: 'add `config: { model: <model-name> }`',
    }, 'config-tier-config-missing');
  }
  const cfg = t.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' has config: that is not a YAML mapping`,
      why: 'provider settings are key-value pairs',
      next: 'replace with `config: { model: <name>, ... }`',
    }, 'config-tier-config-not-mapping');
  }
  const c = cfg as Record<string, unknown>;
  refuseUnknownTierConfigKeys(c, name, filename);
  const configTypeError = tierConfigTypeError(c);
  if (configTypeError !== null) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' config.${configTypeError.key} ${configTypeError.problem} (got ${JSON.stringify(c[configTypeError.key])}).`,
      why: `A value of the wrong type is not read at all — config.${configTypeError.key} would silently fall back to its default.`,
      next: `Set reviewer.tiers.${name}.config.${configTypeError.key} ${configTypeError.fix}, or remove it.`,
    }, 'config-tier-config-invalid');
  }
  const defaults = PROVIDER_DEFAULTS[t.provider as string] ?? {};
  const model = (c.model as string | undefined) ?? (defaults.model as string | undefined);
  if (!model || typeof model !== 'string') {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' config.model is missing or not a string`,
      why: t.provider === 'copilot-cli'
        ? "copilot-cli has no default model: the organisation's Copilot policy decides which models a seat may use, and the CLI refuses any other"
        : 'every tier requires a model id',
      next: t.provider === 'copilot-cli'
        ? 'add `model: <model-name>` under config:, one your Copilot plan allows — e.g. `model: auto`, which lets Copilot pick'
        : 'add `model: <model-name>` under config:',
    }, 'config-tier-config-missing');
  }

  // `openai-compatible` has NO safe default host — OpenAIProvider falls back to
  // the PUBLIC OpenAI API (https://api.openai.com/v1) when no endpoint is given,
  // silently routing a "compatible" tier to OpenAI. Require an explicit endpoint.
  // (`ollama` is exempt: it safely defaults to http://localhost:11434.)
  if (t.provider === 'openai-compatible' && (typeof c.endpoint !== 'string' || !c.endpoint.trim())) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' (provider 'openai-compatible') is missing config.endpoint`,
      why: `'openai-compatible' has no default host — without an explicit endpoint it silently falls back to the public OpenAI API (api.openai.com).`,
      next: 'add `endpoint: <url>` under config: pointing at your compatible server.',
    }, 'config-tier-endpoint-missing');
  }

  // Unknown-key check AFTER structural checks
  const allowed = new Set(['provider', 'consensus', 'config', 'max_prompt_chars']);
  for (const k of Object.keys(t)) {
    if (!allowed.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: tier '${name}' has unknown key '${k}'`,
        why: 'tier accepts only `provider`, `consensus`, `config`, `max_prompt_chars`',
        next: "move to config: if it's a provider setting, or remove",
      }, 'config-tier-unknown-key');
    }
  }

  // max_prompt_chars: optional per-tier assembled-prompt character cap
  let max_prompt_chars: number | undefined;
  if (t.max_prompt_chars !== undefined) {
    const v = t.max_prompt_chars;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new ConfigParseError({
        what: `${filename}: tier '${name}' has invalid max_prompt_chars: ${JSON.stringify(v)}`,
        why: 'max_prompt_chars is the assembled reviewer-prompt character cap; a zero, negative, or fractional value makes the gate nonsensical',
        next: `set 'max_prompt_chars' to a positive integer like 100000 (omitted defaults to 50000).`,
      }, 'config-tier-prompt-chars-invalid');
    }
    max_prompt_chars = v;
  }

  return {
    provider: t.provider as LlmConfig['provider'],
    model,
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : undefined,
    temperature: typeof c.temperature === 'number' ? c.temperature : 0,
    consensus: consensusRaw as number,
    timeout: typeof c.timeout === 'number' ? c.timeout * 1000 : undefined,
    // api_key is read from the tier's config: block (most often supplied via the
    // gitignored yg-secrets.yaml overlay). Excluded from the verdict hash
    // (tierHashView folds only the tier NAME), so rotating it invalidates nothing.
    ...(typeof c.api_key === 'string' ? { api_key: c.api_key } : {}),
    ...(max_prompt_chars !== undefined ? { max_prompt_chars } : {}),
  };
}
