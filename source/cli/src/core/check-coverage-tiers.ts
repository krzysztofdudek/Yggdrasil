import type { CoverageConfig } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
import { mappingEntryMatchesFile, normalizeMappingPath } from '../utils/mapping-path.js';
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
 * Split uncovered files into the error tier (longest match in `required`) and the
 * warning tier (no match). Files whose longest match is in `excluded` are dropped.
 * On an equal-length tie between required and excluded, excluded wins.
 */
export function partitionByCoverageTier(
  uncovered: string[],
  coverage: CoverageConfig,
): { required: string[]; middle: string[] } {
  const req = coverage.required.map(normalizeRoot);
  const exc = coverage.excluded.map(normalizeRoot);
  const required: string[] = [];
  const middle: string[] = [];
  for (const f of uncovered) {
    let best = { len: -1, tier: 'middle' as 'required' | 'excluded' | 'middle' };
    for (const r of req) if (matchesRoot(f, r) && r.length > best.len) best = { len: r.length, tier: 'required' };
    for (const r of exc) if (matchesRoot(f, r) && r.length >= best.len) best = { len: r.length, tier: 'excluded' };
    if (best.tier === 'required') required.push(f);
    else if (best.tier === 'middle') middle.push(f);
    // 'excluded' → silent
  }
  return { required, middle };
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
      what: `${uncoveredFiles.length} tracked file${uncoveredFiles.length === 1 ? '' : 's'} outside any required coverage root.\n${body}`,
      why: 'Not under a coverage.required root — visible but non-blocking. Bring an area under graph coverage to enforce it.',
      next: 'Map these files to a node, or add their root to coverage.required to make this an error.',
    },
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}
