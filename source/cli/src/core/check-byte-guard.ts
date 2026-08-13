/**
 * source/cli/src/core/check-byte-guard.ts — the GATHERING half of the byte
 * guard: which of this run's obligations are worth asking the bytes about, and
 * what those bytes currently are.
 *
 * The DECIDING half is `core/progressive-scope.ts`'s
 * {@link forceInScopeOnByteMismatch}, which is pure — ids and bytes arrive as
 * plain values. This module is the seam that makes that possible: it holds the
 * one filesystem read the guard needs, so the decision itself never touches a
 * disk, a git process, or a clock. Split that way on purpose — the decision is
 * the part whose "adds scope, never removes it" property has to be provable, and
 * a function that reads files while it decides cannot be proved by a plain test.
 *
 * ── Why only these pairs ────────────────────────────────────────────────────
 * The guard exists to stop a live refusal from being re-coded as inherited debt.
 * That can only happen to a pair that (a) is about to be treated as OUTSIDE the
 * change and (b) actually produces a blocking finding. Anything else is work
 * with no possible effect: an in-scope pair already blocks, and a pair that
 * reports nothing has no finding to keep. Restricting to those two conditions is
 * also what keeps the cost honest — on a healthy repository the candidate list
 * is empty and this module reads nothing at all.
 */

import path from 'node:path';

import { readFileBytes } from '../io/graph-fs.js';
import type { VerifiedPair } from './verify-lock.js';
import { emitPairIssue } from './check-pair-issues.js';
import type { BurnSet, ByteGuardCandidate, ByteGuardSubject } from './progressive-scope.js';
import { progressivePairKey } from './progressive-scope.js';

/**
 * Does this pair produce a BLOCKING finding at all?
 *
 * Asked of `emitPairIssue` rather than re-derived from `state.kind`, because
 * that function is the single authority on what a pair's state is reported as,
 * and the mapping is not one-to-one: an ADVISORY pair's refusal is a warning
 * (which the classifier never downgrades, so guarding it would be pure noise),
 * while a pair whose stored verdict is perfectly valid still reports a blocking
 * prompt-size error when its assembled prompt outgrew the tier. A second copy of
 * that table here would drift, and every way it could drift ends in the guard
 * looking at the wrong set.
 *
 * The runtime-disposition rows are deliberately empty: they only reword an
 * unverified pair's message, never its severity, and this asks about severity.
 */
function producesBlockingFinding(vp: VerifiedPair): boolean {
  return emitPairIssue(vp, []).some((issue) => issue.severity === 'error');
}

/**
 * The obligations the byte guard should ask about, with their subject files'
 * current bytes attached.
 *
 * Returns an EMPTY list — having read nothing — whenever the guard cannot or
 * need not run: no change scope at all (the whole project is being gated), no
 * reference listing to compare against, or a scope that already went global.
 * That is what keeps a run with the feature off byte-for-byte what it always
 * was: this is a no-op with no I/O, not a cheap version of itself.
 *
 * Each subject's bytes are read at most once per run even when several pairs
 * share a file, and an unreadable file is carried as `null` rather than dropped
 * — the decision needs to SEE that a subject could not be compared, since
 * silently omitting it would let a pair with no comparable subject look
 * comparable and clean.
 */
export async function collectByteGuardCandidates(
  changeScope: { burn: BurnSet; blobOidByPath: Map<string, string> | null } | undefined,
  pairs: VerifiedPair[],
  projectRoot: string,
): Promise<ByteGuardCandidate[]> {
  if (changeScope === undefined) return [];
  if (changeScope.blobOidByPath === null) return [];
  const { burn } = changeScope;
  if (burn.global) return [];

  const bytesByPath = new Map<string, Buffer | null>();
  const readOnce = async (relPath: string): Promise<Buffer | null> => {
    // `has` rather than a truthiness test on `get`: an unreadable file caches as
    // `null`, and reading that back as a miss would re-read it once per pair.
    if (bytesByPath.has(relPath)) return bytesByPath.get(relPath)!;
    const bytes = await readFileBytes(path.resolve(projectRoot, relPath));
    bytesByPath.set(relPath, bytes);
    return bytes;
  };

  const candidates: ByteGuardCandidate[] = [];
  for (const vp of pairs) {
    const pairKey = progressivePairKey(vp.pair.aspectId, vp.pair.unitKey);
    if (burn.pairKeys.has(pairKey)) continue;
    if (!producesBlockingFinding(vp)) continue;
    const subjects: ByteGuardSubject[] = [];
    for (const subject of vp.pair.subjectFiles) {
      subjects.push({ path: subject, bytes: await readOnce(subject) });
    }
    candidates.push({ pairKey, subjects });
  }
  return candidates;
}
