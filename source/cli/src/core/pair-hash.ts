/**
 * source/cli/src/core/pair-hash.ts — FROZEN CONTRACT (spec §3.1).
 *
 * Computes the content-addressed inputHash stored in the verdict lock for every
 * (aspect, unit) pair — LLM and deterministic alike.
 *
 * BREAKING: changing serialization format, key names, or included ingredients is
 * a deliberate breaking decision that invalidates every stored verdict. Golden
 * tests in pair-hash.test.ts pin the canonical output.
 *
 * Design choices (each exclusion documented with rationale):
 *   - status         — rendering only; advisory ↔ enforced flips must NOT invalidate verdicts
 *   - reason         — free text; only the discrete verdict token ('approved'/'refused') folds
 *   - node description — prompt garnish, not a judgment input (matches prior system for node descriptors)
 *   - CLI version    — upgrading Yggdrasil must not cascade re-verification across every node
 *   - timeout        — transport knob; historically made timeout tuning cascade across every node
 *   - when/implies/ports — applicability recomputed live; acts through expected-pair set, not hashing
 */

import type { ScopeDef } from '../model/graph.js';
import type { Verdict } from '../model/lock.js';
import { hashString, hashBytes } from '../io/hash.js';

// ============================================================
// Public input types
// ============================================================

export interface CommonHashInput {
  aspectId: string;
  scope: ScopeDef | undefined;          // normalized internally: undefined → {per:'node'}
  /**
   * The owning component — pins per-file units to their review context. Omitted
   * entirely for a file enforced by its architecture type alone: there is no
   * component, and a placeholder would be a fabricated identity that a real
   * component could later be given (and would then collide with). Omission
   * relies on codePointCanonicalJson's existing undefined-value drop — no other
   * logic in this module changes for the omitted case.
   */
  nodePath?: string;
  ruleHash: string;                     // sha256 of content.md or check.mjs bytes
  files: Array<[string, string]>;       // subject [posixPath, sha256(bytes)] — sorted internally
  verdict: Verdict;
}

export interface LlmHashInput extends CommonHashInput {
  aspectDescription: string;
  references: Array<[string, string, string]>; // [path, sha256(bytes), description] — sorted internally by path
  tier: { name: string };   // ONLY the tier name folds in — the resolved config (provider/model/endpoint/temperature/consensus) is not a verdict input
  /** sha256 of companion.mjs bytes — folded ONLY when present (aspect ships a hook). */
  companionHash?: string;
  /** companion hook out-of-subject observations — folded ONLY when length > 0. */
  touched?: Array<[string, string]>;
}

export interface DetHashInput extends CommonHashInput {
  touched: Array<[string, string]>;     // [observationKey, observationHash] — sorted internally by key
}

// ============================================================
// codePointCanonicalJson — the single serialization primitive
// ============================================================

/**
 * Serialize any JSON-representable value to a canonical JSON string where
 * object keys are sorted in Unicode code-point order (never localeCompare —
 * localeCompare is environment-sensitive and therefore banned from any path
 * that contributes to a stored hash).
 *
 * Rules:
 *   - null and primitives: standard JSON.stringify
 *   - arrays: elements in their existing order (callers sort before passing)
 *   - objects: keys sorted by code-point, undefined values omitted
 *
 * Notes for callers:
 *   (a) Key ordering is UTF-16 code-unit order (standard JS string comparison).
 *       Astral-plane keys (code points > U+FFFF) are out of scope — all real
 *       keys in this codebase are ASCII.
 *   (b) Callers must pass finite numbers only — NaN and Infinity stringify to
 *       null in JSON.stringify and will silently produce the wrong hash.
 *   (c) undefined values are dropped from objects; array elements must never
 *       be undefined (JSON.stringify converts them to null, breaking the hash).
 */
export function codePointCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(codePointCanonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  // Code-point sort: String.prototype.localeCompare is NEVER used here.
  // The standard < / > comparator on strings is code-point order for BMP chars.
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${codePointCanonicalJson(v)}`).join(',')}}`;
}

// ============================================================
// POSIX path normalization
// ============================================================

/** Replace every backslash with forward-slash. Called on every path before hashing. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// ============================================================
// Scope normalization
// ============================================================

/**
 * Normalize scope: absent (undefined) is canonically identical to {per:'node'}
 * with no files filter. The scope predicate structure folds in its parsed form
 * via codePointCanonicalJson so a scope edit cascades to the hash.
 */
function normalizeScope(scope: ScopeDef | undefined): { per: string; files?: unknown } {
  if (scope === undefined) return { per: 'node' };
  if (scope.files === undefined) return { per: scope.per };
  return { per: scope.per, files: scope.files };
}

// ============================================================
// Common canonical object builder
// ============================================================

function buildCommonCanonical(input: CommonHashInput): Record<string, unknown> {
  // Sort files by path (code-point order); POSIX-normalize all paths.
  const files = [...input.files]
    .map(([p, h]) => [toPosix(p), h] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    aspect: input.aspectId,
    files,
    node: input.nodePath,
    rule: input.ruleHash,
    scope: normalizeScope(input.scope),
    verdict: input.verdict,
  };
}

// ============================================================
// computeLlmInputHash
// ============================================================

/**
 * Compute the inputHash for an LLM (aspect, unit) pair.
 *
 * Ingredients (spec §3.1):
 *   common: aspect, scope, node, rule, files, verdict
 *   LLM-only: aspectDescription, references, tier (config excludes api_key + timeout)
 *   optional, only-when-present (INDEPENDENT predicates — a plain LLM aspect passes
 *   neither, so `canonical` is byte-identical to the pre-companion contract):
 *     companionHash — sha256 of companion.mjs bytes; folded ONLY when !== undefined
 *     touched       — companion hook observations; folded ONLY when length > 0
 *
 * DELIBERATE divergence from computeDetInputHash, which ALWAYS emits touched:[].
 * The two guards are INDEPENDENT: folding one does not require the other.
 *
 * Hash = sha256(codePointCanonicalJson(canonical_object)) where canonical_object
 * includes a 'kind: "llm"' discriminator so LLM and deterministic pairs can never
 * collide even if all other fields match.
 */
export function computeLlmInputHash(input: LlmHashInput): string {
  const common = buildCommonCanonical(input);

  // Sort references by path; POSIX-normalize paths.
  const references = [...input.references]
    .map(([p, h, d]) => [toPosix(p), h, d] as [string, string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonical: Record<string, unknown> = {
    ...common,
    aspectDescription: input.aspectDescription,
    kind: 'llm',
    references,
    tier: {
      name: input.tier.name,
    },
  };

  // Companion ingredients — INDEPENDENT only-when-present guards. A plain LLM
  // aspect passes neither, so `canonical` is byte-identical to the pre-companion
  // contract (golden-pinned): no mass re-verification, no lock-format bump.
  // DELIBERATE divergence from computeDetInputHash, which ALWAYS emits touched:[].
  if (input.companionHash !== undefined) {
    canonical.companionHash = input.companionHash;
  }
  if (input.touched !== undefined && input.touched.length > 0) {
    canonical.touched = [...input.touched]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, h]) => [k, h]);
  }

  return hashString(codePointCanonicalJson(canonical));
}

// ============================================================
// computeDetInputHash
// ============================================================

/**
 * Compute the inputHash for a deterministic (aspect, unit) pair.
 *
 * Ingredients (spec §3.1):
 *   common: aspect, scope, node, rule, files, verdict
 *   deterministic-only: touched (observation set — sorted by key internally)
 *
 * Hash = sha256(codePointCanonicalJson(canonical_object)) where canonical_object
 * includes a 'kind: "deterministic"' discriminator so deterministic and LLM pairs
 * can never collide even if all other fields match.
 */
export function computeDetInputHash(input: DetHashInput): string {
  const common = buildCommonCanonical(input);

  // Sort touched by observation key (code-point order); POSIX paths in keys are
  // already encoded by observationKey() which normalizes them at recording time.
  const touched = [...input.touched]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, h]) => [k, h]);

  const canonical: Record<string, unknown> = {
    ...common,
    kind: 'deterministic',
    touched,
  };

  return hashString(codePointCanonicalJson(canonical));
}

// ============================================================
// Observation helpers
// ============================================================

/**
 * Encode an observation key for a deterministic check's ctx read boundary.
 *
 * Format: '<kind>:<target>' where target is the repo-relative POSIX path (for
 * read/list/exists), the model-relative node path (for graph and graph-children),
 * or the node type (for graph-bytype).
 *
 *   read / list / exists — file/dir content + existence probes
 *   graph                — a single node's yg-node.yaml bytes (or absent)
 *   graph-children       — the SET of child node ids of <target> (membership fold)
 *   graph-bytype         — the SET of node ids of type <target> (membership fold)
 *   graph-flow           — the SET of declared participant ids of flow <target>
 *
 * Key encoding is part of the frozen contract — changing it changes all
 * deterministic hashes that include observations.
 */
export function observationKey(
  kind: 'read' | 'list' | 'exists' | 'graph' | 'graph-children' | 'graph-bytype' | 'graph-flow',
  target: string,
): string {
  return `${kind}:${target}`;
}

/**
 * Sentinel hash for a re-observation whose target vanished (a deleted file, dir,
 * or absent graph node). It is NOT a valid 64-hex sha256, so it can never equal a
 * stored content hash — a now-missing target therefore always reads as a CHANGED
 * value (⇒ unverified) and never collides with a genuinely-empty stored
 * observation. The recorder uses it to fold a NEGATIVE graph-node probe
 * (ctx.graph.node() returning undefined) and the verifier uses it for every
 * vanished re-observation, so the two sides stay byte-identical for an
 * absent-then-still-absent target (spec §3.1: missing during re-observation =
 * changed value, never a throw). Part of the FROZEN CONTRACT.
 */
export const MISSING_OBSERVATION = 'missing';

/**
 * Hash a node-id-SET observation (ctx.graph.children / ctx.graph.nodesByType).
 *
 * The result depends only on WHICH node ids were returned, not their order or any
 * per-node content (each returned node additionally folds its own graph: read
 * observation). Sorting makes the fold deterministic, so ADDING or REMOVING a
 * node from the set changes the hash while a content-only edit to an unchanged
 * member does not (that rides the member's graph: observation instead).
 *
 * Contract: sha256 over the sorted node ids joined by newline. An empty set folds
 * to sha256('') — distinct from MISSING_OBSERVATION, so "no children" is a real,
 * stable observed value that a later first child invalidates.
 */
export function hashNodeSetObservation(nodeIds: string[]): string {
  const lines = [...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
  return hashString(lines);
}

/**
 * Hash a file-read observation: sha256 of the raw bytes the check read.
 * Used by the runner to record 'read:<path>' entries in touched[].
 */
export function hashReadObservation(bytes: Buffer): string {
  return hashBytes(bytes);
}

/**
 * Hash a directory-listing observation.
 *
 * Contract: sha256 over the sorted 'name:kind' lines (newline-joined), so
 * the order in which entries are returned by readdir does not affect the hash.
 * Both the name set AND the kind annotations fold — renaming a file or changing
 * a dir-to-file swap both invalidate the verdict.
 *
 * This value is golden-pinned in pair-hash-golden.json.
 */
export function hashListObservation(entries: Array<{ name: string; kind: 'file' | 'dir' }>): string {
  const lines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.name}:${e.kind}`)
    .join('\n');
  return hashString(lines);
}

/**
 * Hash an existence-probe observation.
 *
 * Encodes the result as a string token so the three outcomes ('file', 'dir', false)
 * produce distinct hashes — a file renamed to a directory invalidates the verdict.
 */
export function hashExistsObservation(result: 'file' | 'dir' | false): string {
  return hashString(result === false ? 'false' : result);
}

// ============================================================
// tierHashView — the tier NAME is the only judgment input
// ============================================================

/**
 * Build the tier view used in LlmHashInput.tier. ONLY the tier name folds into
 * the verdict hash — the tier's resolved configuration (provider, model,
 * endpoint, temperature, consensus, api_key, timeout, and any custom knobs) is
 * deliberately excluded.
 *
 * The tier name is the identity of the reviewer contract: swapping the model or
 * provider behind a named tier does NOT invalidate existing verdicts. Changing
 * which named tier an aspect resolves to DOES (the name differs).
 *
 * Trade-off (intentional): the lock no longer detects when the actual reviewer
 * behind a tier changes — a reviewer downgrade is invisible to invalidation.
 * Reviewer identity is pinned by the tier name alone.
 */
export function tierHashView(tierName: string): LlmHashInput['tier'] {
  return { name: tierName };
}
