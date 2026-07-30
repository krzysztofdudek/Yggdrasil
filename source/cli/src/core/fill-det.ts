/**
 * source/cli/src/core/fill-det.ts — the deterministic-pair filler for the fill
 * stage (spec §7 step 5). Runs a node's check.mjs through the structure runner,
 * fails closed on any runtime error / taint (no write), and on a clean run
 * produces the content-addressed verdict entry.
 */

import path from 'node:path';

import type { Graph, AspectDef } from '../model/graph.js';
import type { VerdictEntry, Verdict } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { computeNodeMappedFiles } from './pairs.js';
import { computeDetInputHash } from './pair-hash.js';
import { ruleHashFor } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { runStructureAspect, StructureRunnerError, SUPPRESS_MARKER_MALFORMED_CODE } from '../structure/runner.js';
import type { StructureUnit } from '../structure/runner.js';
import { collectArchitectureReach } from '../structure/allowed-reads.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { readBytesOrEmpty, type DetFillOutcome } from './fill-shared.js';

/**
 * A subject-file-INDEPENDENT sentinel repo-relative path, used only as the
 * throwaway `subjectFile` argument when computing the type-dependent part of
 * an architecture reach (declared-component and type-covered files the
 * architecture permits `fromType` to depend on) once per type, cacheable
 * across every nodeless file of that type this run. A real repo-relative path
 * is never empty and never contains NUL, so this can never collide with one;
 * the sentinel itself is deleted from the result before caching, so the cached
 * set holds only the type-dependent part — never a specific file's own
 * identity, which the caller re-adds per file (see `reachExtraForType`).
 */
const REACH_SENTINEL_FILE = '\0';

/**
 * The type-dependent part of `collectArchitectureReach` for `fromType`
 * (declared-component files and other type-covered files the architecture
 * permits `fromType` to depend on) — cached by `fromType` so a run reviewing
 * many files of the same type computes this ONCE (K9: a per-pair recomputation
 * over a repo with thousands of files would dominate the run). The caller
 * unions in its OWN subject file afterward (cheap, O(1) per file) — never
 * cached here, since a DIFFERENT file's own identity must never leak into
 * another file's allowance when the architecture does not itself permit
 * `fromType` to depend on `fromType`.
 */
function reachExtraForType(
  fromType: string,
  typeCoverage: TypeCoverageInput | undefined,
  graph: Graph,
  reachCache: Map<string, Set<string>>,
): Set<string> {
  const cached = reachCache.get(fromType);
  if (cached) return cached;
  const full = collectArchitectureReach(REACH_SENTINEL_FILE, {
    fromType,
    typeCovered: typeCoverage?.covered ?? new Map<string, string>(),
    architecture: graph.architecture,
    graph,
  });
  full.delete(REACH_SENTINEL_FILE);
  reachCache.set(fromType, full);
  return full;
}

/**
 * Fill one deterministic pair. Runs check.mjs through the structure runner with a
 * subjectScope WHENEVER the pair's subject set is NARROWER than the node's full
 * mapping (spec §1, §3.1; contract #8):
 *
 *   - `per: file` → subject is a single file (always narrower unless the node
 *     maps exactly that one file).
 *   - `per: node` + `scope.files` that actually excludes a mapped file → the
 *     excluded siblings are NOT subjects; without subjectScope the runner would
 *     preload them into ctx.node.files UN-recorded, so a check reading an excluded
 *     file folds into NEITHER the subject hash NOR an observation → stale-green.
 *     subjectScope makes those reads record as `read:` observations, which the
 *     verifier re-observes (a later edit to an excluded-but-read file invalidates
 *     the pair).
 *
 * A plain `per: node` aspect with no filter (or a scope.files that matches every
 * mapped file) keeps the legacy path (subjectScope undefined) so the documented
 * `ctx.files === ctx.node.files` alias is preserved.
 *
 * MANDATORY A6 carry-overs:
 *   (1) gate on succeeded === true BEFORE consuming observations (a failed run's
 *       observations are meaningless).
 *   (2) a tainted result must NEVER be written — re-run once; still tainted →
 *       runtime-error (no write).
 *
 * NOTE: runtime-error outcomes carry the structured messageData so the orchestrator
 * (fill.ts) can collect and GROUP notices by aspectId before emitting — emitting one
 * message per aspect when multiple units of the same check fail, rather than N
 * near-identical per-pair messages.
 */
export async function fillDetPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  // The structure runner is injected so the parallel fill path can route the
  // actual check.mjs execution through a worker-thread pool. The default runs it
  // in-process (identical behavior); a pooled runner reconstructs
  // StructureRunnerError on the parent so the catch below is byte-for-byte
  // unchanged. Only SPEED differs — the verdict is identical either way.
  runStructure: typeof runStructureAspect = runStructureAspect,
  // Type-level coverage facts for this run (absent ⇒ no nodeless pairs exist,
  // the feature-off contract every other type-coverage consumer already
  // follows). Only consulted for a pair with no owning component.
  typeCoverage?: TypeCoverageInput,
  // Shared across every fillDetPair call THIS RUN (the caller constructs one
  // Map and passes it to every call) — the reach cache the K9 note requires:
  // computed once per fromType, never once per pair.
  reachCache: Map<string, Set<string>> = new Map(),
): Promise<DetFillOutcome> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
  // The subject is narrowed iff it covers FEWER files than the node's full
  // mapping (pair.subjectFiles ⊆ full mapping always, so a length difference is
  // an exact set difference). Both per:file and per:node-with-scope.files can
  // narrow; a plain per:node aspect has subject == full mapping → undefined.
  // A nodeless pair has no "whole component" to compare against — its subject
  // ALWAYS narrows (skip the mapped-files call entirely: computeNodeMappedFiles
  // has no node to look up and would waste an I/O round-trip returning []).
  const subjectScope = pair.nodePath === undefined
    ? pair.subjectFiles
    : ((await computeNodeMappedFiles(graph, pair.nodePath)).length > pair.subjectFiles.length
        ? pair.subjectFiles
        : undefined);

  // Addressing: a component pair runs the node branch unchanged; a nodeless
  // pair (no owning component) carries its OWN architecture-derived allowance
  // instead of one derived from a component's mapping — the matched type's own
  // relation allow-list is the only authority, since there is no per-component
  // narrowing to apply with no component (structure/allowed-reads.ts).
  const unit: StructureUnit = pair.nodePath !== undefined
    ? { kind: 'node', nodePath: pair.nodePath }
    : (() => {
        const file = pair.subjectFiles[0];
        const fromType = typeCoverage?.covered.get(file) ?? '';
        const reachExtra = reachExtraForType(fromType, typeCoverage, graph, reachCache);
        return { kind: 'file' as const, file, typeId: fromType, allowedReads: [...reachExtra, file] };
      })();

  const runOnce = async () => {
    try {
      return { ok: true as const, result: await runStructure({
        aspectDir: aspectDirAbs,
        aspectId: aspect.id,
        unit,
        graph,
        projectRoot,
        subjectScope,
      }) };
    } catch (e) {
      debugWrite(`[fill] det runtime error for ${aspect.id} on ${pair.nodePath ?? pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
      // A malformed suppress marker is a fault in the SOURCE file's marker, not in
      // check.mjs — surface it as its OWN disposition (its self-describing
      // messageData), never as aspect-check-runtime-error.
      if (e instanceof StructureRunnerError && e.code === SUPPRESS_MARKER_MALFORMED_CODE) {
        return { ok: false as const, failure: { kind: 'malformed-suppress' as const, messageData: e.messageData } };
      }
      const rendered = e instanceof StructureRunnerError
        ? `${e.messageData.what} — ${e.messageData.why}`
        : (e instanceof Error ? e.message : String(e));
      return { ok: false as const, failure: { kind: 'runtime-error' as const, messageData: detRuntimeNotice(aspect.id, pair.unitKey, rendered) } };
    }
  };

  let run = await runOnce();
  // A6 carry-over (1): a result with succeeded === false is an infra disposition.
  if (!run.ok) {
    return run.failure;
  }
  if (run.result.succeeded === false) {
    const reason = run.result.violations.map((v) => v.message).join('\n') || 'check runtime error';
    return { kind: 'runtime-error', messageData: detRuntimeNotice(aspect.id, pair.unitKey, reason) };
  }
  // A6 carry-over (2): a tainted observation set must never be cached — a file
  // changed mid-run. Re-run once; if it taints again, fail closed (no write).
  if (run.result.observationsTainted) {
    run = await runOnce();
    if (!run.ok) {
      return run.failure;
    }
    if (run.result.succeeded === false || run.result.observationsTainted) {
      return { kind: 'runtime-error', messageData: detRuntimeNotice(aspect.id, pair.unitKey, 'observations remained inconsistent across two runs (a file changed mid-check)') };
    }
  }

  const violations = run.result.violations;
  const verdict: Verdict = violations.length > 0 ? 'refused' : 'approved';
  const observations = run.result.observations;

  // Subject file hashes from current disk (sorted by path) — mirrors verifyDetPair.
  const files: Array<[string, string]> = [];
  for (const rel of pair.subjectFiles) {
    const abs = path.resolve(projectRoot, rel);
    const bytes = await readBytesOrEmpty(abs);
    files.push([rel, hashBytes(bytes)]);
  }

  const hash = computeDetInputHash({
    aspectId: aspect.id,
    scope: aspect.scope,
    nodePath: pair.nodePath,
    ruleHash: ruleHashFor(aspect, 'check.mjs'),
    files,
    touched: observations,
    verdict,
  });

  const entry: VerdictEntry = { verdict, hash, touched: observations };
  if (verdict === 'refused') {
    entry.reason = violations
      .map((v) => {
        const file = v.file ? toPosixPath(v.file) : v.file;
        // Location renders as 'file:line: ' with a line, 'file: ' without one
        // (no placeholder), and '' when the violation has no file.
        const loc = file ? (typeof v.line === 'number' ? `${file}:${v.line}: ` : `${file}: `) : '';
        return `${loc}${v.message}`;
      })
      .join('\n');
  }
  return { kind: 'verdict', entry };
}

function detRuntimeNotice(aspectId: string, unitKey: string, reason: string): IssueMessage {
  return {
    what: `Deterministic check '${aspectId}' failed to run on ${toPosixPath(unitKey)} — left unverified (aspect-check-runtime-error).`,
    why: `The check.mjs crashed, returned an invalid result, or its observations changed mid-run: ${reason}`,
    next: `Fix the check.mjs, then re-run: yg check --approve`,
  };
}
