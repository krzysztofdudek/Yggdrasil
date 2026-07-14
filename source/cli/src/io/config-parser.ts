import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
  ReviewerConfig,
  CoverageConfig,
} from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { KNOWN_PROVIDERS } from '../utils/known-providers.js';
import { loadConfigOverlay, deepMerge } from './secrets-parser.js';

export { KNOWN_PROVIDERS };

export class ConfigParseError extends Error {
  constructor(public messageData: IssueMessage, public code: string) {
    super(messageData.what);
  }
}

const DEFAULT_QUALITY: QualityConfig = {
  max_direct_relations: 10,
};

export const DEFAULT_COVERAGE: CoverageConfig = { required: ['/'], excluded: [] };

function parseStringArray(raw: unknown, field: string, filename: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new ConfigParseError({
      what: `${filename}: ${field} must be a list of strings (got ${JSON.stringify(raw)}).`,
      why: 'Coverage roots are repo-relative path prefixes; a non-list value cannot be matched against files.',
      next: `Set ${field} to a YAML list, e.g.\n  ${field.split('.').pop()}:\n    - services/`,
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
  const required = cov.required === undefined ? ['/'] : parseStringArray(cov.required, 'coverage.required', filename);
  const excluded = parseStringArray(cov.excluded, 'coverage.excluded', filename);

  // An explicit empty `required: []` is permitted and means "require nothing":
  // every uncovered file (outside excluded/nested) surfaces as a non-blocking
  // uncovered-advisory warning, so nothing blocks. This is intentional
  // pure-advisory adoption — visible (you still see every uncovered file as a
  // warning), not silent. (The ABSENT-block default remains ['/'] above, which
  // requires the whole repo; only an explicit [] opts into require-nothing.)

  // Coverage roots are repo-relative prefixes; ".." never matches a git-tracked
  // path and silently mis-scopes coverage enforcement.
  for (const root of [...required, ...excluded]) {
    if (root.split('/').includes('..')) {
      throw new ConfigParseError({
        what: `${filename}: coverage root '${root}' contains a '..' segment.`,
        why: "'..' is not a valid repo-relative prefix and will never match any git-tracked path, silently mis-scoping coverage enforcement.",
        next: 'Use a repo-relative path prefix without any ".." segments (e.g. - services/ instead of - services/../other/).',
      }, 'config-invalid');
    }
  }

  return { required, excluded };
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

export async function parseConfig(
  filePath: string,
  opts?: { skipSecretsOverlay?: boolean },
): Promise<YggConfig> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const baseRaw = parseYaml(content) as Record<string, unknown>;

  if (!baseRaw || typeof baseRaw !== 'object') {
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
  const raw = overlay ? deepMerge(baseRaw, overlay) : baseRaw;

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  const qualityRaw = raw.quality;
  if (qualityRaw !== undefined && (typeof qualityRaw !== 'object' || Array.isArray(qualityRaw))) {
    throw new ConfigParseError({
      what: `${filename}: quality must be a mapping`,
      why: 'quality holds named thresholds (max_direct_relations)',
      next: 'replace with `quality: { max_direct_relations: 10 }`',
    }, 'config-invalid');
  }
  const qualityMap = qualityRaw as Record<string, unknown> | undefined;
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
          why: 'the events section accepts only `committed_llm`; a misspelled key would silently leave the committed LLM-fill event stream disabled.',
          next: 'Remove the key, or set events.committed_llm to true or false.',
        }, 'config-events-unknown-key');
      }
    }
    if (ev.committed_llm !== undefined && typeof ev.committed_llm !== 'boolean') {
      throw new ConfigParseError({
        what: `${filename}: events.committed_llm must be a boolean (got ${JSON.stringify(ev.committed_llm)}).`,
        why: 'events.committed_llm opts the repo into a committed, shared record of LLM verification-fill events; only a boolean can switch it.',
        next: 'Set events.committed_llm to true or false, or remove the events key.',
      }, 'config-invalid');
    }
    events = { committed_llm: ev.committed_llm as boolean | undefined };
  }

  return {
    version,
    quality,
    reviewer,
    parallel,
    debug,
    auto_approve,
    signals,
    events,
    coverage: parseCoverage(raw.coverage, filename),
  };
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
  const defaults = PROVIDER_DEFAULTS[t.provider as string] ?? {};
  const model = (c.model as string | undefined) ?? (defaults.model as string | undefined);
  if (!model || typeof model !== 'string') {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' config.model is missing or not a string`,
      why: 'every tier requires a model id',
      next: 'add `model: <model-name>` under config:',
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
