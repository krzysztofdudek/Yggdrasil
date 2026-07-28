import type { Graph } from '../model/graph.js';
import type { ValidationIssue } from '../model/validation.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { computeTypeCoverage } from './type-coverage.js';
import type { TypeCoverageResult } from './type-coverage.js';
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
import { mappingEntryMatchesFile, isGlobPattern, normalizeMappingPath } from '../utils/mapping-path.js';
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
import { relationRefusedMessage, typeGateForbiddenMessage } from '../relations/messages.js';
import { getLanguageDisplayName } from '../utils/language-registry.js';
import { makeResolvePathToFile } from '../relations/resolve-path.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import { computeTypeGateFindings } from '../relations/type-gate.js';
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
  /**
   * Whether `coverage.type_level` was on for this run. Gates the header's
   * node-owned/type-covered split and the zero-classifying-types notice —
   * both flag-on-only surfaces. Optional (absent/false = flag off) so every
   * pre-existing `CheckResult` literal built before this field existed keeps
   * rendering byte-identically to today.
   */
  typeLevel?: boolean;
  /**
   * Count of files silently satisfied by the type-level classification
   * lattice (`TypeCoverageResult.covered.size`) — matched by exactly one
   * classifying type's `when`, no node, no issue raised. 0 when the flag is
   * off or the coverage scan did not run (`coverageVisibleFiles === null`).
   */
  typeCoveredCount?: number;
  /**
   * Count of architecture types that declare `when:` (the classifying
   * subset of `graph.architecture.node_types`) — computed regardless of the
   * flag or file-walk availability, since it is a pure architecture fact.
   * `typeLevel` on with this at 0 means `coverage.type_level` can never match
   * a single file (classifyFile skips every type without `when`), which is
   * exactly the standing notice's trigger.
   */
  classifyingTypeCount?: number;
  /**
   * Count of files actually owned by a node mapping — `totalFiles minus`
   * `scanUncoveredFiles(...).length`. Distinct from `coveredFiles` (above),
   * which also folds in files under a `coverage.excluded` root: `coveredFiles`
   * keeps its pre-existing conflated meaning for the flag-off header and for
   * `portal/extract.ts`'s `meta.counts`, neither of which this field touches.
   * This field exists so the flag-on header's "node-owned" term never claims
   * ownership for a file no node actually maps.
   */
  nodeOwnedFiles?: number;
  /**
   * Count of uncovered files sitting under a `coverage.excluded` root —
   * `scanUncoveredFiles(...).length minus (required tier + middle tier)`,
   * the files `partitionByCoverageTier` drops silently. `coveredFiles ===`
   * `nodeOwnedFiles + excludedFiles` always holds; kept as its own field
   * (rather than derived by subtraction at render time) so a rendering bug
   * can never manufacture a negative or otherwise inconsistent count.
   */
  excludedFiles?: number;
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
 * lock's stored baseline (or has none yet) MUST carry a fresh log entry. The
 * requirement is a property of node TYPE plus a source change, fully DECOUPLED
 * from whether the node has any aspects or pairs — detected here, read-only and
 * at zero LLM cost, not only at `--approve` fill time. This is what makes the
 * requirement bite on a node that produces NO fill pairs (all aspects draft, no
 * effective aspects, or a change touching only non-subject files): such a node
 * is never in the fill's pair-scoped node set, so without this live check an
 * unlogged source change would pass `yg check` green. `--approve` writes
 * nothing new for it — positive closure already refuses to advance the
 * baseline until an entry exists, and the final re-check surfaces this error.
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
import {
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
  checkRequiredShadowedByExcluded,
} from './check-coverage-tiers.js';

/**
 * Find coverage-visible files not covered by any node mapping.
 * Accepts the coverage-visible file list — the CLI layer supplies `walkRepoFiles`
 * output; git is consulted only by the tracked∩gitignored anomaly check
 * (`scanTrackedButIgnored` below), the one remaining git consumer in this surface.
 * Excludes files under the bound graph's own .yggdrasil/ and under any nested-graph
 * subtree (a directory that contains its own .yggdrasil/).
 */
export function scanUncoveredFiles(graph: Graph, coverageVisibleFiles: string[]): string[] {
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

  const tracked = excludeNestedGraphSubtrees(coverageVisibleFiles);
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
 * Detect a git-tracked file that is POSITIVELY gitignored — the tracked∩gitignored
 * anomaly. `walkRepoFiles` and `expandMappingPaths`' directory/glob expansion are
 * plain disk walks that skip anything `.gitignore` excludes; neither consults the
 * git index. So a tracked-but-gitignored file (legal via `git add -f`, or a later
 * `.gitignore` rule) is invisible to coverage/classification/enforcement — a false
 * green, regardless of node mapping.
 *
 * A tracked file absent from the walk is only a CANDIDATE (the walk also skips
 * symlinks, `.git`, and the top-level `.yggdrasil/`, none of which are this
 * check's business) — reported only after a POSITIVE match against the real root
 * `.gitignore` stack; absent for any other reason is silently skipped.
 *
 * `trackedFiles` is the ONE injected git-derived input here (`listGitTrackedFiles`);
 * `walkedFiles` is the same disk-walk output every other coverage check reads.
 * `trackedFiles === null` (git absent, or the probe failed) silently skips this
 * check — best-effort, never a reason to fail `yg check`. No root `.gitignore` ⇒
 * nothing to match, so skipped rather than guessing.
 *
 * Severity mirrors the coverage tiers via `partitionByCoverageTier`'s absolute-
 * exclusion authority (isExcludedByCoverage): error under `coverage.required`,
 * warning otherwise, NO issue when `coverage.excluded` matches.
 *
 * Exemption: a file named DIRECTLY (exact, not glob/directory) in a mapping is
 * reviewed regardless of gitignore status (`expandMappingPaths` only consults
 * `.gitignore` for directory/glob expansion) — `file-mapping-gitignored`
 * (checks/mapping.ts) already owns that shape; flagging it again would give
 * contradictory fixes for one file.
 */
export async function scanTrackedButIgnored(
  graph: Graph,
  trackedFiles: string[] | null,
  walkedFiles: string[],
): Promise<CheckIssue[]> {
  if (trackedFiles === null) return [];
  const walked = new Set(walkedFiles.map((f) => toPosixPath(f.trim())));

  // Files named DIRECTLY (non-glob, exact path match) in any node's mapping —
  // exempt; see the doc comment above.
  const literalMappingEntries = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const entry of node.meta.mapping ?? []) {
      if (isGlobPattern(entry)) continue;
      literalMappingEntries.add(normalizeMappingPath(entry));
    }
  }

  // Candidates: tracked, not walk-visible, not the graph's own directory
  // (walk-excluded by design, not by gitignore), and not directly mapped
  // (already enforced regardless of gitignore status).
  const candidates = excludeNestedGraphSubtrees(trackedFiles)
    .map((file) => toPosixPath(file.trim()))
    .filter(
      (p) =>
        !walked.has(p) &&
        p !== '.yggdrasil' &&
        !p.startsWith('.yggdrasil/') &&
        !literalMappingEntries.has(p),
    );
  if (candidates.length === 0) return [];

  const projectRoot = path.dirname(graph.rootPath);
  let gitignoreStack: GitignoreEntry[];
  try {
    gitignoreStack = await loadRootGitignoreStack(projectRoot);
  } catch (err) {
    debugWrite(`[check] scanTrackedButIgnored: gitignore load failed: ${(err as Error).message}`);
    gitignoreStack = [];
  }
  if (gitignoreStack.length === 0) return [];

  const ignoredFiles: string[] = [];
  for (const p of candidates) {
    let ignored: boolean;
    try {
      ignored = isIgnoredByStack(path.join(projectRoot, p), gitignoreStack);
    } catch (err) {
      debugWrite(`[check] scanTrackedButIgnored: isIgnoredByStack threw for ${p}: ${(err as Error).message}`);
      continue;
    }
    if (!ignored) continue; // walk-absent for some OTHER reason — not this check's business
    ignoredFiles.push(p);
  }
  if (ignoredFiles.length === 0) return [];

  // ONE exclusion authority: route through the same absolute-exclusion tier
  // split every other coverage check uses, rather than a second, independent
  // `required`-only test that (before this fix) ignored `coverage.excluded`.
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
  const tiers = partitionByCoverageTier(ignoredFiles, coverage);

  const buildIssue = (p: string, severity: 'error' | 'warning'): CheckIssue => ({
    severity,
    code: 'tracked-file-gitignored',
    rule: 'tracked-file-gitignored',
    messageData: {
      what: `File '${p}' is committed to git but matched by .gitignore — it is invisible to every coverage and enforcement layer.`,
      why: 'The repository ships this file, yet the disk walk that feeds coverage, classification, and enforcement skips gitignored paths. Code that ships but nothing can see is a false green.',
      next: `Either un-ignore the file (remove the .gitignore rule) or untrack it (git rm --cached '${p}').`,
    },
  });

  return [
    ...tiers.required.map((p) => buildIssue(p, 'error')),
    ...tiers.middle.map((p) => buildIssue(p, 'warning')),
  ];
}

/**
 * Type-level coverage (coverage.type_level) enrichment: a file matching no
 * classifying type has no type-specific fix — the plain "add it to a node
 * mapping" advice is all there is, now said explicitly, with a `yg
 * type-suggest` pointer in NEXT (actionable, not folded into WHY).
 *
 * Callers MUST call this only when every listed file actually ran through the
 * lattice and came back `unmatched`. The excluded-ancestor-of-required corner
 * that once needed a separate check is now impossible (exclusion is absolute,
 * so a file can never be muted from classification yet still land in a
 * coverage tier). A muted file was never checked against any type; claiming
 * "your architecture has no type for this file" would be unestablished.
 * Returns `issue` unchanged when null.
 */
function enrichNoTypeMessage(issue: CheckIssue | null): CheckIssue | null {
  if (issue === null) return issue;
  // Appended to the FIRST line of `next`, not a new trailing line: the
  // renderer for this issue shape (renderUnmappedBlock, cli/check.ts) shows
  // only next.split('\n')[0] — a later line would never reach the terminal.
  const nextLines = issue.messageData.next.split('\n');
  nextLines[0] =
    `${nextLines[0]} yg type-suggest --file <path> can help design one before you decide where it belongs.`;
  return {
    ...issue,
    messageData: {
      ...issue.messageData,
      why: `${issue.messageData.why} Your architecture has no type for this file yet.`,
      next: nextLines.join('\n'),
    },
  };
}

// ── Check orchestrator ────────────────────────────────────

/**
 * Run the full check (spec §6): structural validation → coverage → prompt-size
 * gate → lock verification → relation conformance (LIVE) → log integrity → report.
 *
 * Aspect verdicts are validated by hashing against the lock (no LLM calls, no
 * writes — the lock is the only persisted aspect-verification state). Relation
 * conformance is NOT cached: it runs live every call (parse + resolve + verify,
 * keyless, no LLM calls), so the result is always current.
 *
 * @param coverageVisibleFiles -- coverage-visible file list (CLI's
 *        `walkRepoFiles` output, gitignore-aware/git-independent). Null skips
 *        the coverage section. NOT git-derived — see `options.trackedFiles`.
 * @param options.trackedFiles -- INJECTED real `git ls-files` output, for the
 *        tracked∩gitignored anomaly check (`scanTrackedButIgnored`), the ONE
 *        remaining git consumer here. Absent/null skips just that check.
 * @param options.nowUtc -- INJECTED clock for the review-cadence check (spec
 *        RZ-18); absent skips it (core keeps no `Date.now`). Read-only —
 *        never writes the lock, changes a verdict, or gates `--approve`.
 * @param options.writeFeatureIndex -- true only from cli/check.ts's report
 *        path: write the SILENT feature-field deviation index after the issue
 *        set is computed. Best-effort, byproduct-free — never changes the
 *        issue set or exit code.
 * @param options.now -- INJECTED clock stamped into the index's `generatedAt`.
 * @param options.rulesArtifacts -- INJECTED snapshot of the committed rules-
 *        distribution artifacts plus the installed CLI's canonical digest, for
 *        the committed-digest staleness gate; same absence-skips seam as
 *        `nowUtc`, also threaded through `--approve` reports. Read-only.
 */
// NOT EVERY FIELD BELOW IS THE SAME KIND OF THING. `nowUtc`, `rulesArtifacts`, and
// `trackedFiles` are ISSUE-GATING: written above as `options?.<key> ? <issues> :
// []`, so an absent value silently SKIPS a check rather than erroring.
// `writeFeatureIndex`/`now` are side-effect switches, set at only one call site,
// gating no issue. Every runCheck() call site must pass every issue-gating field —
// the `.yggdrasil/aspects/runcheck-injected-input-parity` deterministic aspect
// enforces this on every node owning a call site, deriving the issue-gating key
// set straight from this file's ternary shape (see that aspect's check.mjs), so a
// new issue-gating field is picked up automatically, no aspect edit needed.
//
// ADDING AN OPTIONAL FIELD HERE? That aspect requires every optional member of
// this interface to be CLASSIFIED, so a new gate cannot hide in an unmatched
// shape. Either write it as the ternary above (derives automatically, every call
// site must pass it), or — only if it can never add/remove/alter an ISSUE — add
// it to that check.mjs's SIDE_EFFECT_ONLY allowlist with the reason. A field that
// is neither is refused by name until classified.
export interface RunCheckOptions {
  /** INJECTED clock for the review-cadence check (spec RZ-18). Absent ⇒ that check is skipped. */
  nowUtc?: () => Date;
  /** Write the silent feature-field deviation index after issues are computed (default false). */
  writeFeatureIndex?: boolean;
  /** INJECTED clock for the index's `generatedAt`; defaults to `() => new Date()` when writing. */
  now?: () => Date;
  /** INJECTED rules-artifacts snapshot for the committed-digest staleness gate. Absent ⇒ skipped. */
  rulesArtifacts?: RulesArtifacts;
  /**
   * INJECTED real `git ls-files` output (null when git is absent or the probe
   * failed), for the tracked∩gitignored anomaly check. Absent or null ⇒ that
   * one check is skipped — core reads no git itself, and every other coverage
   * check is fed entirely by `coverageVisibleFiles` (the disk walk), unaffected.
   */
  trackedFiles?: string[] | null;
}

export async function runCheck(
  graph: Graph,
  coverageVisibleFiles: string[] | null,
  options?: RunCheckOptions,
): Promise<CheckResult> {
  const projectRoot = path.dirname(graph.rootPath);
  // Shared across validate() and computeTypeCoverage() below so an uncovered
  // file's content is read at most once per check run, instead of once per
  // consumer.
  const sharedContentCache = new FileContentCache();

  // 1. Validation (structural + completeness)
  const validation = await validate(graph, 'all', sharedContentCache);
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

  // Coverage config, resolved here (moved up from section 3 below) so the type-level
  // lattice can be computed before the relation pass runs, which needs to know which
  // files are type-covered before it can widen its own file enumeration.
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;

  // The type-level classification lattice (coverage.type_level), computed ONCE here —
  // the single source every later consumer in this run reads: the relation pass below
  // (widened file enumeration + the live type-relation gate's edge index) AND section
  // 3's own coverage rendering, which reuses this SAME value instead of paying for a
  // second full lattice pass over every uncovered file. Undefined at flag-off or when no
  // file walk ran this call (coverageVisibleFiles === null) — both consumers already
  // treat that as "nothing to do."
  let earlyTypeCoverage: TypeCoverageResult | undefined;
  if (coverageVisibleFiles !== null && coverage.typeLevel) {
    const uncoveredForGate = scanUncoveredFiles(graph, coverageVisibleFiles);
    earlyTypeCoverage = await computeTypeCoverage(graph, uncoveredForGate, sharedContentCache);
  }

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
      // Undefined at flag-off or no-git (earlyTypeCoverage above) -> the pass's own
      // type-covered enumeration loop does nothing, zero added parse cost (R3).
      typeCoveredFiles: earlyTypeCoverage?.covered,
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

  // 3. Coverage scan (unmapped-files / uncovered-advisory), plus the
  // type-level classification lattice (coverage.type_level) when opted in.
  let coveredFiles = 0;
  let totalFiles = 0;
  let typeCoveredCount = 0;
  let nodeOwnedFiles = 0;
  let excludedFiles = 0;
  // `coverage` is resolved earlier (before section 2 / the relation pass) — see its
  // declaration above and earlyTypeCoverage's own comment for why.
  // Pure config check — fires on EVERY run regardless of walk availability
  // or the type-level flag. Seeds coverageIssues (rather than an empty-array
  // declaration pushed into later): the coverageVisibleFiles branch below
  // reassigns coverageIssues wholesale, so a later push here would be
  // silently discarded.
  let coverageIssues: CheckIssue[] = checkRequiredShadowedByExcluded(coverage);
  const typeLevel = coverage.typeLevel === true;
  // Pure architecture fact — independent of the flag and of file-walk
  // availability — so the zero-classifying-types notice can fire even when
  // coverageVisibleFiles is null (no coverage scan ran this call). classifyFile
  // skips every type without `when` (core/type-classifier.ts), so this count
  // staying 0 with the flag on means the lattice can never match a file.
  const classifyingTypeCount = Object.values(graph.architecture.node_types).filter(
    (t) => t.when !== undefined,
  ).length;
  if (coverageVisibleFiles !== null) {
    const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));
    const sourceFiles = excludeNestedGraphSubtrees(coverageVisibleFiles).filter(f => {
      const normalized = toPosixPath(f.trim());
      return !normalized.startsWith(yggPrefix + '/') && normalized !== yggPrefix;
    });
    totalFiles = sourceFiles.length;
    const uncovered = scanUncoveredFiles(graph, coverageVisibleFiles);
    const tiers = partitionByCoverageTier(uncovered, coverage);
    // coveredFiles/totalFiles keep their pre-existing conflated meaning
    // (node-mapped OR excluded, both counted "covered") — the flag-off
    // header and portal/extract.ts's meta.counts both read this unchanged.
    coveredFiles = totalFiles - (tiers.required.length + tiers.middle.length);
    // nodeOwnedFiles/excludedFiles split that same total honestly: a file is
    // node-owned only if an actual node mapping covers it (not in `uncovered`
    // at all); an excluded-root file is neither required nor middle tier but
    // IS in `uncovered` — partitionByCoverageTier drops it silently, so it is
    // recovered here by subtraction. nodeOwnedFiles + excludedFiles ===
    // coveredFiles always.
    nodeOwnedFiles = totalFiles - uncovered.length;
    excludedFiles = uncovered.length - (tiers.required.length + tiers.middle.length);

    // Type-level classification lattice: OFF (the default) ⇒ this block never
    // runs and requiredForIssue/middleForIssue stay the untouched tiers with no
    // extra issue added — byte-identical to pre-type-level output.
    let requiredForIssue = tiers.required;
    let middleForIssue = tiers.middle;
    const typeLevelIssues: CheckIssue[] = [];
    let sawTypeLevel = false;
    if (coverage.typeLevel && earlyTypeCoverage) {
      sawTypeLevel = true;
      // Reuse the SAME lattice result computed earlier (before the relation pass) —
      // no second full classification pass over every uncovered file.
      const typeCoverage = earlyTypeCoverage;
      typeCoveredCount = typeCoverage.covered.size;

      // The lattice is one issue per file, most-binding wins: covered/
      // ambiguous/strict-claimed/unreadable files each already have their own
      // (silent, or more specific) verdict, so ALL four are dropped from the
      // bulk unmapped/advisory listing and from its uncoveredCount — only
      // genuinely-unmatched files remain in it. strictClaimed's own file is
      // still the strict backward scan's business (type-strict-orphan /
      // type-strict-misplaced), unaffected by this filter.
      const spokenFor = new Set<string>(typeCoverage.covered.keys());
      for (const a of typeCoverage.ambiguous) spokenFor.add(a.file);
      for (const s of typeCoverage.strictClaimed) spokenFor.add(s.file);
      for (const u of typeCoverage.unreadable) spokenFor.add(u.file);
      requiredForIssue = tiers.required.filter((f) => !spokenFor.has(f));
      middleForIssue = tiers.middle.filter((f) => !spokenFor.has(f));

      for (const a of typeCoverage.ambiguous) {
        typeLevelIssues.push({
          severity: 'error',
          code: 'ambiguous-node-type',
          rule: 'ambiguous-node-type',
          messageData: {
            what: `File '${a.file}' matches ${a.typeIds.length} classifying types: ${a.typeIds.join(', ')}.`,
            why: `Type-level coverage applies exactly one type's rules per file. Two matching types is a situation the machine refuses to guess — each type carries different rules.`,
            next: `Two exits:\n  1. Create an explicit node declaring the intended type (yg-node.yaml with type: <one of: ${a.typeIds.join(' | ')}>) — its pairs re-key under the owner.\n  2. Narrow one of the overlapping when: predicates in yg-architecture.yaml so exactly one matches — existing verdicts revalidate free.\nEither exit may surface new type-relation-forbidden findings for this file's own imports, now that they join the live gate.`,
          },
        });
      }

      // One issue PER FILE, not per (file, type) pair. "too-large" is not an
      // OS error, so its NEXT offers real exits instead of a permissions fix.
      const unreadableWhy =
        'coverage.type_level requires reading file content to classify an uncovered file — it must not be silently treated as covered, ambiguous, or unmatched.';
      for (const u of typeCoverage.unreadable) {
        const n = u.typeIds.length;
        const typeWord = n === 1 ? 'classifying type' : 'classifying types';
        const typeList = u.typeIds.join(', ');
        if (u.kind === 'too-large') {
          typeLevelIssues.push({
            severity: 'error',
            code: 'file-unreadable',
            rule: 'file-unreadable',
            messageData: {
              what: `Type-level coverage could not classify '${u.file}' against ${n} ${typeWord} (${typeList}) — the file exceeds the content-scan size limit.`,
              why: unreadableWhy,
              next: `Either gitignore the file, add its root to coverage.excluded, or drop the content: atom from ${n === 1 ? 'the type above' : 'the types above'}.`,
            },
          });
        } else {
          typeLevelIssues.push({
            severity: 'error',
            code: 'file-unreadable',
            rule: 'file-unreadable',
            messageData: {
              what: `Type-level coverage could not read '${u.file}' while classifying it against ${n} ${typeWord} (${typeList}).\nOS error: ${u.reason}`,
              why: unreadableWhy,
              next: `Fix file permissions, or add to .gitignore if it's a generated artifact.`,
            },
          });
        }
      }
    }

    let requiredIssue = buildCoverageIssue(requiredForIssue, totalFiles);
    let middleIssue = buildCoverageAdvisoryIssue(middleForIssue);
    if (sawTypeLevel) {
      // Every file left in requiredForIssue/middleForIssue after the
      // spokenFor filter is, by construction, one computeTypeCoverage
      // evaluated and found no type for — the corner that once needed a
      // separate genuinely-unmatched guard is now impossible, since
      // isExcludedByCoverage is the one authority both this tiering and the
      // lattice's own mute go through.
      requiredIssue = enrichNoTypeMessage(requiredIssue);
      middleIssue = enrichNoTypeMessage(middleIssue);
    }
    coverageIssues = [...coverageIssues, requiredIssue, middleIssue, ...typeLevelIssues].filter(
      (x): x is CheckIssue => x !== null,
    );

    // Additive tracked∩gitignored anomaly detection: a git-tracked file positively
    // matched by .gitignore, independent of node mapping. INJECTED real
    // `git ls-files` output — the ONE remaining git consumer in this surface;
    // absent (or the CLI's git probe having failed) SKIPS this check entirely.
    coverageIssues.push(...(options?.trackedFiles ? await scanTrackedButIgnored(graph, options.trackedFiles, coverageVisibleFiles) : []));
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
  // With no git set available (coverageVisibleFiles === null) NO index is written — honest scoping.
  if (options?.writeFeatureIndex && featureFactsByPath && featureHashByPath && coverageVisibleFiles !== null) {
    const includedPaths = new Set(
      excludeNestedGraphSubtrees(coverageVisibleFiles).map((f) => toPosixPath(f.trim())),
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
    typeLevel,
    typeCoveredCount,
    classifyingTypeCount,
    nodeOwnedFiles,
    excludedFiles,
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
 * The calibration instrument behind the hidden `--attention-dump` flag. Runs the
 * relation pass over WARM shards (no new parse — an AST fact cache HIT), computes
 * candidate deviations at the CURRENT `Z_ADMIT`, and returns a plain-language
 * report: each file's raw structural counts grouped by family, outliers marked
 * "worth a closer read". Writes NOTHING, no LLM calls — a read-only lens for
 * re-calibrating the threshold. Returns the formatted string; the CLI prints it
 * and exits 0.
 *
 * `coverageVisibleFiles` scopes the universe to the same tracked, graph-governed
 * set the written index uses (CLI-supplied, same walk the report path uses — core
 * never shells out to git). A gitignored/scratch file under a mapped ancestor
 * directory is never shown.
 */
export async function runAttentionDump(graph: Graph, coverageVisibleFiles: string[]): Promise<string> {
  const projectRoot = path.dirname(graph.rootPath);
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const relResult = await runRelationPass(graph, projectRoot, {
    extractorFor: extractorForLanguage,
    resolvePathToFile: makeResolvePathToFile(projectRoot, ownerOf),
    symbolIndexDir: astCacheDir(graph.rootPath),
  });
  const includedPaths = new Set(
    excludeNestedGraphSubtrees(coverageVisibleFiles).map((f) => toPosixPath(f.trim())),
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
 *   violations, per-issue) → prompt-too-large → log conflict → log
 *   integrity/format → structural → coverage → completeness → any other error
 *   (architecture/strict codes, tracked∩gitignored anomaly — neither has a
 *   dedicated branch; each surfaces its own `next` here).
 *
 * Each lock issue carries its own kind-appropriate `next` in messageData
 * (cached three-exit for an LLM refusal, fix-violations for a deterministic
 * refusal, size remedies for prompt-too-large). With no error remaining,
 * surface the highest-priority warning's `next` — advisory aspect-violation
 * first, else the alphabetically-first warning — so a warnings-only run still
 * points somewhere.
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

  // 5c. ambiguous-node-type (coverage.type_level) — carries its own two-exit
  //     guidance keyed to the FILE (the issue has no nodePath — the file has no
  //     owning node, which is the whole problem). It IS a STRUCTURAL_CODES
  //     member (for the summary tally / --top grouping), but the generic
  //     structural fallback in step 6 below renders `Fix <code> in <nodePath>`,
  //     which for a nodePath-less issue collapses to a useless
  //     `Fix ambiguous-node-type in .yggdrasil` and discards the guidance — so
  //     it is intercepted here first, exactly like the other node/file-specific
  //     `next` codes above it. `.find()` already returns issues in emission
  //     order, which is the alphabetical file order `scanUncoveredFiles` sorts
  //     to, so this is deterministic without an extra tie-break sort.
  const ambiguousNodeType = errors.find(i => i.code === 'ambiguous-node-type');
  if (ambiguousNodeType) return ambiguousNodeType.messageData.next;

  // 6. structural. Pick the alphabetically-first structural CODE (then node),
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

  // 7. coverage.
  if (coverageErrors.length > 0) {
    const count = coverageErrors[0].uncoveredCount ?? 0;
    return `yg context --file <uncovered-path>\n  ${count} file${count === 1 ? '' : 's'} need coverage — bootstrap workflow`;
  }

  // 8. completeness.
  const completenessErrors = errors.filter(i => COMPLETENESS_CODES.has(i.code));
  if (completenessErrors.length > 0) {
    const first = completenessErrors[0];
    return `Fix ${first.code} for ${toPosixPath(first.nodePath ?? '')}\n  1 of ${completenessErrors.length} completeness error${completenessErrors.length === 1 ? '' : 's'} — post-modify workflow`;
  }

  // 9. Any remaining error — architecture/strict codes outside the categories
  //    above (e.g. type-undefined, parent-type-forbidden, mapping-path-missing,
  //    type-strict-*, tracked-file-gitignored). Each carries its own actionable
  //    `next`. Pick the alphabetically-first by code then node — the SAME
  //    tie-break groupIssues uses — so the group bare `yg check --top` renders is
  //    the group this line names even here. Without this the line would be null
  //    while `--top` still rendered that group, breaking the bare-`--top` ==
  //    `Next:` invariant.
  const otherErrors = [...errors].sort((a, b) =>
    a.code.localeCompare(b.code, 'en') ||
    (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
  if (otherErrors.length > 0) return otherErrors[0].messageData.next;

  return null;
}
