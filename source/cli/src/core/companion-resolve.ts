/**
 * source/cli/src/core/companion-resolve.ts — shared post-hook companion resolution.
 *
 * Extracts the logic that is common to both the fill-llm path (yg check --approve)
 * and the aspect-test path (yg aspect-test --dry-run / live): given the raw descriptors
 * and observations from a runCompanionHook call, normalize, dedupe, sort, validate
 * allowed-reads, read each file, and return the resolved companion set + updated
 * observations.
 *
 * `resolveCompanionDescriptors` (the post-hook helper) has ONE responsibility and
 * must NOT call the reviewer, mutate the lock, or contain the A6 taint guard.
 *
 * `resolveCompanionsForPair` (added below) is the per-pair orchestrator shared by
 * the fill path (yg check --approve) and the verify-lock §4 size gate (plain
 * yg check): it runs the hook with the A6 taint-retry guard and then delegates to
 * `resolveCompanionDescriptors`. It still never calls the reviewer or mutates the
 * lock. (aspect-test keeps its own no-A6 diagnostic orchestration.)
 */

import path from 'node:path';

import type { Graph, AspectDef } from '../model/graph.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { computeNodeMappedFiles } from './pairs.js';
import type { PromptCompanionInput } from '../llm/prompt.js';
import type { IssueMessage } from '../model/validation.js';
import { runCompanionHook, type RunCompanionHookResult } from '../structure/hook-loader.js';
import type { StructureUnit } from '../structure/hook-loader.js';
import type { ParseCache } from '../structure/index.js';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { collectAllowedReadsForAspect, collectArchitectureReach } from '../structure/allowed-reads.js';
import { resolveAllowedReadPath, UndeclaredFsReadError } from '../structure/ctx-fs.js';
import { findNestedProjectRoots, NO_COVERAGE_EXCLUDED, describeExclusionCause, type ExclusionSource } from '../io/repo-scanner.js';
import { readFileBytes } from '../io/graph-fs.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import { observationKey, hashReadObservation } from './pair-hash.js';

/**
 * A subject-file-INDEPENDENT sentinel repo-relative path, used only as the
 * throwaway `subjectFile` argument when computing the type-dependent part of
 * a nodeless pair's companion read-allowance (declared-component and other
 * type-covered files the architecture permits `fromType` to depend on) once
 * per type. Deliberately the SAME sentinel value and cache shape as
 * core/fill-det.ts's own private helper of the same purpose — fromType ->
 * Set<string>, sentinel deleted before storage — so a caller MAY share one
 * cache Map between a run's deterministic and companion fills without either
 * side needing to know the other exists. Duplicated here rather than
 * imported: fill-det.ts's helper is module-private, and importing it would
 * create a dependency this module does not otherwise need.
 */
const REACH_SENTINEL_FILE = '\0';

/**
 * The type-dependent part of a nodeless pair's companion allowance — cached
 * by fromType so a run resolving companions for many files of the same type
 * pays this once per type, not once per pair. See REACH_SENTINEL_FILE above
 * for why this duplicates (rather than imports) fill-det.ts's own helper.
 */
async function reachExtraForType(
  fromType: string,
  typeCoverage: TypeCoverageInput | undefined,
  graph: Graph,
  projectRoot: string,
  reachCache: Map<string, Set<string>>,
): Promise<Set<string>> {
  const cached = reachCache.get(fromType);
  if (cached) return cached;
  const full = await collectArchitectureReach(REACH_SENTINEL_FILE, {
    fromType,
    typeCovered: typeCoverage?.covered ?? new Map<string, string>(),
    architecture: graph.architecture,
    graph,
    projectRoot,
    ownerIndex: buildOwnerIndex(graph.nodes),
  });
  full.delete(REACH_SENTINEL_FILE);
  reachCache.set(fromType, full);
  return full;
}

export type ResolvedCompanionDescriptorsResult =
  | { kind: 'ok'; companions: PromptCompanionInput[]; observations: Array<[string, string]> }
  | { kind: 'infra'; why: string; messageData: IssueMessage };

/**
 * Build the infra messageData for a companion path that resolved OUTSIDE the
 * node's allowed-reads (or escaped the repo root). The NEXT frames the relation
 * SOURCE as pair.nodePath and the TARGET as the owner of the companion path —
 * NEVER pair.subjectFiles / unitKey (a per:file .md subject cannot hold a
 * relation). When the path is unmapped (no owner) the NEXT says so.
 *
 * `typeId` is passed ONLY for a nodeless pair (pair.nodePath undefined) — the
 * subject file's matched architecture type, used to name the SOURCE side of
 * the "allow the dependency" exit. It is ignored for a component pair.
 *
 * Exported so callers (tests) can verify the exact message shape.
 */
export function companionOutsideAllowedReads(
  graph: Graph,
  pair: Pick<ExpectedPair, 'nodePath' | 'unitKey'>,
  aspect: AspectDef,
  rel: string,
  exclusionSource: ExclusionSource | null,
  typeId?: string,
): { why: string; messageData: IssueMessage } {
  // A companion.mjs hook can return ANY path on disk, including one this graph
  // excludes (a nested project's own boundary, or a coverage.excluded root) —
  // resolveAllowedReadPath rejects such a path before the allow-set is even
  // consulted, so it always lands here. Answer with the SAME fact every other
  // ownership surface gives for an excluded path (`yg owner --file`, `yg
  // context --file`) instead of an owner-lookup NEXT that names a relation to
  // declare: no relation can ever satisfy this, since the path is gone from
  // graph coverage regardless of what any node's mapping or relations say.
  // `exclusionSource` names WHICH of the two independent sources applies
  // (resolveAllowedReadPath already worked this out at the throw site — see
  // UndeclaredFsReadError's own doc comment), the same distinction every
  // other exclusion message in the graph draws, instead of a disjunction the
  // reader has to check both halves of.
  if (exclusionSource !== null) {
    const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} is excluded from graph coverage by design.`;
    const why = `No node or architecture type is ever permitted to depend on this path because ${describeExclusionCause(exclusionSource)} — the reviewer may only see files the graph counts as covered, so an excluded companion is an infrastructure fault and the fill fails closed (NOTHING written).`;
    const next = `Fix companion.mjs to return only non-excluded, relation-reachable paths.`;
    return { why: `companion '${rel}' is excluded from graph coverage by design`, messageData: { what, why, next } };
  }

  // A nodeless pair has no component whose allowed-reads could widen — the
  // architecture's relation allow-list is the ONLY authority. Never names a
  // component (there is none) and never constructs a yg-node.yaml PATH (there
  // is no node to hold one) — both exits stay abstract: widen the
  // architecture, or give the file a component of its own.
  if (pair.nodePath === undefined) {
    const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} is outside what its architecture type may reach.`;
    const why =
      "A companion for a file enforced by its architecture type alone may only see files the architecture's relation allow-list permits that type to depend on — there is no component whose own allowed-reads could widen this. An out-of-reach companion is an infrastructure fault and the fill fails closed (NOTHING written).";
    const typeLabel = typeId && typeId !== '' ? `'${typeId}'` : "this file's type";
    const next = `Allow ${typeLabel} to depend on whatever owns '${rel}' in yg-architecture.yaml, or give the file a component of its own (a yg-node.yaml mapping it) so it can declare an explicit relation instead.`;
    return { why: `companion '${rel}' is outside the file's architecture-permitted reach`, messageData: { what, why, next } };
  }

  const owner = buildOwnerIndex(graph.nodes).ownerOf(rel);
  const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} is outside the node's allowed-reads.`;
  const why =
    'A companion must be relation-reachable from the reviewed node — the reviewer may only see files the graph permits the node to read, so an out-of-reach companion is an infrastructure fault and the fill fails closed (NOTHING written).';
  const ownerNodePath = pair.nodePath;
  const next =
    owner === undefined
      ? `The path '${rel}' is unmapped (no node owns it). Map it to a node and declare a relation from ${toPosixPath(ownerNodePath)} to that node in .yggdrasil/model/${toPosixPath(ownerNodePath)}/yg-node.yaml, or fix companion.mjs to return only relation-reachable paths.`
      : `declare a relation from ${toPosixPath(ownerNodePath)} to ${toPosixPath(owner)} in .yggdrasil/model/${toPosixPath(ownerNodePath)}/yg-node.yaml, or fix companion.mjs to return only relation-reachable paths.`;
  return { why: `companion '${rel}' is outside the node's allowed-reads`, messageData: { what, why, next } };
}

/**
 * Shared post-hook companion resolution used by both fill-llm (--approve) and
 * aspect-test (diagnostic). The caller is responsible for running runCompanionHook
 * (and for the A6 taint guard, if applicable). This function operates on the
 * descriptors and observations already returned by the hook.
 *
 * Steps:
 *   1. Normalize each returned path to repo-root-relative POSIX
 *   2. Subject-dedupe: drop any path already in pair.subjectFiles
 *   3. Sort paths
 *   4. Label-lookup per path (from descriptors)
 *   5. For each path: resolveAllowedReadPath guard → companionOutsideAllowedReads on failure
 *   6. readFileBytes → infra on null
 *   7. Push to companions; merge hook observations + per-companion read: observation
 *
 * Returns { kind: 'ok', companions, observations } on success, or
 * { kind: 'infra', why, messageData } on any failure.
 */
export async function resolveCompanionDescriptors(
  graph: Graph,
  projectRoot: string,
  pair: Pick<ExpectedPair, 'nodePath' | 'subjectFiles' | 'unitKey'>,
  aspect: AspectDef,
  descriptors: Extract<RunCompanionHookResult, { kind: 'ok' }>['descriptors'],
  hookObservations: Extract<RunCompanionHookResult, { kind: 'ok' }>['observations'],
  /**
   * Present ONLY for a nodeless pair (pair.nodePath undefined) — the
   * architecture-derived allowance computed by the caller (collectArchitectureReach,
   * via reachExtraForType above) stands in for collectAllowedReadsForAspect,
   * which has no component to resolve against. `typeId` names the subject
   * file's matched type for the out-of-reach message.
   */
  nodelessAllowance?: { typeId: string; allowedReads: Set<string> },
): Promise<ResolvedCompanionDescriptorsResult> {
  // ── Normalize each returned path to repo-root-relative POSIX, dedupe + sort. ──
  // A component pair reads its allowance from the node's own mapping/relations.
  // A nodeless pair carries its OWN architecture-derived allowance instead
  // (there is no component to resolve collectAllowedReadsForAspect against).
  const allowedSet = nodelessAllowance ? nodelessAllowance.allowedReads : collectAllowedReadsForAspect(pair.nodePath ?? '', graph);
  // Everything the graph excludes globally below the project root — a
  // separate project's own boundary (nested `.yggdrasil/` graph, nested
  // `.git` checkout/submodule/worktree) plus the adopter's own
  // `coverage.excluded` roots — the same run-cached set / config ctx.fs /
  // ctx.parseAst reject against (structure/ctx-fs.ts), so a companion.mjs
  // cannot name an excluded path just because a directory/glob mapping entry
  // textually covers it.
  const nestedProjectRoots = await findNestedProjectRoots(projectRoot);
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const subjectSet = new Set(pair.subjectFiles.map((p) => toPosix(p)));
  const normalizedSet = new Set<string>();
  for (const d of descriptors) {
    // Normalize to repo-root-relative POSIX. A path escaping the repo root is an
    // allowed-reads guard failure (handled below by resolveAllowedReadPath).
    const abs = path.resolve(projectRoot, d.path.replace(/\\/g, '/'));
    const rel = toPosix(path.relative(projectRoot, abs));
    // Subject-read dedupe: a returned path equal to a unit subject is already a
    // subject (hashed + prompted as such) — drop it, never inject, never record.
    if (subjectSet.has(rel)) continue;
    normalizedSet.add(rel);
  }
  const sortedPaths = [...normalizedSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // ── Validate + read each remaining companion path. Build prompt + observations. ──
  const companions: PromptCompanionInput[] = [];
  // Combine the hook's own out-of-subject observations (reads it made to RESOLVE)
  // with a read: observation per companion file we read. Both are inputs that must
  // invalidate the verdict on edit. Dedupe by key (a path read both by the hook and
  // re-read here hashes identically — collapse to one).
  const obsByKey = new Map<string, string>();
  for (const [k, h] of hookObservations) obsByKey.set(k, h);

  // Label lookup so the prompt can carry the author's optional label per path.
  const labelByPath = new Map<string, string | undefined>();
  for (const d of descriptors) {
    const abs = path.resolve(projectRoot, d.path.replace(/\\/g, '/'));
    const rel = toPosix(path.relative(projectRoot, abs));
    if (!labelByPath.has(rel)) labelByPath.set(rel, d.label);
  }

  for (const rel of sortedPaths) {
    // Allowed-reads guard (shared with ctx.fs): normalizes, rejects repo-escape,
    // enforces the allow-set, and re-checks the real (symlink-resolved) path. Any
    // failure → infra with a relation-source/target NEXT.
    try {
      resolveAllowedReadPath(rel, allowedSet, projectRoot, nestedProjectRoots, coverage);
    } catch (err) {
      // resolveAllowedReadPath already worked out WHY at the throw site — read
      // it off the caught error instead of re-deriving it here, so this
      // caller can never drift from the other two consumers of the same throw
      // (structure/runner.ts, structure/hook-loader.ts).
      const exclusionSource = err instanceof UndeclaredFsReadError ? err.exclusionSource : null;
      return { kind: 'infra', ...companionOutsideAllowedReads(graph, pair, aspect, rel, exclusionSource, nodelessAllowance?.typeId) };
    }
    const bytes = await readFileBytes(path.resolve(projectRoot, rel));
    if (bytes === null) {
      const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} could not be read.`;
      const why =
        'A resolved companion is part of the verifier input; reading empty-substituted bytes would desync the producer and verifier and pin a false verdict, so the fill fails closed and writes NOTHING.';
      const next = `Restore the file at '${rel}' or fix companion.mjs so it returns only existing, relation-reachable paths, then re-run: yg check --approve`;
      return { kind: 'infra', why: `companion '${rel}' could not be read`, messageData: { what, why, next } };
    }
    companions.push({
      path: rel,
      content: bytes.toString('utf8'),
      ...(labelByPath.get(rel) !== undefined ? { label: labelByPath.get(rel) } : {}),
    });
    obsByKey.set(observationKey('read', rel), hashReadObservation(bytes));
  }

  const observations = [...obsByKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { kind: 'ok', companions, observations };
}

/**
 * The resolved per-unit companion set: the read-only paired files (paths +
 * content) for the prompt, and the read: observations that fold into the LLM pair
 * hash so an edit to a companion file invalidates the verdict.
 */
export interface ResolvedCompanions {
  promptCompanions: PromptCompanionInput[];
  /** [observationKey, observationHash] — the union of the hook's own out-of-subject
   *  observations AND a read: observation per companion file read here. Sorted +
   *  deduped (the hash sorts but does not dedupe). */
  observations: Array<[string, string]>;
}

/**
 * Resolve an aspect's companion.mjs over the unit, with the A6 taint guard. Shared
 * by the fill path (yg check --approve, BEFORE consensus) and the verify-lock §4
 * size gate (plain yg check, to measure the REAL companion bytes). The whole
 * resolution fails closed: a torn observation set (tainted twice), a hook throw, a
 * bad shape, a missing path, or a path outside allowed-reads returns
 * { kind: 'infra' } — NOTHING is written and the reviewer is never called.
 *
 * Mirrors the fill-det A6 taint guard (run once → retry once → still tainted → infra).
 * This function NEVER calls the reviewer and NEVER mutates the lock.
 *
 * `typeCoverage`/`reachCache` are consulted ONLY for a nodeless pair (no
 * owning component) — a component pair's unit and allowance are unaffected,
 * so omitting them changes nothing for the byte-identical component path.
 * `reachCache` mirrors core/fill-det.ts's own per-run cache shape (fromType ->
 * Set<string>); a caller filling both deterministic and LLM pairs in the same
 * run MAY pass the SAME Map to both so the type-dependent reach is computed
 * once per type across the whole run, not once per pair per path.
 *
 * `parseCache`, when given, is threaded into EVERY `runCompanionHook` call this
 * function makes — including the A6 taint-guard retry — so a caller resolving
 * companions for several pairs that share a node (e.g. every subject of a
 * `per: file` rule) can share ONE parse cache across all of them instead of
 * each pair building and discarding its own. Absent → `runCompanionHook`'s own
 * default (a fresh cache per call, destroyed when that call returns) — today's
 * byte-identical behavior. The cache holds native WASM Tree objects (see
 * `destroyParseCache`'s own doc) and is never destroyed here — the caller that
 * built it owns its lifetime.
 */
export async function resolveCompanionsForPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  typeCoverage?: TypeCoverageInput,
  reachCache: Map<string, Set<string>> = new Map(),
  parseCache?: ParseCache,
): Promise<{ kind: 'ok'; companions: ResolvedCompanions } | { kind: 'infra'; why: string; messageData: IssueMessage }> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);

  // subjectScope mirrors fill-det: narrow iff the subject set is FEWER files than
  // the node's full mapping (per:file, or per:node with a scope.files filter). A
  // plain per:node aspect has subject == full mapping → undefined (legacy ctx).
  // A nodeless pair has no "whole component" to compare against — it ALWAYS
  // narrows (mirrors fill-det.ts; skip the mapped-files call entirely).
  const subjectScope = pair.nodePath === undefined
    ? pair.subjectFiles
    : ((await computeNodeMappedFiles(graph, pair.nodePath)).length > pair.subjectFiles.length
        ? pair.subjectFiles
        : undefined);

  // A nodeless pair carries its OWN architecture-derived unit
  // (StructureUnit.kind === 'file') instead of addressing a (nonexistent)
  // component: the subject file, its matched type, and the reach that type's
  // relations: permit — the SAME allowance fill-det.ts computes for the
  // deterministic runner, mirrored here (not shared by import — see
  // REACH_SENTINEL_FILE's doc comment above) so a companion hook gets the
  // identical read boundary a check.mjs on the same file would.
  let nodelessAllowance: { typeId: string; allowedReads: Set<string> } | undefined;
  let unit: StructureUnit;
  if (pair.nodePath === undefined) {
    const file = pair.subjectFiles[0];
    const fromType = typeCoverage?.covered.get(file) ?? '';
    const reachExtra = await reachExtraForType(fromType, typeCoverage, graph, projectRoot, reachCache);
    const allowedReads = new Set<string>([...reachExtra, file]);
    nodelessAllowance = { typeId: fromType, allowedReads };
    unit = { kind: 'file', file, typeId: fromType, allowedReads: [...allowedReads] };
  } else {
    unit = { kind: 'node', nodePath: pair.nodePath };
  }

  const runOnce = (): ReturnType<typeof runCompanionHook> =>
    runCompanionHook({
      aspectDir: aspectDirAbs,
      aspectId: aspect.id,
      unit,
      graph,
      projectRoot,
      subjectScope,
      parseCache,
    });

  // A6 taint guard: run once; a tainted set re-runs once; still tainted → infra.
  let run = await runOnce();
  if (run.kind === 'infra') {
    return { kind: 'infra', why: `companion resolution failed: ${run.messageData.what}`, messageData: run.messageData };
  }
  if (run.observationsTainted) {
    run = await runOnce();
    if (run.kind === 'infra') {
      return { kind: 'infra', why: `companion resolution failed: ${run.messageData.what}`, messageData: run.messageData };
    }
    if (run.observationsTainted) {
      const what = `Companion resolution for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} produced an inconsistent observation set across two runs.`;
      const why = 'companion observations remained inconsistent across two runs (a file changed mid-resolution); a torn set cannot be hashed, so the fill fails closed and writes NOTHING — never paying the reviewer over a torn observation set.';
      const next = 'Re-run once the working tree is stable: yg check --approve';
      return { kind: 'infra', why: 'companion observations remained inconsistent across two runs', messageData: { what, why, next } };
    }
  }

  // ── Delegate post-hook resolution to the shared helper (normalize, dedupe,
  // sort, allowed-reads guard, readFileBytes, observations merge). ──
  const resolved = await resolveCompanionDescriptors(graph, projectRoot, pair, aspect, run.descriptors, run.observations, nodelessAllowance);
  if (resolved.kind === 'infra') {
    return { kind: 'infra', why: resolved.why, messageData: resolved.messageData };
  }
  return { kind: 'ok', companions: { promptCompanions: resolved.companions, observations: resolved.observations } };
}
