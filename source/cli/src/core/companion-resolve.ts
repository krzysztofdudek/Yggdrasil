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
import type { ExpectedPair } from './pairs.js';
import { computeNodeMappedFiles } from './pairs.js';
import type { PromptCompanionInput } from '../llm/prompt.js';
import type { IssueMessage } from '../model/validation.js';
import { runCompanionHook, type RunCompanionHookResult } from '../structure/hook-loader.js';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { collectAllowedReadsForAspect } from '../structure/allowed-reads.js';
import { resolveAllowedReadPath } from '../structure/ctx-fs.js';
import { readFileBytes } from '../io/graph-fs.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import { observationKey, hashReadObservation } from './pair-hash.js';

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
 * Exported so callers (tests) can verify the exact message shape.
 */
export function companionOutsideAllowedReads(
  graph: Graph,
  pair: Pick<ExpectedPair, 'nodePath' | 'unitKey'>,
  aspect: AspectDef,
  rel: string,
): { why: string; messageData: IssueMessage } {
  const owner = buildOwnerIndex(graph.nodes).ownerOf(rel);
  const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} is outside the node's allowed-reads.`;
  const why =
    'A companion must be relation-reachable from the reviewed node — the reviewer may only see files the graph permits the node to read, so an out-of-reach companion is an infrastructure fault and the fill fails closed (NOTHING written).';
  // pair.nodePath is absent only for a nodeless (type-covered-file) pair; Task 9
  // owns that prompt/message variant — this task only widens the type so a
  // component pair's message stays byte-identical (nodePath ?? '' is a no-op
  // when nodePath is defined).
  const ownerNodePath = pair.nodePath ?? '';
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
): Promise<ResolvedCompanionDescriptorsResult> {
  // ── Normalize each returned path to repo-root-relative POSIX, dedupe + sort. ──
  // A nodeless pair has no component whose allowed-reads apply; collectAllowedReadsForAspect
  // already returns ∅ for an absent node path (allowed-reads.ts), the safe/conservative
  // reading — Task 9 owns the real nodeless companion-allowance design.
  const allowedSet = collectAllowedReadsForAspect(pair.nodePath ?? '', graph);
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
      resolveAllowedReadPath(rel, allowedSet, projectRoot);
    } catch {
      return { kind: 'infra', ...companionOutsideAllowedReads(graph, pair, aspect, rel) };
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
 */
export async function resolveCompanionsForPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
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

  const runOnce = (): ReturnType<typeof runCompanionHook> =>
    runCompanionHook({
      aspectDir: aspectDirAbs,
      aspectId: aspect.id,
      // Empty component context for a nodeless pair — matches the same
      // convention verify-lock's re-observation seed and fill-det's runner call use.
      nodePath: pair.nodePath ?? '',
      graph,
      projectRoot,
      subjectScope,
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
  const resolved = await resolveCompanionDescriptors(graph, projectRoot, pair, aspect, run.descriptors, run.observations);
  if (resolved.kind === 'infra') {
    return { kind: 'infra', why: resolved.why, messageData: resolved.messageData };
  }
  return { kind: 'ok', companions: { promptCompanions: resolved.companions, observations: resolved.observations } };
}
