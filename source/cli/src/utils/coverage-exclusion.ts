import type { CoverageConfig } from '../model/graph.js';
import { toPosixPath } from './posix.js';
import { mappingEntryMatchesFile } from './mapping-path.js';

/**
 * Normalize a coverage root: POSIX, no leading/trailing slash, collapse
 * internal double-slashes. "/" -> "" (whole repo).
 */
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
 * glob) — the adopter-configured half of the one supreme exclusion filter (see
 * `io/repo-scanner.ts`'s `isExcludedFromGraph`, which combines this with the
 * filesystem-derived nested-project boundary and the always-off-limits
 * structural paths into the single authority every caller asks). Exclusion is
 * ABSOLUTE and applies to every path it matches, including a node's own
 * explicit `mapping:` entry: a node mapping a file, a whole directory, or a
 * glob that resolves into an excluded root gets nothing back for that portion
 * of the mapping — the mapping claim does not outrank the exclusion. It has NO
 * opinion on a required root also matching — exclusion wins regardless.
 *
 * Lives in `utils/` (not `core/`) so the persistence-adapter layer
 * (`io/hash.ts`, `io/repo-scanner.ts`) can call it directly while expanding a
 * mapping to real files, instead of re-deriving exclusion after the fact —
 * one predicate, reachable from both the engine and the I/O layer that needs
 * it to filter file lists as they are built. `core/check-coverage-tiers.ts`
 * re-exports this (plus `normalizeRoot`/`matchesRoot`) so existing importers
 * are unaffected by where the implementation lives.
 */
export function isExcludedByCoverage(file: string, coverage: CoverageConfig): boolean {
  return coverage.excluded.map(normalizeRoot).some((r) => matchesRoot(file, r));
}
