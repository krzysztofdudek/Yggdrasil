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
import { hashString, SHA256_OBSERVATION_HASHES } from '../io/hash.js';
import { codePointCanonicalJson, observationKey, MISSING_OBSERVATION } from '../utils/observation-keys.js';

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
  /**
   * The canonical-form contract to hash under: the current one when absent,
   * none at all (the form before the marker existed) when null. Only the
   * verifier passes it, to tell a verdict an earlier release recorded from one
   * whose inputs moved — never to record one.
   */
  contract?: number | null;
}

// ============================================================
// codePointCanonicalJson — the single serialization primitive
// ============================================================

// Defined in utils/observation-keys.ts (the pure half of this contract, shared
// with the structure runtime that records observations) and re-exported here so
// the verdict hash and every caller keep one serialization.
export { codePointCanonicalJson };

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
 *
 * `contract: 2` marks deterministic verdicts recorded since checks began
 * observing the grammar of every syntax tree they read (the `grammar:`
 * observation). A verdict recorded before could have read a tree from a grammar
 * that no longer ships and carries no observation that would notice, so the
 * marker re-opens every older deterministic verdict once. That costs one free,
 * keyless `yg check --approve --only-deterministic` (the deterministic lock is a
 * local cache); LLM hashes are untouched.
 */
const DET_HASH_CONTRACT = 2;

export function computeDetInputHash(input: DetHashInput): string {
  const common = buildCommonCanonical(input);

  // Sort touched by observation key (code-point order); POSIX paths in keys are
  // already encoded by observationKey() which normalizes them at recording time.
  const touched = [...input.touched]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, h]) => [k, h]);

  const contract = input.contract === undefined ? DET_HASH_CONTRACT : input.contract;
  const canonical: Record<string, unknown> = {
    ...common,
    ...(contract !== null ? { contract } : {}),
    kind: 'deterministic',
    touched,
  };

  return hashString(codePointCanonicalJson(canonical));
}

// ============================================================
// Observation helpers
// ============================================================

// The observation keys and the canonical text each value hashes are built by
// utils/observation-keys.ts, a pure module the structure runtime (which records
// observations) and this engine (which re-observes them) both call; the digest is
// io/hash.ts's sha256, injected there once as SHA256_OBSERVATION_HASHES. These
// exports keep the engine's names for them. The kinds, keys and value contracts
// are documented on ObservationKind and ObservationHashes.
export { observationKey, MISSING_OBSERVATION };

/** A node-id-SET observation (ctx.graph.children / nodesByType / a flow's participants). */
export function hashNodeSetObservation(nodeIds: string[]): string {
  return SHA256_OBSERVATION_HASHES.nodeSet(nodeIds);
}

/** A file-list observation (`node-files:` / `graph-files:`). Golden-pinned in pair-hash.test.ts. */
export function hashFileSetObservation(paths: string[]): string {
  return SHA256_OBSERVATION_HASHES.fileSet(paths);
}

/** A configuration-value observation: canonical JSON, MISSING_OBSERVATION for an undeclared key. */
export function hashConfigObservation(value: unknown): string {
  return SHA256_OBSERVATION_HASHES.config(value);
}

/** A file-read observation: sha256 of the raw bytes the check read. */
export function hashReadObservation(bytes: Buffer): string {
  return SHA256_OBSERVATION_HASHES.read(bytes);
}

/** A directory-listing observation. Golden-pinned in pair-hash-golden.json. */
export function hashListObservation(entries: Array<{ name: string; kind: 'file' | 'dir' }>): string {
  return SHA256_OBSERVATION_HASHES.list(entries);
}

/** An existence-probe observation ('file', 'dir' and false fold distinct values). */
export function hashExistsObservation(result: 'file' | 'dir' | false): string {
  return SHA256_OBSERVATION_HASHES.exists(result);
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
