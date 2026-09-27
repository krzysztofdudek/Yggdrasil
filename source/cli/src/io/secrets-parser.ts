// Parser-adapter — reads the user's `yg-secrets.yaml` and applies it as a
// deep-merge OVERLAY over yg-config.yaml. Lives in `io/` because it touches the
// filesystem. yg-secrets mirrors the yg-config shape: any field may be
// overridden locally (most often a tier's provider/model/endpoint/api_key)
// without touching the committed config. Gitignored — never committed.
//
// Because the verdict hash folds only the tier NAME, overriding a tier's
// provider or config never invalidates recorded baselines: each developer points
// the same named tier at their own reviewer. (An overlay that changes
// reviewer.default, the tier names or coverage does move pairs.)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debugWrite } from '../utils/debug-log.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge plain objects: `overlay` wins. Nested mappings recurse; scalars,
 * arrays, and mismatched types are replaced wholesale by the overlay value.
 * Pure — does not mutate either argument.
 */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, ov] of Object.entries(overlay)) {
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

/**
 * Load yg-secrets.yaml from .yggdrasil/ as a config overlay mapping (to be
 * deep-merged over the parsed yg-config raw object).
 *
 * Silent (returns undefined) when the file is absent or empty — yg-secrets is an
 * optional local file. Throws when present but not a YAML mapping.
 */
export async function loadConfigOverlay(yggRoot: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(join(yggRoot, 'yg-secrets.yaml'), 'utf-8');
  } catch (err) {
    debugWrite(`[secrets-parser] readFile: ${(err as Error).message}`);
    return undefined; // absent → no overlay
  }
  const raw = parseYaml(content) as unknown;
  if (raw === null || raw === undefined) return undefined;
  // Explicit Array.isArray(raw) guard: typeof [] === 'object', so a YAML array
  // document would otherwise slip past an object check and fail later at the
  // first property access.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'yg-secrets.yaml: top level must be a YAML mapping (it is a deep-merge overlay over yg-config.yaml)',
    );
  }
  return raw as Record<string, unknown>;
}
