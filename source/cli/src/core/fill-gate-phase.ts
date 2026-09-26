/**
 * source/cli/src/core/fill-gate-phase.ts — step 1 of the fill stage (spec §7):
 * the structural gate.
 *
 * A gating code (tier/reviewer config broken, an aspect-implies cycle, or an
 * escaping mapping) aborts the whole fill — no fills, no LLM calls. So does a
 * node log.md that is not settled — conflict markers, a rewritten history, a
 * body that does not parse — for every run except --only-deterministic and
 * --dry-run (neither records a baseline), since closure would record a baseline
 * over it. One exception: a missing reviewer does not gate a run that would
 * never call one (--only-deterministic), a preview (--dry-run), or a project
 * whose judgment rules are all advisory — the deterministic pairs still fill,
 * and the judgment pairs stay unverified with the missing reviewer named as
 * the cause.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { CheckIssue } from './check.js';
import type { TypeCoverageInput } from './pairs.js';
import { readLock } from '../io/lock-store.js';
import { validate } from './validator.js';
import { APPROVE_GATING_CODES, APPROVE_LOG_STATE_GATING_CODES } from './check-codes.js';
import { classifyLogStateFromLock } from './check-log-state.js';
import { FillGatingError } from './fill-contract.js';

export interface StructuralGateParams {
  graph: Graph;
  projectRoot: string;
  typeCoverage: TypeCoverageInput | undefined;
  onlyDeterministic: boolean;
  dryRun: boolean;
  /** The command the run was invoked as, for the "then re-run" line. */
  retry: string;
  /** See RunFillOptions.gateIssuesOnError. */
  gateIssuesOnError: boolean | undefined;
  emitIssue: (msg: IssueMessage) => void;
}

/**
 * Run the structural gate and return the committed lock it read — read once for
 * everything the run decides: the log state here, the pair classification, and
 * every verdict written. Throws FillGatingError when anything gates.
 */
export async function runStructuralGate(params: StructuralGateParams): Promise<LockFile> {
  const { graph, projectRoot, typeCoverage, onlyDeterministic, dryRun, retry, emitIssue } = params;
  const validation = await validate(graph, 'all', undefined, typeCoverage);
  // A missing reviewer leaves nothing unclear for a run that calls none: a
  // deterministic-only fill and a preview go ahead (each says what it could not
  // do), and so does a run whose judgment rules are all advisory — the check
  // reports that at warning severity, since advisory never blocks. The judgment
  // pairs stay unverified, named as having no reviewer.
  const reviewerMissingIsNoGate = (i: { code?: string; severity: string }): boolean =>
    i.code === 'config-reviewer-missing' && (onlyDeterministic || dryRun || i.severity !== 'error');
  const lock = readLock(graph.rootPath);
  // A log.md that is not settled (conflict markers, a rewritten history, a body
  // that does not parse) stops a run that could close a node's cycle before it
  // buys anything: closure would record a baseline over it. The same reading a
  // plain check makes, so the two can never disagree about which log is broken.
  // `--only-deterministic` and a `--dry-run` preview write no baseline and are
  // not stopped by it.
  const logStateIssues: CheckIssue[] = [];
  if (!onlyDeterministic && !dryRun) await classifyLogStateFromLock(graph, projectRoot, lock, logStateIssues);
  const gating = [
    ...validation.issues.filter(
      (i) => i.code !== undefined && APPROVE_GATING_CODES.has(i.code) && !reviewerMissingIsNoGate(i),
    ),
    ...logStateIssues.filter((i) => i.code !== undefined && APPROVE_LOG_STATE_GATING_CODES.has(i.code)),
  ];
  if (gating.length > 0) {
    const single = gating.length === 1;
    if (params.gateIssuesOnError !== true) {
      emitIssue({
        what: `yg check --approve aborted — ${gating.length} ${single ? 'problem' : 'problems'} must be fixed before anything runs.`,
        why: `A fill records verdicts, and ${single ? 'this problem leaves' : 'these problems leave'} it unclear what would be checked, how it would be judged, or whether doing so is safe; nothing ran and nothing was written.`,
        next: `Fix the errors below, then re-run: ${retry}`,
      });
      for (const i of gating) emitIssue(i.messageData);
    }
    throw new FillGatingError(
      gating.map((i) => ({ code: i.code!, what: i.messageData.what, why: i.messageData.why, next: i.messageData.next })),
      'structural',
      gating.map((i) => ({
        code: i.code!,
        severity: 'error',
        rule: i.rule,
        messageData: i.messageData,
        ...(i.nodePath !== undefined ? { nodePath: i.nodePath } : {}),
        ...(i.aspectId !== undefined ? { aspectId: i.aspectId } : {}),
      })),
      retry,
    );
  }
  return lock;
}
