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
import type { ExpectedPair } from './pairs.js';
import { computeNodeMappedFiles } from './pairs.js';
import { computeDetInputHash } from './pair-hash.js';
import { ruleHashFor } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { runStructureAspect, StructureRunnerError, SUPPRESS_MARKER_MALFORMED_CODE } from '../structure/runner.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { readBytesOrEmpty, type DetFillOutcome } from './fill-shared.js';

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
): Promise<DetFillOutcome> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
  // The subject is narrowed iff it covers FEWER files than the node's full
  // mapping (pair.subjectFiles ⊆ full mapping always, so a length difference is
  // an exact set difference). Both per:file and per:node-with-scope.files can
  // narrow; a plain per:node aspect has subject == full mapping → undefined.
  const fullMapping = await computeNodeMappedFiles(graph, pair.nodePath);
  const subjectScope = pair.subjectFiles.length < fullMapping.length
    ? pair.subjectFiles
    : undefined;

  const runOnce = async () => {
    try {
      return { ok: true as const, result: await runStructureAspect({
        aspectDir: aspectDirAbs,
        aspectId: aspect.id,
        nodePath: pair.nodePath,
        graph,
        projectRoot,
        subjectScope,
      }) };
    } catch (e) {
      debugWrite(`[fill] det runtime error for ${aspect.id} on ${pair.nodePath}: ${e instanceof Error ? e.message : String(e)}`);
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

export function detRuntimeNotice(aspectId: string, unitKey: string, reason: string): IssueMessage {
  return {
    what: `Deterministic check '${aspectId}' failed to run on ${toPosixPath(unitKey)} — left unverified (aspect-check-runtime-error).`,
    why: `The check.mjs crashed, returned an invalid result, or its observations changed mid-run: ${reason}`,
    next: `Fix the check.mjs, then re-run: yg check --approve`,
  };
}
