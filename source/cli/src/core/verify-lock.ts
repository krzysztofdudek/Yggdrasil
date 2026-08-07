/**
 * source/cli/src/core/verify-lock.ts — the lock-verification engine (spec §6, §3.1, §4).
 *
 * Pure, testable read-side core of `yg check`:
 *   - compute the expected (aspect, unit) pairs (non-draft) from the graph,
 *   - recompute each pair's inputHash from CURRENT inputs + the STORED verdict
 *     token, and compare to the stored entry's hash,
 *   - run the per-pair prompt-size gate for LLM pairs (§4),
 *   - classify each pair as verified / refused / unverified / prompt-too-large.
 *
 * This engine NEVER executes a reviewer and NEVER executes a deterministic
 * check.mjs. It MAY run an LLM aspect's companion.mjs (the dependency resolver,
 * never a judge) to size the §4 prompt-size gate over the REAL injected companions
 * — see the gate below. For deterministic pairs it re-OBSERVES the stored
 * observation keys (read:/list:/exists:/graph:) against current disk state — a
 * value that changed (or a file/node that vanished) yields a mismatch ⇒ unverified,
 * never a throw (spec §3.1). The fill stage (B2) is the only place check.mjs and
 * the reviewer run; this engine and the fill stage share the same input-assembly
 * helpers so a verdict the fill writes verifies here without re-running anything.
 *
 * Gate representation (the oversized-but-valid case, spec §3.1 / §4):
 *   - If a pair's stored entry is MISSING or its hash MISMATCHES and its assembled
 *     prompt exceeds the tier limit → state = { kind: 'prompt-too-large', ... }.
 *     The gate REPLACES the unverified state (no duplicate unverified, §4 gate
 *     precedence).
 *   - If a pair's stored entry is VALID (verified or refused) but its assembled
 *     prompt now exceeds the tier limit → the verdict state is PRESERVED
 *     (verified/refused) AND the pair additionally carries an `oversized` field.
 *     The check renderer surfaces ONE prompt-too-large error for the pair in
 *     BOTH cases (state.kind === 'prompt-too-large' OR oversized set), and the
 *     valid-verdict pair additionally renders its verified/refused result.
 */

import path from 'node:path';

import { readFileBytes, listDirEntries, statKind } from '../io/graph-fs.js';

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile, VerdictEntry } from '../model/lock.js';
import { hashBytes } from '../io/hash.js';
import {
  computeLlmInputHash,
  computeDetInputHash,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
  hashNodeSetObservation,
  MISSING_OBSERVATION,
} from './pair-hash.js';
import { computeAllowedNodePaths } from '../structure/ctx-graph.js';
import { resolveSuppressedRangesForPrompt, SuppressMarkerError } from '../structure/index.js';
import { ruleHashFor, contentFor, tierHashViewFromTier, companionHashFor } from './pair-inputs.js';
import type { ExpectedPair, UnreadableSubject, TypeCoverageInput, PairDrop, UncomputableTypeCoverage } from './pairs.js';
import { computeExpectedPairs } from './pairs.js';
import { selectTierForAspect } from './tier-selection.js';
import { assembledPromptChars, DEFAULT_MAX_PROMPT_CHARS } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput, PromptCompanionInput, PromptSuppressedRangesInput } from '../llm/prompt.js';
import { resolveCompanionsForPair } from './companion-resolve.js';
import {
  buildParseCacheBuckets,
  parseCacheBucketKey,
  releaseParseCacheBucket,
  destroyRemainingParseCaches,
} from './parse-cache-buckets.js';
import type { ParseCache } from '../structure/index.js';
import type { IssueMessage } from '../model/validation.js';

// ============================================================
// Public types
// ============================================================

/** Per-pair classification produced by lock verification. */
export type PairState =
  | { kind: 'verified' }
  | { kind: 'refused'; reason?: string } // valid entry, verdict refused
  | { kind: 'unverified' } // missing entry or hash mismatch
  | { kind: 'prompt-too-large'; chars: number; limit: number; tierName: string }
  | { kind: 'companion-error'; messageData: IssueMessage }; // companion.mjs could not resolve during the §4 gate

/**
 * A verified pair: the expected pair plus its computed state.
 *
 * `oversized` is set ONLY for the valid-verdict-but-now-oversized case: the
 * stored verdict is still valid (state is verified/refused), but the pair's
 * assembled prompt exceeds the resolved tier's max_prompt_chars. The renderer
 * emits a prompt-too-large error for the pair AND renders the preserved verdict.
 * When the pair is itself unverified-and-oversized, the state is
 * { kind: 'prompt-too-large' } and `oversized` is left undefined (the gate state
 * already carries chars/limit/tierName).
 */
export interface VerifiedPair {
  pair: ExpectedPair;
  state: PairState;
  /** Valid-verdict-but-oversized: gate error data to surface alongside the verdict. */
  oversized?: { chars: number; limit: number; tierName: string };
  /**
   * Set ONLY when this call assembled the prompt live for a pair whose stored
   * verdict is still VALID but carries no recorded `promptChars` — i.e. an entry
   * written by a CLI from before that field existed.
   *
   * It exists so `--approve` can record the number without re-reviewing
   * anything (core/fill-prompt-size-backfill.ts). Without that, a repository
   * whose verdicts are all still valid would never record a single size — there
   * is nothing to re-fill, so nothing would ever write one — and every check
   * would keep paying the full assembly cost the field exists to remove.
   *
   * Left undefined whenever the number came from the lock (nothing to write) or
   * the pair is not valid (a re-fill will write its own).
   */
  backfillPromptChars?: number;
}

export interface LockVerification {
  pairs: VerifiedPair[];
  /** From PairComputation — callers MUST render as blocking file-unreadable errors. */
  unreadable: UnreadableSubject[];
  /** From PairComputation — every reason a rule attached to a type-covered file does not run on it (core/type-visibility.ts's static half). */
  drops: PairDrop[];
  /** From PairComputation — type-covered files an aspect `implies` cycle stopped from being resolved at all (core/type-visibility.ts's "could not be worked out" half — distinct from `drops`). */
  uncomputableTypeCoverage: UncomputableTypeCoverage[];
}

// ============================================================
// verifyLock
// ============================================================

/**
 * Verify a loaded graph against a lock file. Pure read — no writes, no LLM
 * calls, no check.mjs execution. Returns a per-pair classification plus the
 * unreadable-subject list from pair computation.
 *
 * `typeCoverage` (CRITICAL): the SAME classification the caller already
 * computed once for this run, threaded through rather than recomputed here.
 * Without it, this builds a component-only pair universe while the lock may
 * already hold `file:` verdict entries: those entries would have no pair to
 * attach to, so they render as unexpected and the run goes red even though it
 * should be green.
 */
export async function verifyLock(
  graph: Graph,
  lock: LockFile,
  typeCoverage?: TypeCoverageInput,
): Promise<LockVerification> {
  const { pairs, unreadable, drops, uncomputableTypeCoverage } = await computeExpectedPairs(graph, { typeCoverage });
  const verified = await verifyPairs(graph, lock, pairs, typeCoverage);
  return { pairs: verified, unreadable, drops, uncomputableTypeCoverage };
}

/**
 * The per-pair re-verification loop `verifyLock` runs over EVERY expected
 * pair in the graph, factored out so a caller that already holds a SMALL,
 * pre-filtered slice of `ExpectedPair[]` (a single file's own nodeless pairs
 * — `yg owner --file`, `yg context --file`) can pay for exactly that slice's
 * re-hash instead of a second whole-project `computeExpectedPairs` walk on
 * top of the one it (or its caller) already ran to get `pairs` in the first
 * place. Same classification `verifyLock` produces for the identical pair —
 * this IS the engine `yg check` itself runs, not a cheaper approximation of
 * it: a stored entry that no longer matches its current input hash comes
 * back `{ kind: 'unverified' }` here exactly as it would from a full
 * `verifyLock` call, never only a missing-entry check.
 */
export async function verifyPairs(
  graph: Graph,
  lock: LockFile,
  pairs: ExpectedPair[],
  typeCoverage?: TypeCoverageInput,
): Promise<VerifiedPair[]> {
  const projectRoot = path.dirname(graph.rootPath);

  // Index aspect defs by id for O(1) lookup.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  // Cache file byte reads across pairs (subject files, references, observations).
  const byteCache = new Map<string, Buffer | null>();
  const readBytes = async (absPath: string): Promise<Buffer | null> => {
    if (byteCache.has(absPath)) return byteCache.get(absPath)!;
    const bytes = await readFileBytes(absPath);
    byteCache.set(absPath, bytes);
    return bytes;
  };

  // Memoize content digests: a file appearing in many pairs is hashed once per run.
  const digestCache = new Map<string, string>();
  const hashCached = (absPath: string, bytes: Buffer): string => {
    const hit = digestCache.get(absPath);
    if (hit !== undefined) return hit;
    const digest = hashBytes(bytes);
    digestCache.set(absPath, digest);
    return digest;
  };

  const verified: VerifiedPair[] = [];

  // The architecture-reach cache for a nodeless (component-free) LLM pair's
  // companion resolution — shared across every pair THIS call reviews,
  // computed once per matched type rather than once per pair. Mirrors
  // core/fill.ts's own per-run cache (same contract: fromType -> Set<string>).
  const reachCache = new Map<string, Set<string>>();

  // Shared parse caches for the companion hooks the §4 size gate may run, in
  // the SAME per-(aspect, node/unit) buckets the fill stage uses — see
  // core/parse-cache-buckets.ts for why that grouping is the right one (a
  // `per: file` rule builds one unit ctx PER SUBJECT, and every one of those
  // prewarms the identical set of trees for the identical node). Without a
  // shared cache each pair's `runCompanionHook` took its own `ownCache` branch:
  // build a Map, prewarm the whole unit, run the hook, destroy it — re-parsing
  // the same files once per subject and discarding every result. The fill path
  // has always passed a cache here; lock verification was the side that did not.
  //
  // Bucketed rather than one run-wide cache because a `ParseCache` holds native
  // WASM Trees that JS GC never reclaims (see `destroyParseCache`): a bucket is
  // destroyed the moment its last pair settles, so peak footprint tracks the
  // largest single unit instead of the whole repository. Only companion-bearing
  // LLM pairs can reach a hook, so only those are counted into a bucket — and
  // with a valid, size-recording verdict most of them no longer run one at all.
  const companionPairs = pairs.filter(
    (p) => p.kind === 'llm' && aspectById.get(p.aspectId)?.hasCompanion === true,
  );
  const parseCacheBuckets = buildParseCacheBuckets(companionPairs);
  const isCompanionPair = new Set(companionPairs);

  try {
    for (const pair of pairs) {
      const aspect = aspectById.get(pair.aspectId);
      // Defensive: pairs come from the same graph, so the aspect always exists.
      /* v8 ignore next */
      if (!aspect) continue;

      const storedEntry = lock.verdicts[pair.aspectId]?.[pair.unitKey];

      if (pair.kind === 'llm') {
        const bucket = isCompanionPair.has(pair)
          ? parseCacheBuckets.get(parseCacheBucketKey(pair))
          : undefined;
        try {
          verified.push(
            await verifyLlmPair(pair, aspect, graph, lock, projectRoot, storedEntry, readBytes, hashCached, typeCoverage, reachCache, bucket?.cache),
          );
        } finally {
          // Release even when the pair threw: the bucket's countdown must reach
          // zero for its trees to be freed, and the backstop below only runs
          // once for whatever is left.
          if (isCompanionPair.has(pair)) releaseParseCacheBucket(parseCacheBuckets, pair);
        }
      } else {
        verified.push(
          await verifyDetPair(pair, aspect, graph, projectRoot, storedEntry, readBytes, hashCached),
        );
      }
    }
  } finally {
    // Backstop only — the per-pair release above empties every bucket in the
    // common case, so this normally iterates nothing.
    destroyRemainingParseCaches(parseCacheBuckets);
  }

  return verified;
}

// ============================================================
// LLM pair verification
// ============================================================

async function verifyLlmPair(
  pair: ExpectedPair,
  aspect: AspectDef,
  graph: Graph,
  lock: LockFile,
  projectRoot: string,
  storedEntry: VerdictEntry | undefined,
  readBytes: (absPath: string) => Promise<Buffer | null>,
  hashCached: (absPath: string, bytes: Buffer) => string,
  typeCoverage: TypeCoverageInput | undefined,
  reachCache: Map<string, Set<string>>,
  parseCache: ParseCache | undefined,
): Promise<VerifiedPair> {
  // ── Resolve the tier (needed for both validity recompute and the gate). ──
  const reviewer = graph.config.reviewer;
  const tierResult = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;

  // ── Load subject file bytes once: used for both hash recompute and prompt. ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytes(path.resolve(projectRoot, rel));
    // A subject file that vanished cannot be hashed or prompted; treat its
    // content as empty bytes so the recompute differs from the stored hash
    // (the file change drove the disappearance ⇒ unverified) and the prompt
    // gate still measures the remaining payload deterministically.
    subjects.push({ path: rel, bytes: bytes ?? Buffer.alloc(0) });
  }

  // ── Load reference bytes (sorted by path is handled inside the hash fn). ──
  //    Only the HASH view is built here: it is needed on every pair. The PROMPT
  //    view — the same bytes decoded to UTF-8 text — is built lazily by the live
  //    gate below, which is the sole consumer and no longer runs on a valid pair
  //    with a recorded size. The bytes themselves stay in `readBytes`'s per-run
  //    cache either way, so the lazy build re-reads nothing.
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const refBytesByPath = new Map<string, Buffer>();
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    const bytes = await readBytes(absRef);
    const refBytes = bytes ?? Buffer.alloc(0);
    refBytesByPath.set(ref.path, refBytes);
    referencesForHash.push([ref.path, hashCached(absRef, refBytes), ref.description ?? '']);
  }

  // ── ruleHash = sha256(content.md bytes). Artifacts carry the loaded text. ──
  const ruleHash = ruleHashFor(aspect, 'content.md');

  // ── Companion symmetry. companionHash folds UNCONDITIONALLY: undefined
  //    for a plain aspect → not folded → the hash is byte-identical to the
  //    pre-feature contract. A companion aspect (any artifact named companion.mjs,
  //    even a []-resolving one) folds its companion.mjs digest, so a hook edit
  //    invalidates the verdict even with no out-of-subject observations. ──
  const companionHash = companionHashFor(aspect);

  // ── Re-observe the stored touched keys (the companion hook's own out-of-subject
  //    observations PLUS one read:<path> per companion file the fill read). The
  //    hook is NOT re-run — reObserve recomputes each key's CURRENT value from
  //    disk/graph exactly as verifyDetPair does (seeded with pair.nodePath so the
  //    two runners agree on graph visibility). A changed/vanished value yields a
  //    mismatch ⇒ unverified, never a throw. A plain aspect stored no touched, so
  //    touchedNow stays [] and is NOT folded (the hash guards on length). A
  //    nodeless unit seeds reObserve with the empty component context (''); its
  //    stored set can never carry a graph-bytype/-children/-flow key (a
  //    nodeless unit's ctx.graph refuses every call, so those observation
  //    kinds can never be recorded for one in the first place), so
  //    reObserve's component-scoped branches are unreachable here — pinned by a
  //    test, no new branch needed. ──
  const stored = storedEntry?.touched ?? [];
  const touchedNow: Array<[string, string]> = [];
  for (const [key] of stored) {
    touchedNow.push([key, await reObserve(key, graph, pair.nodePath ?? '', projectRoot, readBytes)]);
  }

  // ── Validity recompute. Requires a resolvable tier; if the tier cannot be
  //    resolved we cannot reproduce the stored hash, so the pair is unverified
  //    (the fill stage would have failed closed and written nothing).
  //
  //    This runs BEFORE the prompt-size gate below, and the order is the whole
  //    point: everything above is cheap (bytes already in `readBytes`'s cache,
  //    hashes already memoized), while the gate can cost a companion hook run
  //    and a full prompt assembly. Deciding validity first is what lets a valid
  //    pair take the stored-size path and never pay that. The classification the
  //    two produce together is unchanged — `classifyWithGate` sees the same
  //    (valid, gate) pair it always did, just computed in the other order. ──
  let valid = false;
  if (storedEntry !== undefined && tierResult?.ok) {
    const expectedHash = computeLlmInputHash({
      aspectId: aspect.id,
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: pair.nodePath,
      ruleHash,
      files: subjects.map((s) => [s.path, hashCached(path.resolve(projectRoot, s.path), s.bytes)] as [string, string]),
      references: referencesForHash,
      tier: tierHashViewFromTier(tierResult.tierName),
      // companionHash + touched fold only-when-present (the hash guards): a plain
      // aspect passes companionHash=undefined and touched=[] → byte-identical to
      // the pre-feature hash, so existing plain verdicts stay valid.
      companionHash,
      touched: touchedNow,
      verdict: storedEntry.verdict,
    });
    valid = expectedHash === storedEntry.hash;
  }

  // ── Prompt-size gate (§4): active whenever a tier resolves (an omitted
  // max_prompt_chars is gated at DEFAULT_MAX_PROMPT_CHARS — there is no
  // "unlimited" tier).
  //
  // A pair whose stored entry is VALID and carries a recorded `promptChars`
  // takes it at its word and assembles nothing. That is sound because the size
  // is fully determined by inputs the hash folds: the aspect's id, description
  // and body; every reference's path, description and content; the node path;
  // every subject file's content; every companion's content (each folded as a
  // `read:` observation in `touched`, re-observed above); and the suppressed
  // ranges, which are derived from subject content. A valid hash therefore
  // implies an unchanged prompt, and an unchanged prompt has an unchanged size.
  // (This became true when the node `description:` — the one prompt ingredient
  // the hash did not cover — stopped reaching the prompt at all; see
  // llm/prompt.ts's `nodeElement`.) The two live resolutions skipped along the
  // way cannot change the answer either: a companion whose hook, inputs and
  // read set are all unchanged resolves to what it resolved at fill time, and a
  // suppress marker set living in unchanged subject bytes resolves the same way
  // too — in both cases the fill would have written no verdict at all had they
  // failed, so a stored entry is itself evidence they succeeded.
  //
  // Everything else — a pair with no stored entry, a stale one, or one written
  // before `promptChars` existed — resolves LIVE, exactly as before. For a
  // companion aspect the companion set is resolved here (the same resolver fill
  // / --dry-run use), NOT reconstructed from the stored `touched` read: keys:
  // those conflate the hook's DECISION reads (ctx.fs / ctx.graph) with the files
  // it actually INJECTS, so they would size the prompt at the whole reachable
  // set instead of the few returned companions. Suppressed line ranges are also
  // resolved live so the assembled-prompt size MATCHES what fill / the reviewer
  // see — otherwise a plain LLM aspect (verify-lock is its only gate) whose
  // <suppressed-ranges> block tips it over the limit would slip past unflagged.
  // This is why plain `yg check` MAY run companion.mjs / the suppress resolver
  // (never a judge) — it still runs no check.mjs and calls no reviewer. Inputs
  // that cannot resolve here (a companion that fails, a reasonless suppress
  // marker) cannot be assembled or sized → fail closed (companion-error /
  // unverified).
  //
  // The LIMIT is read live in both branches. `max_prompt_chars` is excluded
  // from the verdict hash by design, so lowering a tier's ceiling must re-gate
  // verdicts that are otherwise still valid — which is exactly what comparing a
  // stored SIZE against the current limit does.
  let gate: { chars: number; limit: number; tierName: string } | undefined;
  if (tierResult?.ok && valid && storedEntry?.promptChars !== undefined) {
    const limit = tierResult.tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS;
    if (storedEntry.promptChars > limit) {
      gate = { chars: storedEntry.promptChars, limit, tierName: tierResult.tierName };
    }
  } else if (tierResult?.ok) {
    // A tier that OMITS max_prompt_chars is gated at DEFAULT_MAX_PROMPT_CHARS
    // (the §4 gate is always active — there is no "unlimited" tier). The guard
    // is therefore always-true; it is unwrapped, the body kept. This is the
    // load-bearing gate for plain LLM aspects (a stored entry is re-checked here).
    const limit = tierResult.tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS;
    let gateCompanions: PromptCompanionInput[] = [];
    if (aspect.hasCompanion === true) {
      const resolved = await resolveCompanionsForPair(graph, projectRoot, pair, aspect, typeCoverage, reachCache, parseCache);
      if (resolved.kind === 'infra') {
        return { pair, state: { kind: 'companion-error', messageData: resolved.messageData } };
      }
      gateCompanions = resolved.companions.promptCompanions;
    }
    // Resolve suppressed line ranges LIVE — the SAME resolver fill uses (routed
    // through the structure adapter; fill-llm cannot reach ast/* directly). The
    // injected <suppressed-ranges> block adds bytes the size gate must count, or
    // fill (which injects it) and verify (which would not) diverge — and for a
    // plain LLM aspect verify-lock is the ONLY gate. A reasonless marker throws
    // SuppressMarkerError: it cannot be sized → fail closed as unverified (the
    // next --approve re-runs fill-llm, which surfaces the precise what/why/next).
    let suppressedRanges: PromptSuppressedRangesInput;
    try {
      suppressedRanges = await resolveSuppressedRangesForPrompt(subjects, aspect.id);
    } catch (e) {
      if (e instanceof SuppressMarkerError) {
        return { pair, state: { kind: 'unverified' } };
      }
      throw e;
    }
    const chars = assembledPromptChars({
      aspect: {
        id: aspect.id,
        description: aspect.description ?? '',
        content: contentFor(aspect, 'content.md'),
      },
      references: refInputs.map<PromptReferenceInput>((ref) => ({
        path: ref.path,
        description: ref.description,
        content: (refBytesByPath.get(ref.path) ?? Buffer.alloc(0)).toString('utf8'),
      })),
      nodePath: pair.nodePath,
      files: subjects.map<PromptFileInput>((s) => ({
        path: s.path,
        content: s.bytes.toString('utf8'),
      })),
      companions: gateCompanions,
      suppressedRanges,
      scope: aspect.scope,
    });
    if (chars > limit) {
      gate = { chars, limit, tierName: tierResult.tierName };
    }
    // A pair that is VALID and reached this branch had no recorded size — an
    // entry from before the field existed. Hand the number up so `--approve` can
    // record it (see `backfillPromptChars`); the next check then takes the fast
    // path instead of reassembling this prompt forever.
    if (valid) {
      return { ...classifyWithGate(pair, storedEntry, valid, gate), backfillPromptChars: chars };
    }
  }

  return classifyWithGate(pair, storedEntry, valid, gate);
}

// ============================================================
// Deterministic pair verification
// ============================================================

async function verifyDetPair(
  pair: ExpectedPair,
  aspect: AspectDef,
  graph: Graph,
  projectRoot: string,
  storedEntry: VerdictEntry | undefined,
  readBytes: (absPath: string) => Promise<Buffer | null>,
  hashCached: (absPath: string, bytes: Buffer) => string,
): Promise<VerifiedPair> {
  let valid = false;

  if (storedEntry !== undefined) {
    // Re-observe the CURRENT value of every STORED touched key. A value that
    // changed — or a file/dir/node that vanished — yields a mismatch ⇒ the
    // recomputed hash differs ⇒ unverified. Re-observation NEVER throws.
    const stored = storedEntry.touched ?? [];
    const touchedNow: Array<[string, string]> = [];
    for (const [key] of stored) {
      // Empty component context for a nodeless unit — see verifyLlmPair's twin comment.
      const nowHash = await reObserve(key, graph, pair.nodePath ?? '', projectRoot, readBytes);
      touchedNow.push([key, nowHash]);
    }

    // Subject file hashes from current disk (a vanished subject hashes empty,
    // which differs from any stored content ⇒ unverified).
    const files: Array<[string, string]> = [];
    for (const rel of pair.subjectFiles) {
      const absPath = path.resolve(projectRoot, rel);
      const bytes = await readBytes(absPath);
      const buf = bytes ?? Buffer.alloc(0);
      files.push([rel, hashCached(absPath, buf)]);
    }

    const ruleHash = ruleHashFor(aspect, 'check.mjs');

    const expectedHash = computeDetInputHash({
      aspectId: aspect.id,
      scope: aspect.scope,
      nodePath: pair.nodePath,
      ruleHash,
      files,
      touched: touchedNow,
      verdict: storedEntry.verdict,
    });
    valid = expectedHash === storedEntry.hash;
  }

  // Deterministic pairs have no prompt and are not subject to the gate (§4).
  return classifyWithGate(pair, storedEntry, valid, undefined);
}

// ============================================================
// Classification + gate precedence
// ============================================================

/**
 * Turn a validity verdict + optional gate into a VerifiedPair, applying §4 gate
 * precedence:
 *   - invalid/missing entry + gate trips → prompt-too-large state (replaces
 *     unverified; no duplicate);
 *   - invalid/missing entry + no gate → unverified;
 *   - valid entry (verified/refused) + gate trips → verdict state preserved,
 *     gate surfaced via `oversized`;
 *   - valid entry + no gate → verdict state only.
 */
function classifyWithGate(
  pair: ExpectedPair,
  storedEntry: VerdictEntry | undefined,
  valid: boolean,
  gate: { chars: number; limit: number; tierName: string } | undefined,
): VerifiedPair {
  if (valid && storedEntry !== undefined) {
    const verdictState: PairState =
      storedEntry.verdict === 'refused'
        ? { kind: 'refused', reason: storedEntry.reason }
        : { kind: 'verified' };
    if (gate) {
      return { pair, state: verdictState, oversized: gate };
    }
    return { pair, state: verdictState };
  }

  // Invalid or missing entry.
  if (gate) {
    return {
      pair,
      state: { kind: 'prompt-too-large', chars: gate.chars, limit: gate.limit, tierName: gate.tierName },
    };
  }
  return { pair, state: { kind: 'unverified' } };
}

// ============================================================
// Re-observation (deterministic validity)
// ============================================================

/**
 * Re-observe the CURRENT value for a stored observation key and return its hash
 * using the frozen observation-hash helpers. Mirrors the runner's recording
 * (ObservationRecorder) so an unchanged value reproduces the stored hash.
 *
 * Disk-backed kinds (read/list/exists/graph) re-read from disk; graph-SET kinds
 * (graph-children/graph-bytype/graph-flow) recompute from the live `graph` — the
 * runner folded them from the same graph at record time, so a node added/removed
 * from the relevant set changes the value ⇒ unverified (spec §3.1). The
 * graph-bytype set is scoped to the SAME allowed-node set the runner used for
 * `currentNodePath`, so the two sides agree on which nodes are visible.
 */
async function reObserve(
  key: string,
  graph: Graph,
  currentNodePath: string,
  projectRoot: string,
  readBytes: (absPath: string) => Promise<Buffer | null>,
): Promise<string> {
  const sep = key.indexOf(':');
  /* v8 ignore next -- observation keys are always '<kind>:<target>' by construction */
  if (sep < 0) return MISSING_OBSERVATION;
  const kind = key.slice(0, sep);
  const target = key.slice(sep + 1);

  switch (kind) {
    case 'read': {
      const bytes = await readBytes(path.resolve(projectRoot, target));
      return bytes === null ? MISSING_OBSERVATION : hashReadObservation(bytes);
    }
    case 'graph': {
      // graph:<nodePath> hashes the node's yg-node.yaml bytes (runner contract).
      // An absent node yg-node.yaml folds MISSING_OBSERVATION — byte-identical to
      // the runner's recordGraphNodeAbsent for a negative ctx.graph.node() probe.
      const ygNodePath = path.resolve(projectRoot, '.yggdrasil', 'model', target, 'yg-node.yaml');
      const bytes = await readBytes(ygNodePath);
      return bytes === null ? MISSING_OBSERVATION : hashReadObservation(bytes);
    }
    case 'list': {
      const entries = await listDir(path.resolve(projectRoot, target));
      return entries === null ? MISSING_OBSERVATION : hashListObservation(entries);
    }
    case 'exists': {
      const result = await existsProbe(path.resolve(projectRoot, target));
      return hashExistsObservation(result);
    }
    case 'graph-children': {
      // target = parent node path. Fold the SET of that node's child ids.
      const parent = graph.nodes.get(target);
      const childIds = parent ? parent.children.map((c) => c.path) : [];
      return hashNodeSetObservation(childIds);
    }
    case 'graph-bytype': {
      // target = node type. Fold the SET of node ids of that type WITHIN the
      // allowed-node set the runner used for the current node (same visibility).
      const allowed = computeAllowedNodePaths(currentNodePath, graph);
      const ids: string[] = [];
      for (const id of allowed) {
        const m = graph.nodes.get(id);
        if (m && m.meta.type === target) ids.push(m.path);
      }
      return hashNodeSetObservation(ids);
    }
    case 'graph-flow': {
      // target = flow name. Fold the SET of the flow's declared participant ids.
      const flow = graph.flows.find((f) => f.name === target || f.path === target);
      return hashNodeSetObservation(flow ? [...flow.nodes] : []);
    }
    /* v8 ignore next 2 -- unknown kind never produced by observationKey() */
    default:
      return MISSING_OBSERVATION;
  }
}

async function listDir(absDir: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }> | null> {
  return listDirEntries(absDir);
}

async function existsProbe(absPath: string): Promise<'file' | 'dir' | false> {
  return statKind(absPath);
}

