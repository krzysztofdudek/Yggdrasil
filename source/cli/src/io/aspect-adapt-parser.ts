import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readFileOrDefault } from './read-or-default.js';
import type { IssueMessage } from '../model/validation.js';
import type { PackageConfigKeyDef, PackageConfigType } from '../model/packages.js';
import { ADAPT_FILENAME } from '../model/packages.js';

/**
 * source/cli/src/io/aspect-adapt-parser.ts — the consumer's adaptation of a rule
 * they did not write.
 *
 * A package's rule is copied in and never edited. Everything a consumer wants to
 * change about it is written in a `yg-aspect.adapt.yaml` sitting BESIDE the copy,
 * and this module reads that file, decides whether what it asks for is allowed,
 * and merges it over the rule's own definition before anything validates the
 * result. The rule file stays byte-identical to what the package published, which
 * is what makes an update a replacement rather than a merge conflict.
 *
 * THE ASYMMETRY, DELIBERATE: `yg-aspect.yaml` tolerates an unknown top-level key
 * and an adapt does not. They are written under different conditions. A rule's own
 * file is authored once, by the person who wrote the rule, against the schema of
 * the build they had; tolerating a key from a newer build is what lets one aspect
 * directory work across versions. An adapt is written by someone tuning a rule
 * they did not write, and a misspelled key there reads as an adaptation that was
 * applied when it was silently dropped — the failure mode is a rule that looks
 * tuned and is not. So an adapt names every key it does not recognise.
 */

/** Keys an adapt may set. */
export const ADAPTABLE_KEYS = [
  'scope',
  'reviewer',
  'review_by',
  'references',
  'status',
  'config',
  'companion',
] as const;

/**
 * Keys an adapt may NOT set, each with the reason, because a refusal that only
 * says "not adaptable" leaves the reader guessing at the principle.
 *
 * `description` is here alongside the four the specification names: it is what
 * the LLM reviewer is told the rule means, and a consumer rewriting it would be
 * changing the rule's content while keeping the package's name on it.
 */
const NON_ADAPTABLE_KEYS: Record<string, string> = {
  name: 'the name identifies the rule the package published',
  description: 'the description is what the reviewer is told the rule means — changing it changes the rule, not its fit',
  implies: 'which other rules a rule pulls in is part of what the rule is',
  errs: 'the error direction states how the rule was built to fail, which only its author knows',
  when: 'when the rule applies is the package author\'s claim about where it is valid — narrow it with scope: instead',
};

export type AdaptResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; messageData: IssueMessage };

export interface AspectAdapt {
  /** True when an adapt file exists at all (even an empty or comment-only one). */
  present: boolean;
  /** The validated adaptable keys, ready to merge. */
  keys: Record<string, unknown>;
}

const EMPTY_ADAPT: AspectAdapt = { present: false, keys: {} };

/**
 * Read and validate the adapt file beside an aspect.
 *
 * Three kinds of absence all mean the same thing and none is an error: no file at
 * all, a file holding only comments (which parses to null), and an explicit empty
 * mapping. Each yields an aspect that behaves exactly as it would with no adapt —
 * a stub full of commented-out keys is the file `yg pack add` writes, and it must
 * not change anything until someone uncomments a line.
 */
export async function parseAspectAdapt(
  aspectDir: string,
  aspectId: string,
): Promise<AdaptResult<AspectAdapt>> {
  const filePath = path.join(aspectDir, ADAPT_FILENAME);
  const text = await readFileOrDefault(filePath, null, 'aspect-adapt-parser');
  if (text === null) return { ok: true, value: EMPTY_ADAPT };

  let raw: unknown;
  try {
    raw = parseYaml(text) as unknown;
  } catch (err) {
    return {
      ok: false,
      code: 'aspect-adapt-invalid',
      messageData: {
        what: `${filePath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
        why: 'The adaptation cannot be applied until it parses, and applying the rule without it would silently give you the package\'s own settings instead of yours.',
        next: `Fix the YAML syntax in ${filePath}.`,
      },
    };
  }

  if (raw === null || raw === undefined) return { ok: true, value: { present: true, keys: {} } };

  // Array.isArray is tested explicitly: typeof [] === 'object', so without it a
  // YAML sequence would read as a mapping with no keys — an adapt that silently
  // adapts nothing.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'aspect-adapt-not-mapping',
      messageData: {
        what: `${filePath} is a ${Array.isArray(raw) ? 'list' : typeof raw}, not a mapping.`,
        why: 'An adaptation sets named keys over the rule it sits beside, so it has to be a mapping of key to value.',
        next: `Write ${filePath} as a YAML mapping, e.g.\n  status: advisory`,
      },
    };
  }

  const keys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const nonAdaptableReason = Object.prototype.hasOwnProperty.call(NON_ADAPTABLE_KEYS, key)
      ? NON_ADAPTABLE_KEYS[key]
      : undefined;
    if (nonAdaptableReason !== undefined) {
      return {
        ok: false,
        code: 'aspect-adapt-key-not-adaptable',
        messageData: {
          what: `${filePath} sets '${key}', which is not adaptable.`,
          why: `A rule from a package is adapted to your repository, not rewritten: ${nonAdaptableReason}.`,
          next: `Remove '${key}' from ${filePath}. Adaptable keys are: ${ADAPTABLE_KEYS.join(', ')}.`,
        },
      };
    }
    if (!(ADAPTABLE_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: 'aspect-adapt-key-unknown',
        messageData: {
          what: `${filePath} sets '${key}', which is not a key of an adaptation.`,
          why: `An unrecognised key would be dropped in silence, leaving rule '${aspectId}' looking adapted when it is not.`,
          next: `Remove or correct '${key}'. Adaptable keys are: ${ADAPTABLE_KEYS.join(', ')}.`,
        },
      };
    }
    keys[key] = value;
  }

  return { ok: true, value: { present: true, keys } };
}

/**
 * Merge an adapt's keys over an aspect's own raw YAML.
 *
 * SCALARS AND LISTS REPLACE. A list that merged would be impossible to shorten —
 * a consumer could add a reference but never drop one the package shipped.
 *
 * MAPS MERGE KEY BY KEY. The alternative (whole-map replacement) was rejected
 * because of what it does to `reviewer:`: the field a consumer actually wants to
 * change there is `tier`, and whole-map replacement would force them to restate
 * `type:` — which is not theirs to state, since it is fixed by which rule file the
 * package ships. The same reasoning holds for `scope` (change `per`, keep the
 * author's `files` filter) and for `config` (set one key, leave the rest at the
 * package's defaults). The merge is ONE level deep, deliberately: deeper merging
 * would make a nested predicate impossible to replace outright.
 */
export function mergeAdaptOverAspect(
  base: Record<string, unknown>,
  adapt: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(adapt)) {
    const existing = merged[key];
    const bothMaps =
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value);
    merged[key] = bothMaps
      ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
      : value;
  }
  return merged;
}

// ============================================================
// config
// ============================================================

function typeOfConfigValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  return typeof value;
}

function matchesType(value: unknown, type: PackageConfigType): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The configuration values a rule will actually see: the package's declared
 * defaults, with whatever the adapt sets on top.
 *
 * A key the schema does not declare is refused by NAME rather than ignored,
 * because an ignored key is the exact shape of a typo that leaves a threshold at
 * its default while the adapt reads as though it were set.
 */
export function resolveAspectConfig(
  schema: Record<string, PackageConfigKeyDef>,
  adaptConfig: unknown,
  context: { aspectId: string; packageName: string; adaptFilePath: string },
): AdaptResult<Record<string, string | number | boolean>> {
  const resolved: Record<string, string | number | boolean> = {};
  for (const [key, def] of Object.entries(schema)) resolved[key] = def.default;

  if (adaptConfig === undefined) return { ok: true, value: resolved };

  if (adaptConfig === null || typeof adaptConfig !== 'object' || Array.isArray(adaptConfig)) {
    return {
      ok: false,
      code: 'aspect-adapt-config-not-mapping',
      messageData: {
        what: `${context.adaptFilePath} has a 'config' that is a ${typeOfConfigValue(adaptConfig)}, not a mapping.`,
        why: 'config: sets named values the rule reads, so it has to be a mapping of key to value.',
        next: `Write config: as a mapping in ${context.adaptFilePath}.`,
      },
    };
  }

  for (const [key, value] of Object.entries(adaptConfig as Record<string, unknown>)) {
    const def = Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : undefined;
    if (def === undefined) {
      const known = Object.keys(schema).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        ok: false,
        code: 'aspect-adapt-config-key-unknown',
        messageData: {
          what: `${context.adaptFilePath} sets config key '${key}', which the package '${context.packageName}' does not declare for rule '${context.aspectId}'.`,
          why: 'The rule reads only the keys its package declares; a key it never reads would sit in your adaptation looking like a setting that does nothing.',
          next:
            known.length === 0
              ? `Remove '${key}' — this rule reads no configuration at all.`
              : `Remove '${key}', or use one of the keys this rule declares: ${known.join(', ')}.`,
        },
      };
    }
    if (!matchesType(value, def.type)) {
      return {
        ok: false,
        code: 'aspect-adapt-config-type-mismatch',
        messageData: {
          what: `${context.adaptFilePath} sets config key '${key}' to a ${typeOfConfigValue(value)}, but package '${context.packageName}' declares it as ${def.type}.`,
          why: 'The rule reads the value as the type its package declared; a value of another type would reach it as something it was never written to handle.',
          next: `Give '${key}' a ${def.type} value in ${context.adaptFilePath}.`,
        },
      };
    }
    resolved[key] = value as string | number | boolean;
  }

  return { ok: true, value: resolved };
}
