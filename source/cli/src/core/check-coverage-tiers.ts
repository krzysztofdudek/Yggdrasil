import type { CoverageConfig } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
import { mappingEntryMatchesFile, normalizeMappingPath, isGlobPattern } from '../utils/mapping-path.js';
// type-only import — erased at runtime, no circular runtime dependency
import type { CheckIssue } from './check.js';

/** Normalize a coverage root: POSIX, no leading/trailing slash, collapse internal double-slashes. "/" → "" (whole repo). */
export function normalizeRoot(root: string): string {
  return toPosixPath(root.trim()).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}

/**
 * A normalized root R matches file F iff R is "" (whole repo), or R covers F.
 * "Covers" uses the same semantics as a node mapping entry: a plain root is an
 * exact file match or a directory prefix (F === R or F under R/); a glob root
 * (one containing glob metacharacters) matches via minimatch — a single star
 * stays within one path segment, a double star spans segments. So an excluded
 * glob root can drop generated files anywhere in the tree, and a required glob
 * root can scope the blocking tier to a pattern rather than a whole directory.
 */
export function matchesRoot(file: string, normRoot: string): boolean {
  return normRoot === '' || mappingEntryMatchesFile(normRoot, file);
}

/**
 * True iff `file` matches ANY normalized root in `coverage.excluded` (plain or
 * glob). Exclusion is ABSOLUTE: this predicate is the ONE authority every
 * nodeless-tier consumer asks the same question through, so a file's excluded
 * status can never disagree between them — directly for the classification
 * lattice, coverage tiering, and the tracked∩gitignored anomaly check; INDIRECTLY
 * for the live type-relation gate (Task 4), which never calls this predicate
 * itself but consumes `computeTypeCoverage`'s already-filtered `covered` map —
 * an excluded file is never a member of that map, so it can never become a gate
 * endpoint either, without the gate needing its own exclusion check. It has NO
 * opinion on a required root also matching — exclusion wins regardless. An
 * EXPLICITLY-MAPPED file (a node's own `mapping:` entry) never reaches this
 * function at all — mapping is stronger intent than exclusion, and pair
 * enumeration for explicit nodes (core/pairs.ts) has no dependency on
 * coverage.excluded.
 */
export function isExcludedByCoverage(file: string, coverage: CoverageConfig): boolean {
  return coverage.excluded.map(normalizeRoot).some((r) => matchesRoot(file, r));
}

/**
 * Split uncovered files into the error tier (matches a `required` root) and the
 * warning tier (matches none). A file matching ANY `excluded` root is dropped
 * BEFORE this split runs at all — exclusion is absolute, independent of whether
 * a required root also matches and independent of how specific either root is.
 * Required/middle among the surviving files needs no length comparison: ANY
 * required-root match is sufficient (there is nothing left to break a tie
 * against, since excluded files never reach this point).
 */
export function partitionByCoverageTier(
  uncovered: string[],
  coverage: CoverageConfig,
): { required: string[]; middle: string[] } {
  const req = coverage.required.map(normalizeRoot);
  const required: string[] = [];
  const middle: string[] = [];
  for (const f of uncovered) {
    if (isExcludedByCoverage(f, coverage)) continue;
    if (req.some((r) => matchesRoot(f, r))) required.push(f);
    else middle.push(f);
  }
  return { required, middle };
}

/**
 * A required root that can never match a file, because every file it could
 * match also matches an excluded root — a dead config line. Only decided for
 * PLAIN roots on both sides (glob-vs-glob containment is not statically
 * decidable from the pattern text alone; documented in configuration.md
 * instead of guessed here). One warning per shadowed required root, even if
 * multiple excluded roots would each independently shadow it.
 */
export function checkRequiredShadowedByExcluded(coverage: CoverageConfig): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const rawRequired of coverage.required) {
    const req = normalizeRoot(rawRequired);
    if (isGlobPattern(req)) continue;
    for (const rawExcluded of coverage.excluded) {
      const exc = normalizeRoot(rawExcluded);
      if (isGlobPattern(exc)) continue;
      const shadowed = exc === '' || req === exc || req.startsWith(exc + '/');
      if (!shadowed) continue;
      issues.push({
        severity: 'warning',
        code: 'coverage-required-shadowed',
        rule: 'coverage-required-shadowed',
        messageData: {
          what: `Required coverage root '${rawRequired}' is fully inside excluded root '${rawExcluded}'.`,
          why: 'Exclusion is absolute: any file under this required root also matches the excluded root and is silenced before it is ever sorted into the blocking or advisory tier. This required line can never make a file block.',
          next: `Remove the required line for '${rawRequired}', or narrow the excluded root '${rawExcluded}' so it no longer contains it.`,
        },
      });
      break;
    }
  }
  return issues;
}

/**
 * Of `paths`, the ones a `yg check` would raise as BLOCKING unmapped-file
 * errors: covered by no node mapping AND landing in the required coverage
 * tier. Answered here, against the same two primitives the check itself uses,
 * so a caller can never approximate the rule with its own copy and disagree
 * with the gate it is predicting.
 *
 * Written for one caller with one question: `yg init`, having just written the
 * agent-rules files into a project's root, asking whether THAT project's
 * coverage settings will now turn them red. A project that requires its whole
 * tree (the default when no coverage block is written) does exactly that, and
 * before this the first sign of it was a failing check with a fix line pointing
 * at node ownership rather than at excluding repository plumbing.
 */
export function blockingUnmappedPaths(
  paths: readonly string[],
  mappingEntries: readonly string[],
  coverage: CoverageConfig,
): string[] {
  const entries = mappingEntries.map(normalizeMappingPath).filter((e) => e !== '');
  const unmapped = paths
    .map((p) => toPosixPath(p))
    .filter((p) => !entries.some((entry) => mappingEntryMatchesFile(entry, p)));
  return partitionByCoverageTier(unmapped, coverage).required;
}

/**
 * Build the unmapped-files CheckIssue from uncovered files.
 * Aggregates into one error with count + sample.
 */
export function buildCoverageIssue(uncoveredFiles: string[], totalGitFiles: number): CheckIssue | null {
  if (uncoveredFiles.length === 0) return null;

  const sampleSize = 5;
  const sample = uncoveredFiles.slice(0, sampleSize);
  const remaining = uncoveredFiles.length - sample.length;

  // Learning tip for cold start
  const coveragePct = totalGitFiles > 0
    ? ((totalGitFiles - uncoveredFiles.length) / totalGitFiles) * 100
    : 100;

  let coverageMd;
  if (uncoveredFiles.length <= sampleSize) {
    // Small count: files listed directly, guidance after
    coverageMd = {
      what: `${uncoveredFiles.length} source file${uncoveredFiles.length === 1 ? '' : 's'} not covered by any node.\n${sample.map(f => '  ' + f).join('\n')}`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `Check ownership candidates: yg context --file <path>\nThen: add to existing node mapping, or create a new node.`,
    };
  } else {
    // Large count: guidance BEFORE examples (per CLI messages spec)
    const guidance = coveragePct < 50
      ? 'Establish coverage: create nodes for active areas first, expand coverage incrementally.'
      : 'Add to an existing node mapping, or create a new node.';
    coverageMd = {
      what: `${uncoveredFiles.length} source files have no graph coverage.\nExamples:\n${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining} more`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `${guidance}\nCheck ownership candidates: yg context --file <path>`,
    };
  }

  return {
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    messageData: coverageMd,
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}

/** Build the non-blocking 'uncovered-advisory' warning for the middle tier. */
export function buildCoverageAdvisoryIssue(uncoveredFiles: string[]): CheckIssue | null {
  if (uncoveredFiles.length === 0) return null;
  const sample = uncoveredFiles.slice(0, 5);
  const remaining = uncoveredFiles.length - sample.length;
  const body = uncoveredFiles.length <= 5
    ? sample.map(f => '  ' + f).join('\n')
    : `${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining} more`;
  return {
    severity: 'warning',
    code: 'uncovered-advisory',
    rule: 'uncovered-advisory',
    messageData: {
      what: `${uncoveredFiles.length} coverage-visible file${uncoveredFiles.length === 1 ? '' : 's'} outside any required coverage root.\n${body}`,
      why: 'Not under a coverage.required root — visible but non-blocking. Bring an area under graph coverage to enforce it.',
      next: 'Map these files to a node, or add their root to coverage.required to make this an error.',
    },
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}
