/**
 * source/cli/src/core/check-json.ts — the check result as one machine document.
 *
 * A pure projection of the SAME `CheckResult` the text report renders: it reads
 * the finished result and reshapes it, deriving nothing of its own and deciding
 * nothing. That is what keeps the two views from disagreeing — a count in the
 * document and the count in the header are the same number read twice, never
 * two computations that have to agree.
 *
 * The document's counts are always the TRUE ones for the whole run. The text
 * view's narrowing flags (`--top`, `--summary`, `--aspect`, `--details`) exist to
 * shorten a wall of prose; there is no wall here to shorten, and a narrowed
 * document would read as a smaller problem rather than a smaller rendering.
 */

import type { CheckResult, CheckIssue } from './check-contract.js';
import type { VerifiedPair } from './verify-lock.js';
import { CHECK_JSON_SCHEMA } from '../formatters/check-json.js';
import type {
  CheckJsonDocument,
  CheckJsonIssue,
  CheckJsonJudge,
  CheckJsonPair,
  CheckJsonProgressive,
  CheckJsonVerdict,
  CheckJsonViolation,
  CheckJsonEdge,
} from '../formatters/check-json.js';
import { toPosixPath } from '../utils/posix.js';

/** Every verdict word the document can carry, so the totals map is always complete. */
const VERDICT_WORDS: CheckJsonVerdict[] = [
  'approved',
  'refused',
  'unverified',
  'stale',
  'prompt-too-large',
  'companion-error',
];

/** What the lock says about one pair, in the document's own vocabulary. */
function verdictOf(vp: VerifiedPair): CheckJsonVerdict {
  switch (vp.state.kind) {
    case 'verified':
      return 'approved';
    case 'refused':
      return 'refused';
    case 'prompt-too-large':
      return 'prompt-too-large';
    case 'companion-error':
      return 'companion-error';
    default:
      // `unverified` splits in two: an entry that exists but no longer hashes to
      // its inputs was judged once over code that has since moved; one the lock
      // has never seen was never judged at all.
      return vp.stale === true ? 'stale' : 'unverified';
  }
}

/**
 * Who answered for this pair.
 *
 * A local check answers as itself. A verdict recorded outside the configured
 * reviewer answers under its judge's name — the fact `yg check`'s own report
 * states, carried here so a consumer never has to read the lock to learn it.
 * Everything else answers as the reviewer tier the rule resolves to, which is
 * the only part of a tier a verdict's identity folds in — read off the pair,
 * where the verification that recomputed the hash already put it, never
 * resolved a second time here.
 */
function reviewerOf(vp: VerifiedPair): string | null {
  if (vp.pair.kind === 'deterministic') return 'deterministic';
  if (vp.judge !== undefined) return vp.judge.name;
  return vp.tierName ?? null;
}

/** One pair, projected. */
function pairOf(vp: VerifiedPair): CheckJsonPair {
  const unitKey = toPosixPath(vp.pair.unitKey);
  const sep = unitKey.indexOf(':');
  const row: CheckJsonPair = {
    aspect: vp.pair.aspectId,
    unit: {
      kind: unitKey.startsWith('node:') ? 'node' : 'file',
      path: sep >= 0 ? unitKey.slice(sep + 1) : unitKey,
    },
    node: vp.pair.nodePath === undefined ? null : toPosixPath(vp.pair.nodePath),
    kind: vp.pair.kind,
    status: vp.pair.status,
    verdict: verdictOf(vp),
    reviewer: reviewerOf(vp),
    hash: vp.recordedHash ?? null,
    // A deterministic pair never carries filled data — enforced here rather
    // than trusted from the input, since the writer never records one for a
    // deterministic entry to begin with (see fill-writer's setEntry).
    filled:
      vp.pair.kind === 'deterministic' || vp.filled === undefined
        ? null
        : { ts: vp.filled.ts, sha: vp.filled.sha ?? null },
  };
  if (vp.state.kind === 'refused' && vp.state.reason !== undefined) row.report = vp.state.reason;
  return row;
}

/** One finding, projected — the structured message, never the rendered block. */
/** Codes whose `what` lists a script rule's violations under a `Violations:` line. */
const VIOLATION_CODES = new Set(['aspect-violation-enforced', 'aspect-violation-advisory']);

/**
 * A script refusal's violations, read back out of the report its check wrote:
 * each `<file>:<line>: <message>` line after `Violations:` is one violation;
 * a line that does not start a new one (an expected/actual pair a check
 * printed under its message) belongs to the violation above it.
 */
function violationsOf(what: string): CheckJsonViolation[] | undefined {
  const lines = what.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Violations:');
  if (start < 0) return undefined;
  const out: CheckJsonViolation[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const m = /^\s*(.+?):(\d+): (.*)$/.exec(line);
    if (m !== null) {
      out.push({ file: toPosixPath(m[1]), line: Number(m[2]), message: m[3] });
    } else if (out.length > 0) {
      out[out.length - 1].message += `\n${line.trim()}`;
    } else {
      out.push({ file: '', line: null, message: line.trim() });
    }
  }
  return out;
}

/**
 * The edges a relation finding is about: the undeclared-dependency list
 * (`<file>:<line> → <node>` per line of `what`), or the type-relation gate's
 * own structured edge list.
 */
function edgesOf(issue: CheckIssue): CheckJsonEdge[] | undefined {
  if (issue.relationEdges !== undefined && issue.relationEdges.length > 0 && issue.code !== 'strict-overlap-conflict') {
    return issue.relationEdges.map((e) => ({ file: toPosixPath(e.fromFile), line: null, target: toPosixPath(e.toFile) }));
  }
  if (issue.code !== 'relation-undeclared-dependency') return undefined;
  const out: CheckJsonEdge[] = [];
  for (const line of issue.messageData.what.split('\n').slice(1)) {
    const m = /^\s*(.+?):(\d+)\s+→\s+(\S+)/.exec(line);
    if (m !== null) out.push({ file: toPosixPath(m[1]), line: Number(m[2]), target: toPosixPath(m[3]) });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * A refusal's violations as structured rows — the list its `what` carries
 * under `Violations:` — or undefined for any other finding. One reader of that
 * list, shared by the text report and this document, so the two can never
 * list different violations.
 */
export function issueViolations(issue: CheckIssue): CheckJsonViolation[] | undefined {
  if (!VIOLATION_CODES.has(issue.code) && !VIOLATION_CODES.has(issue.code.replace(/-outside$/, ''))) return undefined;
  return violationsOf(issue.messageData.what);
}

function issueOf(issue: CheckIssue): CheckJsonIssue {
  const row: CheckJsonIssue = {
    code: issue.code,
    severity: issue.severity === 'error' ? 'error' : 'warning',
    what: issue.messageData.what,
    why: issue.messageData.why,
    next: issue.messageData.next,
  };
  if (issue.aspectId !== undefined) row.aspect = issue.aspectId;
  if (issue.nodePath !== undefined) row.node = toPosixPath(issue.nodePath);
  if (issue.unitKey !== undefined) row.unit = toPosixPath(issue.unitKey);
  if (issue.unverifiedCause !== undefined) row.cause = issue.unverifiedCause;
  if (issue.unitKey !== undefined) {
    const unitKey = toPosixPath(issue.unitKey);
    const sep = unitKey.indexOf(':');
    if (sep > 0) row.unitRef = { kind: unitKey.startsWith('node:') ? 'node' : 'file', path: unitKey.slice(sep + 1) };
  }
  const violations = issueViolations(issue);
  if (violations !== undefined) row.violations = violations;
  const edges = edgesOf(issue);
  if (edges !== undefined) row.edges = edges;
  if (issue.uncoveredFiles !== undefined) row.files = issue.uncoveredFiles.map(toPosixPath);
  return row;
}

/** One finding projected into its machine form — exported for a caller reporting findings outside a finished run (an aborted fill). */
export function checkJsonIssueOf(issue: CheckIssue): CheckJsonIssue {
  return issueOf(issue);
}

/**
 * Why the run leaves the exit code it leaves — one sentence, derived from the
 * same issue set the code itself is derived from, so the two can never disagree.
 */
function exitReason(errors: number, warnings: number): string {
  if (errors > 0) {
    return `${errors} blocking finding${errors === 1 ? '' : 's'}${warnings > 0 ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`;
  }
  if (warnings > 0) {
    return `Nothing blocks this run; ${warnings} warning${warnings === 1 ? '' : 's'} reported.`;
  }
  return 'Nothing blocks this run, and nothing was reported.';
}

/** What the run stands on that the change never touched, or null on a project that measures nothing. */
function progressiveOf(result: CheckResult): CheckJsonProgressive | null {
  const measured =
    result.progressiveReference !== undefined ||
    result.outsideCount !== undefined ||
    result.baselineNoise !== undefined;
  if (!measured) return null;
  return {
    reference: result.progressiveReference ?? null,
    changedInputs: result.changedInputCount ?? null,
    outside: result.outsideCount ?? null,
    byteGuardKept: result.byteGuardKept ?? null,
    byteGuardUnavailable: result.byteGuardUnavailable === true,
    noiseFloor: result.baselineNoise
      ? { advisory: result.baselineNoise.advisory, enforcedOutside: result.baselineNoise.enforcedOutside }
      : null,
  };
}

/** Project one finished check result into its `yg-check/1` document. */
export function buildCheckJson(result: CheckResult): CheckJsonDocument {
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');

  const pairs = result.pairs.map(pairOf);

  const verdicts = Object.fromEntries(VERDICT_WORDS.map((w) => [w, 0])) as Record<CheckJsonVerdict, number>;
  for (const p of pairs) verdicts[p.verdict] += 1;

  const judgeCounts = new Map<string, number>();
  for (const vp of result.pairs) {
    if (vp.judge === undefined) continue;
    judgeCounts.set(vp.judge.name, (judgeCounts.get(vp.judge.name) ?? 0) + 1);
  }
  const judges: CheckJsonJudge[] = [...judgeCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => ({ name, pairs: count }));

  return {
    schema: CHECK_JSON_SCHEMA,
    project: {
      name: result.projectName,
      nodes: result.nodeCount,
      aspects: result.aspectCount,
      flows: result.flowCount,
    },
    exit: {
      code: errors.length > 0 ? 1 : 0,
      status: errors.length > 0 ? 'fail' : 'pass',
      reason: exitReason(errors.length, warnings.length),
    },
    coverage: {
      files: result.totalFiles,
      covered: result.coveredFiles,
      nodeOwned: result.typeLevel ? (result.nodeOwnedFiles ?? 0) : null,
      typeCovered: result.typeLevel ? (result.typeCoveredCount ?? 0) : null,
      excluded: result.typeLevel ? (result.excludedFiles ?? 0) : null,
      requiresNothing: result.coverageRequiresNothing === true,
    },
    totals: {
      errors: errors.length,
      warnings: warnings.length,
      draftSkipped: result.draftSkipped,
      verdicts,
      verified: { deterministic: result.verifiedDet, llm: result.verifiedLlm },
    },
    pairs,
    issues: result.issues.map(issueOf),
    judges,
    progressive: progressiveOf(result),
    // The step is the report's own: the command layer sets it from the findings.
    suggestedNext: null,
  };
}
