/**
 * source/cli/src/core/check-lock-phase.ts — everything a check reports that is
 * gated on the verdict lock being readable (spec §6).
 *
 * Read the lock ONCE, verify every expected pair against it, and turn the
 * result into issues: unreadable subjects, per-pair verdicts, relation
 * conformance, the type-to-type relation gate, parser-infrastructure failures,
 * log integrity, and the mandatory-log requirement.
 *
 * A garbled / wrong-version / conflict-markered lock FAILS CLOSED: one blocking
 * lock-invalid issue and nothing else from this phase. Any other error is
 * rethrown untouched — an unreadable lock is a diagnosable state, an unexpected
 * fault is not, and swallowing the second would turn a crash into a green run.
 *
 * ── Why the relation pass is an INPUT, not something this phase runs ─────────
 * The import-resolution pass has to run BEFORE structural validation, so that a
 * rule whose applicability is gated on a file's real dependencies is answered
 * from the same resolved edges everything else reads. So the orchestrator runs
 * it once, up front, and hands the result here. But the relation-conformance and
 * type-gate ISSUES this phase derives from it are still reported only when the
 * lock is readable — exactly as when the pass itself lived inside the try block.
 * Computing earlier moved the parse; it did not move what a corrupt lock
 * suppresses.
 */

import type { Graph } from '../model/graph.js';
import type { TypeCoverageResult } from './type-coverage.js';
import type { TypeCoverageInput } from './pairs.js';
import { readLock, LockInvalidError } from '../io/lock-store.js';
import { fileUnit } from '../model/lock.js';
import { verifyLock } from './verify-lock.js';
import { toPosixPath } from '../utils/posix.js';
import type { FileFacts, RelationPassResult } from '../relations/pass.js';
import { relationRefusedMessage, typeGateForbiddenMessage } from '../relations/messages.js';
import { getLanguageDisplayName } from '../utils/language-registry.js';
import { computeTypeGateFindings } from '../relations/type-gate.js';
import { buildTypeVisibility, toAppliedPairs, toRuntimeVisibilityRows, type TypeVisibilityReport } from './type-visibility.js';
import type { CheckIssue } from './check-contract.js';
import { emitPairIssue } from './check-pair-issues.js';
import { classifyLogStateFromLock, classifyLogRequirement } from './check-log-state.js';

/** What one lock-verification phase produces for the report the orchestrator assembles. */
export interface LockPhaseResult {
  issues: CheckIssue[];
  /** Verified-pair tallies, split by reviewer kind. Both 0 when the lock is invalid. */
  verifiedDet: number;
  verifiedLlm: number;
  /** Per-file type-tier enforcement report. Undefined at flag-off, and on an invalid lock. */
  typeVisibility: TypeVisibilityReport | undefined;
  /** Per-file feature facts + content hashes, for the optional feature-field index write. */
  featureFactsByPath: Map<string, FileFacts> | null;
  featureHashByPath: Map<string, string> | null;
}

export async function runLockPhase(args: {
  graph: Graph;
  projectRoot: string;
  typeCoverageInput: TypeCoverageInput | undefined;
  earlyTypeCoverage: TypeCoverageResult | undefined;
  /** The relation pass the orchestrator already ran, ahead of validation. Never re-run here. */
  relResult: RelationPassResult;
  /** The caller's own fill→check handoff for this run, if it had one. */
  runtimeDispositions: Array<{ file: string; aspectId: string; code: string }> | undefined;
}): Promise<LockPhaseResult> {
  const { graph, projectRoot, typeCoverageInput, earlyTypeCoverage, relResult, runtimeDispositions } = args;

  // Captured from the relation pass (run once by the orchestrator, ahead of
  // validate()) for the optional feature-field index write. Stays null if the
  // lock is invalid — the pass itself already ran either way, but this capture
  // (like the relation-conformance/type-gate issues below) is still gated on a
  // readable lock, matching this field's pre-existing behavior.
  let featureFactsByPath: Map<string, FileFacts> | null = null;
  let featureHashByPath: Map<string, string> | null = null;

  // Read the lock once. A garbled/version/conflict-markered lock fails closed:
  // one blocking lock-invalid issue, SKIPPING verification + log integrity.
  const lockIssues: CheckIssue[] = [];
  // Verified-pair tally, split by reviewer kind (see CheckResult.verifiedDet/
  // verifiedLlm). Declared outside the try so a lock-invalid failure reports
  // 0/0 rather than leaving the fields undefined.
  let verifiedDet = 0;
  let verifiedLlm = 0;
  // Same lock-invalid posture as verifiedDet.
  let typeVisibility: TypeVisibilityReport | undefined;
  try {
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock, typeCoverageInput);
    const runtimeRows = toRuntimeVisibilityRows(runtimeDispositions ?? []);
    typeVisibility = earlyTypeCoverage
      ? buildTypeVisibility(graph, earlyTypeCoverage.covered, verification.drops, runtimeRows, toAppliedPairs(verification.pairs.map((vp) => vp.pair)), verification.uncomputableTypeCoverage)
      : undefined;

    // Unreadable subjects → blocking file-unreadable errors (A4 fail-closed).
    // messageData is pre-populated on UnreadableSubject by computeExpectedPairs.
    for (const u of verification.unreadable) {
      lockIssues.push({
        severity: 'error',
        code: 'file-unreadable',
        rule: 'file-unreadable',
        messageData: u.messageData,
        nodePath: u.nodePath,
        aspectId: u.aspectId,
        // Nodeless: the unit IS the file (see computeSuggestedNext's fallback).
        unitKey: u.nodePath === undefined ? fileUnit(u.path) : undefined,
      });
    }

    // Per-pair issues (verified → none; refused / unverified / prompt-too-large).
    // `emitPairIssue` emits nothing for a verified pair, so this is the only place
    // the verified/deterministic-vs-LLM split can be tallied.
    for (const vp of verification.pairs) {
      lockIssues.push(...emitPairIssue(vp, runtimeRows));
      if (vp.state.kind === 'verified') {
        if (vp.pair.kind === 'llm') verifiedLlm++;
        else verifiedDet++;
      }
    }

    // Relation-conformance, computed LIVE (parse + resolve + verify every run) —
    // reusing the SAME `relResult` the orchestrator computed ahead of validate(),
    // never a second pass. A node with an undeclared cross-node dependency blocks
    // with a relation-undeclared-dependency error. No verdict is cached — the
    // result is always the current truth.
    // Capture the per-file feature facts + content hashes for the optional feature-field
    // index write (no extra parse — this is the same pass the relation check runs).
    featureFactsByPath = relResult.factsByPath;
    featureHashByPath = relResult.hashByPath;
    for (const [nodeId, nv] of relResult.violationsByNode) {
      if (nv.verdict !== 'refused') continue;
      lockIssues.push({
        severity: 'error',
        code: 'relation-undeclared-dependency',
        rule: 'relation-undeclared-dependency',
        nodePath: nodeId,
        messageData: relationRefusedMessage(graph, nodeId, nv.violations),
      });
    }

    // Live type-to-type relation gate (coverage.type_level): a statically-resolved
    // import edge between two classified endpoints (an explicit node and/or a
    // type-covered file) has no allowed relation type under the architecture's
    // allow-list. Computed only when the lattice actually ran this call
    // (earlyTypeCoverage) — at flag-off there is nothing to gate. Live every run, same
    // posture as relation-undeclared-dependency above: never cached, never in the lock.
    if (earlyTypeCoverage) {
      const gateFindings = computeTypeGateFindings(graph.architecture, relResult.typedEdges, relResult.fileOwnerType);
      for (const finding of gateFindings) {
        lockIssues.push({
          severity: 'error',
          code: 'type-relation-forbidden',
          rule: 'type-relation-forbidden',
          messageData: typeGateForbiddenMessage(finding),
        });
      }
    }

    // Relation-conformance INFRASTRUCTURE failures: a mapped file could not be parsed
    // because its tree-sitter grammar failed to load (missing/corrupt WASM, init/load
    // rejection, or parser returned null). An unparsed file contributes NO detected
    // dependencies, so if this were swallowed the relation check would silently pass
    // over unanalyzed code — repo-wide for a whole language if its grammar is missing.
    // Fail closed: surface each as a BLOCKING error (one per affected language), so the
    // build stays red rather than going green over code no reviewer ever analyzed. This
    // is live every run (no --approve required), exactly like the rest of the check.
    for (const pf of relResult.parseFailures) {
      const lang = getLanguageDisplayName(pf.language);
      const examplePath = toPosixPath(pf.examplePath);
      const scope =
        pf.fileCount === 1
          ? examplePath
          : `${pf.fileCount} ${lang} files, e.g. ${examplePath}`;
      lockIssues.push({
        severity: 'error',
        code: 'relation-parse-failed',
        rule: 'relation-parse-failed',
        messageData: {
          what: `Could not load the ${lang} parser to check dependencies for ${scope}: ${pf.message}`,
          why: `The relation-conformance check must parse every mapped source file to find its cross-node dependencies. A file that cannot be parsed contributes no detected dependencies, so treating this as "no dependencies" would let real, undeclared dependencies pass unchecked — for every ${lang} file at once when the grammar is unavailable. The check fails closed rather than passing over code it never analyzed.`,
          next: `Reinstall the CLI to restore the bundled ${lang} language support, then re-run: yg check`,
        },
      });
    }

    // Log integrity reads its baseline from the lock (spec §9).
    await classifyLogStateFromLock(graph, projectRoot, lock, lockIssues);

    // Mandatory-log requirement (spec §9): a log_required node whose mapped
    // source changed with no fresh entry, enforced LIVE here so it bites even on
    // a node that produces no fill pairs. Skip nodes with an unreadable subject
    // (already a blocking file-unreadable error; fingerprint uncomputable).
    // Nodeless entries have no node to skip here; filtering keeps this a Set<string>.
    const unreadableNodes = new Set(
      verification.unreadable.map((u) => u.nodePath).filter((p): p is string => p !== undefined),
    );
    await classifyLogRequirement(graph, projectRoot, lock, unreadableNodes, lockIssues);
  } catch (err) {
    if (err instanceof LockInvalidError) {
      lockIssues.push({
        severity: 'error',
        code: 'lock-invalid',
        rule: 'lock-invalid',
        messageData: err.messageData,
      });
      // Fail closed: skip lock verification + log integrity.
    } else {
      throw err;
    }
  }

  return { issues: lockIssues, verifiedDet, verifiedLlm, typeVisibility, featureFactsByPath, featureHashByPath };
}
