import type { Graph } from '../model/graph.js';
import type { ValidationIssue } from '../model/validation.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { validate } from './validator.js';
import { checkReviewOverdue } from './checks/aspect-contracts.js';
import { checkDigestGate } from './checks/digest-gate.js';
import type { RulesArtifacts } from './checks/digest-gate.js';
import { readTextFile } from '../io/graph-fs.js';
import path from 'node:path';
import { validateAppendOnly } from './log-integrity.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from './check-codes.js';
import { validateFormat } from './log-format.js';
import { toPosixPath } from '../utils/posix.js';
import { excludeNestedGraphSubtrees, loadRootGitignoreStack, isIgnoredByStack } from '../io/repo-scanner.js';
import type { GitignoreEntry } from '../io/repo-scanner.js';
import { mappingEntryMatchesFile, normalizeMappingPath, isGlobPattern } from '../utils/mapping-path.js';
import { debugWrite } from '../utils/debug-log.js';
// ── Verdict-lock live path (spec §6) ──────────────────────────
import { readLock, LockInvalidError } from '../io/lock-store.js';
import type { LockFile } from '../model/lock.js';
import { verifyLock } from './verify-lock.js';
import type { VerifiedPair } from './verify-lock.js';
import { logGateBlocksNode } from './log/log-gate.js';
import {
  unverifiedMessage,
  llmRefusedMessage,
  detRefusedMessage,
  promptTooLargeMessage,
} from '../formatters/lock-issue-messages.js';
// ── Relation-conformance (computed live, parse + resolve every run) ──
import { runRelationPass } from '../relations/pass.js';
import type { FileFacts } from '../relations/pass.js';
import { extractorForLanguage } from '../relations/extractors/registry.js';
import { astCacheDir } from '../relations/facts-cache.js';
import { relationRefusedMessage } from '../relations/messages.js';
import { getLanguageDisplayName } from '../utils/language-registry.js';
import { makeResolvePathToFile } from '../relations/resolve-path.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
// ── Silent feature-field deviation index (L3 attention) — the writer lives HERE ONLY,
//    behind the runCheck fence (G2). cli/check.ts calls runAttentionDump, never the writer. ──
import {
  writeFeatureIndex,
  computeFamilyDeviations,
  groupByFamily,
  median,
  DIMS,
  MIN_N,
  Z_ADMIT,
} from './feature-index-write.js';

// ── Types ──────────────────────────────────────────────────

export interface CheckIssue extends Omit<ValidationIssue, 'code'> {
  /** All issues have a code -- override optional from ValidationIssue */
  code: string;
  /** For unmapped-files: uncovered file paths */
  uncoveredFiles?: string[];
  /** For unmapped-files: total count of uncovered files */
  uncoveredCount?: number;
  /** For aspect-newly-active / aspect-violation-*: the aspect this issue concerns */
  aspectId?: string;
  /**
   * For pair-derived issues (unverified / refused): the reviewer kind of the
   * pair. Lets the CLI's `--summary` view split per-node counts into
   * deterministic-free vs LLM without re-resolving the pair. Data-only — set
   * from `pair.kind`; absent on non-pair issues (coverage / log / relation /
   * structural), which the summary buckets as "other".
   */
  pairKind?: 'llm' | 'deterministic';
}

export interface CheckResult {
  projectName: string;
  nodeCount: number;
  nodeTypeCounts: Map<string, number>;
  aspectCount: number;
  flowCount: number;
  coveredFiles: number;
  totalFiles: number;
  issues: CheckIssue[];
  /** Suggested next command based on highest-priority error */
  suggestedNext: string | null;
  /** Count of aspect-violation-advisory warnings (subset of issues). Surfaced as a footer tally. */
  advisoryWarnings: number;
  /** Count of (node, aspect) pairs where the aspect resolves to effective status 'draft'. */
  draftSkipped: number;
  /**
   * Count of VERIFIED pairs whose reviewer kind is deterministic (`pair.kind === 'deterministic'`).
   * Tallied from the same `verification.pairs` loop that emits per-pair issues — `emitPairIssue`
   * emits nothing for a verified pair, so this is the only place the datum exists. Read-side only:
   * does not fold into any lock hash (frozen contract — `core/pair-hash.ts` is untouched).
   */
  verifiedDet: number;
  /** Count of VERIFIED pairs whose reviewer kind is LLM (`pair.kind === 'llm'`). See `verifiedDet`. */
  verifiedLlm: number;
}

// ── Lock verification → issue emission (live path, spec §6) ──

/** Fallback text when a refused verdict carries no stored reason. Single source of truth. */
const NO_REASON_FALLBACK = 'no violation details recorded';

/**
 * Turn a VerifiedPair into zero, one, or two CheckIssues (spec §6/§10):
 *   - verified            → no issue.
 *   - refused (enforced)  → aspect-violation-enforced (error).
 *   - refused (advisory)  → aspect-violation-advisory (warning).
 *   - unverified          → unverified (error if enforced, warning if advisory).
 *   - prompt-too-large    → prompt-too-large (error); REPLACES unverified (gate
 *                           precedence) — no duplicate unverified is emitted.
 *   - valid + oversized   → the verdict issue PLUS a prompt-too-large error
 *                           (the verdict still renders; the gate also surfaces).
 *
 * Severity follows the pair's EFFECTIVE status, recomputed live in pair.status.
 */
function emitPairIssue(vp: VerifiedPair): CheckIssue[] {
  const { pair, state } = vp;
  const issues: CheckIssue[] = [];
  const enforced = pair.status === 'enforced';

  switch (state.kind) {
    case 'verified':
      break;
    case 'refused': {
      const reason = state.reason ?? NO_REASON_FALLBACK;
      const md =
        pair.kind === 'llm'
          ? llmRefusedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey, reason })
          : detRefusedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey, reason });
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: enforced ? 'aspect-violation-enforced' : 'aspect-violation-advisory',
        rule: enforced ? 'aspect-violation-enforced' : 'aspect-violation-advisory',
        messageData: md,
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        pairKind: pair.kind,
      });
      break;
    }
    case 'unverified':
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: 'unverified',
        rule: 'unverified',
        messageData: unverifiedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey }),
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        pairKind: pair.kind,
      });
      break;
    case 'prompt-too-large':
      issues.push({
        severity: 'error',
        code: 'prompt-too-large',
        rule: 'prompt-too-large',
        messageData: promptTooLargeMessage({
          aspectId: pair.aspectId,
          unitKey: pair.unitKey,
          tierName: state.tierName,
          chars: state.chars,
          limit: state.limit,
        }),
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
      });
      break;
    case 'companion-error':
      // The companion resolver (run live to size the §4 gate) failed — the pair
      // cannot be assembled. Surface the hook's own what/why/next so the agent
      // diagnoses immediately. Enforced → error (blocks); advisory → warning.
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: 'aspect-companion-runtime-error',
        rule: 'aspect-companion-runtime-error',
        messageData: state.messageData,
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
      });
      break;
  }

  // Valid-but-oversized: the verdict issue (if any) was already pushed above;
  // additionally surface the gate error so size remedies reach the agent.
  if (vp.oversized) {
    issues.push({
      severity: 'error',
      code: 'prompt-too-large',
      rule: 'prompt-too-large',
      messageData: promptTooLargeMessage({
        aspectId: pair.aspectId,
        unitKey: pair.unitKey,
        tierName: vp.oversized.tierName,
        chars: vp.oversized.chars,
        limit: vp.oversized.limit,
      }),
      nodePath: pair.nodePath,
      aspectId: pair.aspectId,
    });
  }

  return issues;
}

/**
 * Log integrity + format for ALL nodes, reading the append-only baseline from
 * the LOCK (`lock.nodes[path].log`) instead of per-node drift state (spec §9).
 * `validateAppendOnly` / `validateFormat` logic is unchanged. Restore strings
 * reference `.yggdrasil/yg-lock.logs.json` (the committed per-node log baseline).
 */
async function classifyLogStateFromLock(
  graph: Graph,
  projectRoot: string,
  lock: LockFileForCheck,
  issues: CheckIssue[],
): Promise<void> {
  for (const [nodePath] of graph.nodes) {
    // Normalize the node path for OUTPUT (what/next message text), mirroring the sibling
    // classifyLogRequirement: nodePath is exempt from normalization only for graph-internal
    // lookups, never for values rendered into stdout-facing strings (posix-paths-output).
    const nodePathPosix = toPosixPath(nodePath);
    const logRel = `.yggdrasil/model/${nodePathPosix}/log.md`;
    const logAbs = path.join(projectRoot, logRel);
    let logContent: string | null = null;
    try {
      logContent = await readTextFile(logAbs);
    } catch { /* missing — keep null */ }

    const logBaseline = lock.nodes[nodePath]?.log;

    // Detect git conflict markers FIRST — a conflict-markered log.md cannot be
    // validated for integrity or format, and hand-stitching the two sides would
    // break the append-only integrity hashes. Route to `yg log merge-resolve`.
    //
    // DEVIATION from the JSON-lock parity check (io/lock-store.ts:145, which keys
    // off `<<<<<<<` | `=======` | `>>>>>>>`): we match ONLY the unambiguous
    // open/close markers (7 `<` or 7 `>` at line start). A bare `=======` line is
    // NOT a trigger here — `log.md` is markdown (unlike the JSON lock), where a
    // run of `=` at line start is a legitimate setext H1 underline / horizontal
    // rule and would false-positive. A markdown log body never legitimately starts
    // a line with seven `<` or `>`.
    if (logContent !== null && (/^<{7}/m.test(logContent) || /^>{7}/m.test(logContent))) {
      issues.push({
        severity: 'error',
        code: 'log-conflict',
        rule: 'log-conflict',
        messageData: {
          what: `Log contains git conflict markers at ${logRel}`,
          why: 'A conflict-markered log.md cannot be validated; hand-stitching the two sides breaks the append-only integrity hashes — the merge must be reconciled structurally.',
          next: `yg log merge-resolve --node ${nodePathPosix}`,
        },
        nodePath,
      });
      continue;
    }

    if (logBaseline) {
      const check = validateAppendOnly(
        logContent ?? '',
        logBaseline.last_entry_datetime,
        logBaseline.prefix_hash,
      );
      if (!check.ok) {
        const logIntegrityMd = {
          what: `Log integrity broken (${check.reason}) at ${logRel}${logContent === null ? ' (file missing)' : ''}`,
          why: check.reason === 'prefix_modified'
            ? 'Historical (pre-baseline) log content was modified — append-only violated.'
            : 'Baseline boundary entry not found — log was deleted or reset.',
          next: `Restore from git: git checkout HEAD -- ${logRel} .yggdrasil/yg-lock.logs.json`,
        };
        issues.push({
          severity: 'error',
          code: 'log-integrity',
          rule: 'log-integrity',
          messageData: logIntegrityMd,
          nodePath,
        });
        continue;
      }
    }

    if (logContent === null) continue;

    const violations = validateFormat(logContent);
    if (violations.length > 0) {
      const logFormatMd = {
        what: `Log format invalid at ${logRel}:\n${violations.map((v) => `  line ${v.line}: ${v.reason} — ${v.detail}`).join('\n')}`,
        why: 'Log format must be parseable for indexing and integrity.',
        next: 'Fix format violations (or git checkout) and re-run yg check.',
      };
      issues.push({
        severity: 'error',
        code: 'log-format',
        rule: 'log-format',
        messageData: logFormatMd,
        nodePath,
      });
    }
  }
}

/**
 * The mandatory-log requirement, enforced LIVE on plain `yg check` (spec §9).
 *
 * Independently of any aspect or pair state, a node whose TYPE has
 * `log_required: true` and whose mapped source fingerprint differs from the
 * lock's stored baseline (or has none yet — first verification of a node with
 * mapped source) MUST carry a fresh log entry. The requirement is a property of
 * the node TYPE plus a source change, fully DECOUPLED from whether the node has
 * any aspects or pairs — so it is detected here, read-only and at zero LLM cost,
 * not only at `--approve` fill time. This is what makes the requirement bite on a
 * node that produces NO fill pairs (all aspects draft, no effective aspects, or a
 * change touching only non-subject files): such a node is never in the fill's
 * pair-scoped node set, so without this live check an unlogged source change
 * would pass `yg check` green. `--approve` writes nothing new for it — its
 * positive closure already refuses to advance the baseline until an entry exists,
 * and its final re-check surfaces this same error.
 *
 * Reuses logGateBlocksNode — the single source of truth for the
 * freshness/fingerprint rule shared with the fill gate and positive closure.
 * Nodes with an unreadable mapped subject are skipped: they already surface a
 * blocking file-unreadable error and their fingerprint is uncomputable.
 */
async function classifyLogRequirement(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  unreadableNodes: Set<string>,
  issues: CheckIssue[],
): Promise<void> {
  for (const [nodePath, node] of graph.nodes) {
    if (unreadableNodes.has(nodePath)) continue;
    if (!(await logGateBlocksNode(graph, projectRoot, node, lock))) continue;
    issues.push({
      severity: 'error',
      code: 'log-entry-missing',
      rule: 'log-entry-missing',
      messageData: {
        what: `No fresh log entry for node '${toPosixPath(nodePath)}' — its source changed but no justification entry exists.`,
        why: `Node type '${node.meta.type}' has log_required: true — every source change needs a log entry capturing WHY. The requirement is a property of the node type plus a source change, independent of aspects; yg check stays red until a fresh entry exists.`,
        next: `yg log add --node ${toPosixPath(nodePath)} --reason '<justification>', then re-run: yg check --approve`,
      },
      nodePath,
    });
  }
}

/** Minimal shape of the lock needed by the check live path. */
interface LockFileForCheck {
  nodes: Record<string, { log?: { last_entry_datetime: string; prefix_hash: string } }>;
}

// ── Coverage scan (unmapped-files) ────────────────────────

export {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
} from './check-coverage-tiers.js';
import { partitionByCoverageTier, buildCoverageIssue, buildCoverageAdvisoryIssue } from './check-coverage-tiers.js';

/**
 * Find git-tracked files not covered by any node mapping.
 * Accepts gitTrackedFiles as parameter for testability (CLI layer calls `git ls-files`).
 * Excludes files under the bound graph's own .yggdrasil/ and under any nested-graph
 * subtree (a directory that contains its own .yggdrasil/).
 */
export function scanUncoveredFiles(graph: Graph, gitTrackedFiles: string[]): string[] {
  // Build list of all mapping paths (normalized)
  const allMappings: string[] = [];
  for (const node of graph.nodes.values()) {
    const paths = normalizeMappingPaths(node.meta.mapping);
    allMappings.push(...paths);
  }

  // Determine .yggdrasil prefix relative to project root
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));

  const uncovered: string[] = [];

  const tracked = excludeNestedGraphSubtrees(gitTrackedFiles);
  for (const file of tracked) {
    const normalized = toPosixPath(file.trim());

    // Exclude .yggdrasil/ files
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;

    // Check if covered by any mapping
    const covered = allMappings.some((mp) => mappingEntryMatchesFile(mp, normalized));

    if (!covered) {
      uncovered.push(normalized);
    }
  }

  return uncovered.sort();
}

/**
 * Detect git-tracked files that the coverage scan counts as "covered" but that
 * are silently dropped from every node's expanded subject set — a false-green.
 *
 * `expandMappingPaths` gitignore-filters the results of a DIRECTORY/GLOB mapping
 * entry (a `.gitignore`-matched file is skipped), while a DIRECTLY-NAMED
 * single-file mapping entry bypasses gitignore and is always hashed. So a file
 * that is BOTH git-tracked AND gitignored (legal: `git add -f`, or a `.gitignore`
 * rule added after the file was tracked) and is reached ONLY through a
 * directory/glob entry is claimed as covered yet produces no review pair — an
 * enforced rule passes over it without any reviewer seeing it.
 *
 * A file is a "silent drop" when ALL FOUR hold:
 *   (1) it is git-tracked (in `gitTrackedFiles`), AND
 *   (2) it is matched by at least one node's mapping entry (treated as covered), AND
 *   (3) it is gitignored (root `.gitignore`, the same machinery the hash layer uses), AND
 *   (4) it is NOT matched by any DIRECTLY-NAMED single-file mapping entry anywhere in
 *       the graph (a directly-named entry bypasses gitignore and would include it → safe).
 *
 * A mapping entry is "directly-named" for a file when it is a concrete path with no
 * glob characters whose normalized form EQUALS the normalized file path. A directory
 * entry (prefix match) or a glob entry is NOT directly-named.
 *
 * Returns the offending repo-relative POSIX paths, sorted. This is PURELY ADDITIVE:
 * it does not touch `scanUncoveredFiles` or the mapping-expansion logic.
 */
export async function scanGitignoredCoveredFiles(
  graph: Graph,
  gitTrackedFiles: string[],
): Promise<string[]> {
  // Collect all mapping entries, and separately the set of directly-named (plain,
  // non-glob) entries — the latter bypass gitignore in the hash layer.
  const allMappings: string[] = [];
  const directlyNamed = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const raw of normalizeMappingPaths(node.meta.mapping)) {
      allMappings.push(raw);
      if (!isGlobPattern(raw)) directlyNamed.add(normalizeMappingPath(raw));
    }
  }

  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));

  // Load the root .gitignore stack once (the same loader the hash/expand layer uses).
  // A failure to read it is debug-logged inside the loader and yields an empty stack —
  // no false positives (nothing is reported as gitignored).
  let gitignoreStack: GitignoreEntry[];
  try {
    gitignoreStack = await loadRootGitignoreStack(projectRoot);
  } catch (err) {
    debugWrite(`[check] scanGitignoredCoveredFiles: gitignore load failed: ${(err as Error).message}`);
    gitignoreStack = [];
  }
  if (gitignoreStack.length === 0) return [];

  const offending: string[] = [];
  const tracked = excludeNestedGraphSubtrees(gitTrackedFiles);
  for (const file of tracked) {
    const normalized = toPosixPath(file.trim());

    // (graph-self exclusion, mirrors scanUncoveredFiles)
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;

    // (2) matched by at least one node's mapping entry → counted as covered.
    if (!allMappings.some((mp) => mappingEntryMatchesFile(mp, normalized))) continue;

    // (4) a directly-named single-file entry pointing at this exact file rescues it.
    if (directlyNamed.has(normalizeMappingPath(normalized))) continue;

    // (3) gitignored under the root .gitignore (absolute path, like the hash layer).
    let ignored: boolean;
    try {
      ignored = isIgnoredByStack(path.join(projectRoot, normalized), gitignoreStack);
    } catch (err) {
      debugWrite(`[check] scanGitignoredCoveredFiles: isIgnoredByStack threw for ${normalized}: ${(err as Error).message}`);
      continue;
    }
    if (!ignored) continue;

    offending.push(normalized);
  }

  return offending.sort();
}

/**
 * Build one blocking 'mapped-file-gitignored' CheckIssue per silent-drop file.
 * Distinct what/why/next from the plain "not covered" wording — the file IS
 * matched by a mapping; the problem is the gitignore conflict that excludes it
 * from review. Structured messageData only (no buildIssueMessage in the engine —
 * the CLI layer renders it, exactly like every other coverage/structural issue).
 */
function buildGitignoredCoveredIssues(offending: string[]): CheckIssue[] {
  return offending.map((file) => ({
    severity: 'error' as const,
    code: 'mapped-file-gitignored',
    rule: 'mapped-file-gitignored',
    messageData: {
      what: `File '${file}' is git-tracked and matched by a node mapping, but is excluded from review because it matches a .gitignore pattern (and is only reached via a directory/glob mapping entry).`,
      why: 'A directory/glob mapping entry skips gitignored files, so this tracked source file produces no review subject — an enforced rule would pass over it without any reviewer seeing it (a false green).',
      next: `Un-ignore the file in .gitignore, name it directly in the node mapping (direct file entries bypass gitignore), or stop tracking it (git rm --cached ${file}), then re-run yg check.`,
    },
  }));
}

// ── Check orchestrator ────────────────────────────────────

/**
 * Run the full check (spec §6):
 *   structural validation → coverage → prompt-size gate → lock verification →
 *   relation conformance (computed LIVE) → log integrity → report.
 *
 * Aspect verdicts are validated by hashing against the lock (no LLM calls, no
 * writes — the lock is the only persisted aspect-verification state). Relation
 * conformance is NOT cached: the relation analyzer is run live every call
 * (parse + resolve + verify), so the result is always the current truth. The
 * relation pass parses source locally but is keyless / makes no LLM calls.
 *
 * @param gitTrackedFiles -- pass null to skip unmapped-files check (no git available).
 * @param options.nowUtc -- INJECTED clock for the review-cadence check (spec RZ-18).
 *        When ABSENT the aspect-review-overdue check is SKIPPED entirely: core
 *        keeps no `Date.now`, so with no clock supplied there is no overdue
 *        signal. The CLI boundary always passes `() => new Date()`; tests pin a
 *        fixed clock. It is a read-only warning — it never writes the lock,
 *        changes a verdict, or gates `--approve`.
 * @param options.writeFeatureIndex -- when true (set ONLY by cli/check.ts's report
 *        path, default false everywhere else), write the SILENT feature-field
 *        deviation index after the full issue set is computed. Best-effort and
 *        byproduct-free: it never changes the issue set or the exit code. The
 *        portal re-check and fill's dry-run pre-check never set it; fill's
 *        post-fill report forwards whatever its own caller set (true only under
 *        `yg check --approve`, which always sets it).
 * @param options.now -- INJECTED clock stamped into the index's `generatedAt`.
 * @param options.rulesArtifacts -- INJECTED snapshot of the committed
 *        rules-distribution artifacts (AGENTS.md, CLAUDE.md,
 *        .clinerules/yggdrasil.md) plus the installed CLI's canonical digest
 *        hash, for the committed-digest staleness gate. Same seam as `nowUtc`
 *        in both respects: core reads no files itself, so when ABSENT the gate
 *        is SKIPPED entirely; and, exactly like `nowUtc`, it is threaded
 *        through fill.ts into the `--approve` reports as well, so the same
 *        repo never prints one fewer warning under `yg check --approve` than
 *        under plain `yg check`. Read-only warning; never writes the lock,
 *        never gates `--approve`.
 */
// NOT EVERY FIELD BELOW IS THE SAME KIND OF THING. `nowUtc` and `rulesArtifacts`
// are ISSUE-GATING: written in the body above as `options?.<key> ? <issues> : []`,
// so an absent value silently SKIPS a check rather than erroring. `writeFeatureIndex`
// and `now` are side-effect switches deliberately set at only one call site and gate
// no issue. Every call site that invokes runCheck() must pass every issue-gating
// field — the `.yggdrasil/aspects/runcheck-injected-input-parity` deterministic
// aspect enforces this on every node that owns a runCheck call site, deriving the
// issue-gating key set straight from this file's `options?.<key> ? … : []` shape
// (see that aspect's check.mjs), so a new issue-gating field added here is picked
// up automatically without editing the aspect.
//
// ADDING AN OPTIONAL FIELD HERE? That aspect also requires every optional member
// of this interface to be CLASSIFIED, so a new gate cannot hide in a shape the
// derivation does not match. Either write the gate as the ternary above (it then
// derives automatically, and every call site must pass it), or — only if the
// field can never add, remove, or alter an ISSUE — add it to that check.mjs's
// SIDE_EFFECT_ONLY allowlist with the reason. A field that is neither is refused
// by name until someone decides which it is.
export interface RunCheckOptions {
  /** INJECTED clock for the review-cadence check (spec RZ-18). Absent ⇒ that check is skipped. */
  nowUtc?: () => Date;
  /** Write the silent feature-field deviation index after issues are computed (default false). */
  writeFeatureIndex?: boolean;
  /** INJECTED clock for the index's `generatedAt`; defaults to `() => new Date()` when writing. */
  now?: () => Date;
  /** INJECTED rules-artifacts snapshot for the committed-digest staleness gate. Absent ⇒ skipped. */
  rulesArtifacts?: RulesArtifacts;
}

export async function runCheck(
  graph: Graph,
  gitTrackedFiles: string[] | null,
  options?: RunCheckOptions,
): Promise<CheckResult> {
  const projectRoot = path.dirname(graph.rootPath);

  // 1. Validation (structural + completeness)
  const validation = await validate(graph);
  // Filter out issues without a code -- they are internal (e.g., invalid-scope).
  const validationIssues: CheckIssue[] = validation.issues
    .filter(vi => vi.code)
    .map(vi => ({ ...vi, code: vi.code! }));

  // 1b. Review-cadence (spec RZ-18): overdue is a warning computed against an
  // INJECTED clock. Absent clock ⇒ skip (no fabricated Date.now in core). Merged
  // into the issue set exactly like validationIssues; never blocks (warning) and
  // never touches the lock.
  const reviewOverdueIssues: CheckIssue[] = options?.nowUtc
    ? checkReviewOverdue(graph, options.nowUtc())
        .filter(vi => vi.code)
        .map(vi => ({ ...vi, code: vi.code! }))
    : [];

  // 1c. Committed-digest staleness gate: a read-only warning comparing the
  // committed rules-distribution artifacts against the installed CLI's
  // canonical digest. INJECTED snapshot, same seam as nowUtc — core reads no
  // files itself, so an absent snapshot skips the gate entirely. Never blocks,
  // never touches the lock.
  const digestGateIssues: CheckIssue[] = options?.rulesArtifacts
    ? checkDigestGate(options.rulesArtifacts)
        .filter(vi => vi.code)
        .map(vi => ({ ...vi, code: vi.code! }))
    : [];

  // Captured from the relation pass (run once below) for the optional feature-field index
  // write. Stay null if the lock is invalid (the pass is skipped) — the best-effort index
  // simply is not written that run.
  let featureFactsByPath: Map<string, FileFacts> | null = null;
  let featureHashByPath: Map<string, string> | null = null;

  // 2. Lock verification (replaces drift classification). Read the lock once.
  // A garbled/version/conflict-markered lock fails closed: emit one blocking
  // lock-invalid issue and SKIP lock verification + log integrity (the baseline
  // home is untrustworthy). The prompt-size gate is folded into verifyLock.
  const lockIssues: CheckIssue[] = [];
  // Verified-pair tally, split by reviewer kind (read-side projection — see
  // CheckResult.verifiedDet/verifiedLlm). Declared outside the try so a
  // lock-invalid failure (which skips verification entirely) legitimately
  // reports 0/0 rather than leaving the fields undefined.
  let verifiedDet = 0;
  let verifiedLlm = 0;
  try {
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock);

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
      });
    }

    // Per-pair issues (verified → none; refused / unverified / prompt-too-large).
    // `emitPairIssue` emits nothing for a verified pair, so this is the only place
    // the verified/deterministic-vs-LLM split can be tallied.
    for (const vp of verification.pairs) {
      lockIssues.push(...emitPairIssue(vp));
      if (vp.state.kind === 'verified') {
        if (vp.pair.kind === 'llm') verifiedLlm++;
        else verifiedDet++;
      }
    }

    // Relation-conformance, computed LIVE (parse + resolve + verify every run).
    // A node with an undeclared cross-node dependency blocks with a
    // relation-undeclared-dependency error. No verdict is cached — the result is
    // always the current truth.
    const relResult = await runRelationPass(graph, projectRoot, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(projectRoot, buildOwnerIndex(graph.nodes).ownerOf),
      // Repurposed field: now the content-addressed AST fact cache root (.ast-cache), the
      // per-file parse cache that skips the tree-sitter re-parse of unchanged files.
      symbolIndexDir: astCacheDir(graph.rootPath),
    });
    // Capture the per-file feature facts + content hashes for the optional feature-field
    // index write below (no extra parse — this is the same pass the relation check runs).
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
      const scope =
        pf.fileCount === 1
          ? pf.examplePath
          : `${pf.fileCount} ${lang} files, e.g. ${pf.examplePath}`;
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
    const unreadableNodes = new Set(verification.unreadable.map((u) => u.nodePath));
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

  // 3. Coverage scan (unmapped-files / uncovered-advisory) — unchanged.
  let coverageIssues: CheckIssue[] = [];
  let coveredFiles = 0;
  let totalFiles = 0;
  if (gitTrackedFiles !== null) {
    const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));
    const sourceFiles = excludeNestedGraphSubtrees(gitTrackedFiles).filter(f => {
      const normalized = toPosixPath(f.trim());
      return !normalized.startsWith(yggPrefix + '/') && normalized !== yggPrefix;
    });
    totalFiles = sourceFiles.length;
    const uncovered = scanUncoveredFiles(graph, gitTrackedFiles);
    const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
    const tiers = partitionByCoverageTier(uncovered, coverage);
    coveredFiles = totalFiles - (tiers.required.length + tiers.middle.length);
    coverageIssues = [
      buildCoverageIssue(tiers.required, totalFiles),
      buildCoverageAdvisoryIssue(tiers.middle),
    ].filter((x): x is CheckIssue => x !== null);

    // Additive false-green detection: files counted as covered above but silently
    // dropped from every node's subject set because they are gitignored and reached
    // only through a directory/glob mapping entry. Blocking (mapped-file-gitignored).
    const gitignoredCovered = await scanGitignoredCoveredFiles(graph, gitTrackedFiles);
    coverageIssues.push(...buildGitignoredCoveredIssues(gitignoredCovered));
  }

  // Combine all issues
  const allIssues: CheckIssue[] = [
    ...lockIssues,
    ...validationIssues,
    ...reviewOverdueIssues,
    ...digestGateIssues,
    ...coverageIssues,
  ];

  // Node type counts
  const nodeTypeCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const t = node.meta.type;
    nodeTypeCounts.set(t, (nodeTypeCounts.get(t) ?? 0) + 1);
  }

  const suggestedNext = computeSuggestedNext(allIssues);
  const advisoryWarnings = allIssues.filter(i => i.code === 'aspect-violation-advisory').length;
  const draftSkipped = countDraftAspectsAcrossGraph(graph);

  // Silent feature-field deviation index (L3 attention). Written ONLY when the CLI report
  // path requests it — AFTER the full issue set is assembled, so a write failure can never
  // change the issue set or the exit code. `writeFeatureIndex` is internally best-effort
  // (every error swallowed to debugWrite), so this never throws into the check.
  //
  // Scope the index to the repository's tracked, graph-governed universe — EXACTLY the set the
  // coverage layer governs (tracked files minus nested-graph subtrees). This keeps attention off
  // gitignored scratch or a nested-worktree copy that falls under a mapped ancestor directory.
  // With no git set available (gitTrackedFiles === null) NO index is written — honest scoping.
  if (options?.writeFeatureIndex && featureFactsByPath && featureHashByPath && gitTrackedFiles !== null) {
    const includedPaths = new Set(
      excludeNestedGraphSubtrees(gitTrackedFiles).map((f) => toPosixPath(f.trim())),
    );
    await writeFeatureIndex(graph, featureFactsByPath, featureHashByPath, includedPaths, {
      now: options.now ?? (() => new Date()),
    });
  }

  return {
    projectName: path.basename(projectRoot),
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    issues: allIssues,
    suggestedNext,
    advisoryWarnings,
    draftSkipped,
    verifiedDet,
    verifiedLlm,
  };
}

// ── Calibration instrument: `--attention-dump` (writes nothing, exits 0) ──────

/** Plain-language dimension labels for the calibration dump — deliberately NO statistics
 *  jargon (no "z-score" / "MAD" / "percentile" in any user-facing string). */
const DIM_LABEL: Record<string, string> = {
  nodeCount: 'size',
  depthQ25: 'nesting (shallow)',
  depthQ50: 'nesting (middle)',
  depthQ75: 'nesting (deep)',
  'function-like': 'functions',
  'class-like': 'classes',
  'import-like': 'imports',
  'branch-like': 'branches',
  'call-like': 'calls',
  'literal-like': 'literals',
};

/**
 * The calibration instrument behind the hidden `--attention-dump` flag. Runs the relation
 * pass over WARM shards (no new parse — it HITs the AST fact cache), computes candidate
 * deviations at the CURRENT `Z_ADMIT`, and returns a plain-language report: each file's raw
 * structural counts grouped by family, with the outliers marked "worth a closer read". It
 * writes NOTHING and makes no LLM calls — it is a read-only lens used to re-calibrate the
 * threshold. Returns the formatted string; the CLI prints it and exits 0.
 *
 * `gitTrackedFiles` scopes the universe to the same tracked, graph-governed set the written
 * index uses (the CLI layer supplies it — the same `git ls-files`-equivalent walk the report
 * path uses — so core never shells out to git). A gitignored / scratch file that falls under a
 * mapped ancestor directory is never shown.
 */
export async function runAttentionDump(graph: Graph, gitTrackedFiles: string[]): Promise<string> {
  const projectRoot = path.dirname(graph.rootPath);
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const relResult = await runRelationPass(graph, projectRoot, {
    extractorFor: extractorForLanguage,
    resolvePathToFile: makeResolvePathToFile(projectRoot, ownerOf),
    symbolIndexDir: astCacheDir(graph.rootPath),
  });
  const includedPaths = new Set(
    excludeNestedGraphSubtrees(gitTrackedFiles).map((f) => toPosixPath(f.trim())),
  );
  const deviations = computeFamilyDeviations(relResult.factsByPath, ownerOf, relResult.hashByPath, includedPaths);
  const dimGet = new Map(DIMS.map((d) => [d.dim, d.get] as const));

  // Group every parsed file's raw vector by family — the SAME grouping the index writer uses
  // (shared helper, so the dump and the written index can never drift on cohort membership).
  const families = groupByFamily(relResult.factsByPath, ownerOf, includedPaths);

  const out: string[] = [];
  out.push('Structural feature field — calibration view (read-only; nothing is written).');
  out.push('');
  out.push("Each file's raw structural counts are compared only against its node's other");
  out.push('same-language files. A file is called "worth a closer read" when it sits far from');
  out.push('its neighbours on some dimension. This is a local hint on a small sample — never a');
  out.push('verdict, and it never affects whether your build passes.');
  out.push(
    `Sensitivity in effect: ${Z_ADMIT} (higher flags fewer, more extreme files); a group needs at ` +
      `least ${MIN_N} same-language files before anything is compared at all.`,
  );
  out.push('');

  if (families.size === 0) {
    out.push('No node owns any parsed source files yet — nothing to compare.');
    return `${out.join('\n')}\n`;
  }

  for (const key of [...families.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const members = families.get(key)!;
    const [owner, language] = key.split('\x00');
    const tooFew = members.length < MIN_N;
    const note = tooFew ? ' — too few files to compare; nothing flagged here' : '';
    out.push(`${owner} · ${language}  (${members.length} file${members.length === 1 ? '' : 's'}${note})`);
    for (const m of [...members].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const c = m.fv.categories;
      out.push(`  ${m.path}`);
      out.push(
        `      size=${m.fv.nodeCount} nest=${m.fv.depthQuartiles.join('/')} ` +
          `fn=${c['function-like']} cls=${c['class-like']} imp=${c['import-like']} ` +
          `br=${c['branch-like']} call=${c['call-like']} lit=${c['literal-like']}`,
      );
      const dev = deviations.get(m.path);
      if (dev !== undefined) {
        const flags = dev.deviations.map((d) => {
          const get = dimGet.get(d.dim)!;
          const value = get(m.fv);
          const med = median(members.map((mm) => get(mm.fv)));
          const direction = value >= med ? 'high' : 'low';
          return `${DIM_LABEL[d.dim] ?? d.dim} unusually ${direction} (${value}; neighbours ~${med})`;
        });
        out.push(`      → worth a closer read: ${flags.join('; ')}`);
      }
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

// ── Internal helpers ───────────────────────────────────────

/**
 * Count UNIQUE aspect IDs whose aspect-level default status is 'draft'.
 * (Not the count of node×aspect pairs — aspects that are draft on some nodes
 * and non-draft on others are still counted once here.)
 * Surfaced as a header tally in `yg check` so the agent sees how many
 * dormant rules sit in the graph.
 */
function countDraftAspectsAcrossGraph(graph: Graph): number {
  let n = 0;
  for (const aspect of graph.aspects) {
    if ((aspect.status ?? 'enforced') === 'draft') n++;
  }
  return n;
}

/**
 * Suggest the next command based on the highest-priority error, in the §6 order:
 *   lock-invalid → unverified(enforced) → enforced refusal (three exits / fix
 *   violations, carried per-issue) → prompt-too-large → log conflict →
 *   log integrity/format → mapped-file-gitignored → structural → coverage →
 *   completeness.
 *
 * Each lock issue carries its own kind-appropriate `next` in messageData
 * (cached three-exit for an LLM refusal, fix-violations for a deterministic
 * refusal, size remedies for prompt-too-large). When no error remains, surface
 * the highest-priority warning's `next` — an advisory aspect-violation first,
 * otherwise the alphabetically-first remaining warning — so any warnings-only run
 * still points somewhere.
 */
/**
 * Among the error issues carrying a given per-aspect `code`, pick the one whose
 * `aspectId` sorts first by locale — the SAME tie-break groupIssues applies once
 * rank and label are equal. Raw emission order (pair-iteration order) is NOT
 * locale order, so a plain `.find()` here could name a different aspect than the
 * group bare `yg check --top` renders. Returns undefined when no issue matches.
 */
function pickByAspectIdLocale(errors: CheckIssue[], code: string): CheckIssue | undefined {
  const candidates = errors.filter(i => i.code === code);
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) =>
    (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en'))[0];
}

export function computeSuggestedNext(issues: CheckIssue[]): string | null {
  const errors = issues.filter(i => i.severity === 'error');
  const ASPECT_WARNING_CODES = new Set(['aspect-violation-advisory']);
  if (errors.length === 0) {
    const warnings = issues.filter(i => i.severity === 'warning');
    if (warnings.length === 0) return null;
    // Advisory aspect violations rank first among warnings (matching groupIssues'
    // label sort, where the 'advisory' label precedes every other warning label).
    // Among several advisory warnings, pick the alphabetically-first aspectId — the
    // SAME tie-break groupIssues applies once rank and label are equal — so the
    // surfaced `Next:` names the group bare `yg check --top` renders first.
    const advisoryWarnings = warnings.filter(i => ASPECT_WARNING_CODES.has(i.code));
    if (advisoryWarnings.length > 0) {
      const first = [...advisoryWarnings].sort((a, b) =>
        (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en'))[0];
      return first.messageData.next ?? null;
    }
    // No advisory violation: fall back to the highest-priority remaining warning
    // (aspect-review-overdue, high-fan-out, orphaned-aspect, …) so a warnings-only
    // run still points somewhere, per the agent-facing contract. Use the SAME
    // (code, nodePath) tie-break as the structural / "any remaining error" branches
    // below so the surfaced line stays consistent with what `--top` renders first.
    const first = [...warnings].sort((a, b) =>
      a.code.localeCompare(b.code, 'en') ||
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'))[0];
    return first.messageData.next ?? null;
  }

  // 1. lock-invalid — fail closed; restore-or-refill (its own next).
  const lockInvalid = errors.find(i => i.code === 'lock-invalid');
  if (lockInvalid) return lockInvalid.messageData.next;

  // 1b. log-entry-missing — a log_required node's source changed with no fresh
  //     entry. Outranks unverified: `--approve` is gated on the entry, so adding
  //     it is the first step before any fill can proceed.
  const logEntryMissing = errors.find(i => i.code === 'log-entry-missing');
  if (logEntryMissing) return logEntryMissing.messageData.next;

  // 2. unverified (enforced) — fill the lock.
  const unverified = errors.find(i => i.code === 'unverified');
  if (unverified) return unverified.messageData.next;

  // 3. enforced refusal (LLM three-exit OR deterministic fix-violations — the
  //    correct text is already in each issue's messageData.next).
  const enforcedRefusal = pickByAspectIdLocale(errors, 'aspect-violation-enforced');
  if (enforcedRefusal) return enforcedRefusal.messageData.next;

  // 4. prompt-too-large — size remedies.
  const promptTooLarge = pickByAspectIdLocale(errors, 'prompt-too-large');
  if (promptTooLarge) return promptTooLarge.messageData.next;

  // 4b. companion-error — companion.mjs could not resolve during the size gate;
  //     its own next carries the fix (stabilize the tree / declare the relation).
  const companionError = pickByAspectIdLocale(errors, 'aspect-companion-runtime-error');
  if (companionError) return companionError.messageData.next;

  // 5. log conflict — git conflict markers in log.md outrank integrity/format
  //    (the file cannot be validated at all; reconcile structurally first).
  const logConflict = errors.find(i => i.code === 'log-conflict');
  if (logConflict) return logConflict.messageData.next;

  // 5b. log integrity / format.
  const logIntegrity = errors.find(i => i.code === 'log-integrity');
  if (logIntegrity) {
    // Normalize the node path for the printed command (posix-paths-output): the structured
    // field stays raw, but any path written into stdout uses forward slashes.
    const node = toPosixPath(logIntegrity.nodePath ?? '<unknown>');
    const count = errors.filter(i => i.code === 'log-integrity').length;
    return `git checkout HEAD -- .yggdrasil/model/${node}/log.md .yggdrasil/yg-lock.logs.json\n  ${count} log integrity violation${count === 1 ? '' : 's'} — restore from git`;
  }
  const logFormat = errors.find(i => i.code === 'log-format');
  if (logFormat) {
    const node = toPosixPath(logFormat.nodePath ?? '<unknown>');
    const count = errors.filter(i => i.code === 'log-format').length;
    return `Edit .yggdrasil/model/${node}/log.md to fix format violations\n  ${count} log format violation${count === 1 ? '' : 's'} — post-baseline edit OR git checkout for pre-baseline`;
  }

  // 6. mapped-file-gitignored — a false-green coverage conflict. It lives in
  //    STRUCTURAL_CODES (renders as a blocking error block), but its own next
  //    carries the file-specific remedy, so surface that directly rather than the
  //    generic structural "Fix <code>" line.
  const gitignoredCovered = errors.find(i => i.code === 'mapped-file-gitignored');
  if (gitignoredCovered) return gitignoredCovered.messageData.next;

  // 7. structural. Pick the alphabetically-first structural CODE (then node),
  //    the SAME within-category tie-break groupIssues uses (label = code) — NOT
  //    validator emission order — so the group bare `yg check --top` renders is
  //    exactly the rule this line names. Emission order let the two surfaces
  //    drift (e.g. `event-unpaired` shown by --top but `yaml-invalid` named here).
  const structuralErrors = errors.filter(i => STRUCTURAL_CODES.has(i.code));
  const coverageErrors = errors.filter(i => i.code === 'unmapped-files');
  if (structuralErrors.length > 0) {
    const first = [...structuralErrors].sort((a, b) =>
      a.code.localeCompare(b.code, 'en') ||
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'))[0];
    const then = coverageErrors.length > 0
      ? `\n  Then: ${coverageErrors[0].uncoveredCount ?? 0} files need coverage`
      : '';
    return `Fix ${first.code} in ${toPosixPath(first.nodePath ?? '.yggdrasil')}\n  1 of ${structuralErrors.length} structural error${structuralErrors.length === 1 ? '' : 's'}${then}`;
  }

  // 8. coverage.
  if (coverageErrors.length > 0) {
    const count = coverageErrors[0].uncoveredCount ?? 0;
    return `yg context --file <uncovered-path>\n  ${count} file${count === 1 ? '' : 's'} need coverage — bootstrap workflow`;
  }

  // 9. completeness.
  const completenessErrors = errors.filter(i => COMPLETENESS_CODES.has(i.code));
  if (completenessErrors.length > 0) {
    const first = completenessErrors[0];
    return `Fix ${first.code} for ${toPosixPath(first.nodePath ?? '')}\n  1 of ${completenessErrors.length} completeness error${completenessErrors.length === 1 ? '' : 's'} — post-modify workflow`;
  }

  // 10. Any remaining error — architecture/strict codes outside the categories
  //     above (e.g. type-undefined, parent-type-forbidden, mapping-path-missing,
  //     type-strict-*). Each carries its own actionable `next`. Pick the
  //     alphabetically-first by code then node — the SAME tie-break groupIssues
  //     uses — so the group bare `yg check --top` renders is the group this line
  //     names even here. Without this the line would be null while `--top` still
  //     rendered that group, breaking the bare-`--top` == `Next:` invariant.
  const otherErrors = [...errors].sort((a, b) =>
    a.code.localeCompare(b.code, 'en') ||
    (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
  if (otherErrors.length > 0) return otherErrors[0].messageData.next;

  return null;
}
