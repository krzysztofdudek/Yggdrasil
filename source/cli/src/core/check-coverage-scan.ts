/**
 * source/cli/src/core/check-coverage-scan.ts — the two repo-wide scans the
 * coverage section is built on: which coverage-visible files no node mapping
 * covers, and which committed files are invisible to every enforcement layer
 * because .gitignore hides them from the disk walk.
 *
 * Both take their file lists as ARGUMENTS. Neither walks the filesystem and
 * neither shells out to git — the CLI layer supplies the disk walk, and the one
 * git-derived input (`git ls-files`) is injected into `scanTrackedButIgnored`.
 * That is what keeps the engine free of ambient system state, and it is why
 * either scan can be exercised directly against a file list.
 *
 * Tiering (which uncovered file is an error, a warning, or silently excluded)
 * is NOT decided here — it belongs to the coverage-tier module, which both
 * these scans' consumers and `scanTrackedButIgnored` itself route through, so
 * one exclusion authority answers for every coverage surface.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import { excludeNestedGraphSubtrees, loadRootGitignoreStack, isIgnoredByStack } from '../io/repo-scanner.js';
import type { GitignoreEntry } from '../io/repo-scanner.js';
import { mappingEntryMatchesFile, isGlobPattern, normalizeMappingPath } from '../utils/mapping-path.js';
import { debugWrite } from '../utils/debug-log.js';
import { partitionByCoverageTier } from './check-coverage-tiers.js';
import type { CheckIssue } from './check-contract.js';
import { fileUnit } from '../model/lock.js';

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

  const scopedFiles = excludeNestedGraphSubtrees(coverageVisibleFiles);
  for (const file of scopedFiles) {
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
    unitKey: fileUnit(p),
  });

  return [
    ...tiers.required.map((p) => buildIssue(p, 'error')),
    ...tiers.middle.map((p) => buildIssue(p, 'warning')),
  ];
}
