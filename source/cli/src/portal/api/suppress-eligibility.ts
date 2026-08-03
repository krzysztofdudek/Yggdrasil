import { toPosixPath } from '../../utils/posix.js';
import { mappingEntryMatchesFile, normalizeMappingPath } from '../../utils/mapping-path.js';
import { expandMappingPathsWithinOwnGraph } from '../../io/hash.js';
import { NO_COVERAGE_EXCLUDED, resolveGraphExclusionSet, filterExcludedFromGraph } from '../../io/repo-scanner.js';
import type { Graph, CoverageConfig } from '../../model/graph.js';

/**
 * portal/api/suppress-eligibility — the ONE file-eligibility rule shared by the
 * reviewer-honoring path and the `yg suppressions` audit inventory, split out of
 * the scan module so neither file grows past its focused boundary and the rule
 * lives in exactly one place.
 *
 * A real `yg-suppress` waiver lives in a SOURCE file that an aspect verifies —
 * the reviewer honors the marker there. Generated rules mirrors, per-node logs,
 * and prose docs only ever MENTION the marker syntax; they are not code an aspect
 * checks, so their marker-shaped text is noise, not a waiver. Exclude them so the
 * inventory lists only genuine code-side waivers.
 *
 * The noise filter applies ONLY to a file that is neither of the two ways a real
 * aspect verdict can land on it. Both exemptions below cover the ENTIRE universe
 * `computeExpectedPairs` draws pairs from — a mapped node source, or (under
 * `coverage.type_level`) a file matched by exactly one non-strict architecture
 * type with no node of its own — so no file that can actually produce a verdict
 * is ever noise:
 *  - a mapped node source is never noise — the reviewer-honoring path raw-scans
 *    any mapped grammarless file, so a marker there is a LIVE waiver.
 *  - a type-covered file (the type-level classification lattice's `covered`
 *    bucket — a single non-strict type matched, no node) is never noise either,
 *    for the identical reason: its type's `per: file` aspects run against it
 *    exactly as they would against a mapped source, and honor its markers the
 *    same way. A file the lattice puts in `strictClaimed`, `ambiguous`, or
 *    `unreadable` is NOT exempted here — each of those is a blocking
 *    architecture ERROR (type-strict-orphan/misplaced, ambiguous-node-type,
 *    file-unreadable) that stops any aspect from ever running there, so a
 *    marker on such a file (unless it is separately a mapped source) waives
 *    nothing and stays correctly excluded as noise.
 * Scoping the exclusion this way keeps the honoring path and the audit path on
 * ONE eligibility rule, so no file can be a live waiver site while being
 * invisible to `yg suppressions`.
 *
 * Excluded (only when NOT a mapped source and NOT a type-covered file):
 *  - everything under `.yggdrasil/` — the graph's per-node `log.md`, aspect
 *    `content.md`, and `yg-node.yaml` examples. A meta-modeling doc mapped
 *    under `.yggdrasil/` IS a mapped source and so is exempt from this
 *    exclusion — but exemption alone is not enough to make it inventoried:
 *    the caller must also present the file to this function at all, which
 *    means drawing the scan's candidate list from `computeSuppressionScanUniverse`
 *    below rather than a plain repo walk. See that function's own comment for
 *    why a repo walk alone can never reach such a file.
 *  - a file whose base name is exactly `.clinerules` (Cline's legacy
 *    single-file convention, no extension) — matched by base name only, so
 *    this does NOT match `.clinerules/yggdrasil.md`, the directory form
 *    `yg init` writes today; that file is excluded separately below, by the
 *    `.md` prose filter. `.cursor/...`, `.windsurfrules`, and
 *    `.github/copilot-*` are NOT written by `yg init` any more (that
 *    per-platform installer set was retired); they are kept in the
 *    exclusion only because a repo may still carry one from an older CLI or
 *    from the other tool itself, and either way such a file is prose, never
 *    a code waiver site.
 *  - any `log.md` anywhere (per-node history is prose, never a waiver site).
 *  - prose/doc files (`.md`, `.mdc`, `.markdown`, `.txt`) — this also covers
 *    the generated `AGENTS.md` digest block, the `CLAUDE.md` `@AGENTS.md`
 *    import, and `.clinerules/yggdrasil.md` itself: documentation and
 *    changelogs describe markers, they are not code an aspect checks.
 */
export function isNoiseFile(relFile: string): boolean {
  const p = toPosixPath(relFile);

  // .yggdrasil/ — generated rules, logs, aspect content, node yaml.
  if (p === '.yggdrasil' || p.startsWith('.yggdrasil/')) return true;

  // Legacy per-platform rules mirrors — no longer written by `yg init` (that
  // installer set was retired); kept only in case an older CLI or the other
  // tool itself still leaves one behind.
  if (p.startsWith('.cursor/')) return true;
  if (p.startsWith('.github/copilot')) return true;
  const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
  // A file named exactly `.clinerules` (Cline's legacy single-file
  // convention) — not the `.clinerules/` directory `yg init` writes today;
  // `.clinerules/yggdrasil.md` is excluded separately below, by the `.md`
  // prose filter.
  if (base === '.windsurfrules' || base === '.clinerules') return true;

  // Per-node history is prose, never a real waiver site.
  if (base === 'log.md') return true;

  // Prose / documentation — describes marker syntax, not aspect-checked code.
  const lower = base.toLowerCase();
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.mdc') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.txt')
  ) {
    return true;
  }

  return false;
}

/**
 * Every node mapping entry in the graph, normalized to POSIX. A coverage-visible file
 * that matches one is a mapped node SOURCE — a file an aspect verifies and whose
 * in-source `yg-suppress` marker the reviewer honors — so the inventory must list
 * its markers regardless of extension. The two production callers (`yg suppressions`
 * and the portal) both derive this so the honoring path and the audit path share
 * one file-eligibility rule.
 */
export function collectMappingEntries(graph: Graph): string[] {
  const entries: string[] = [];
  for (const node of graph.nodes.values()) {
    for (const raw of node.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) entries.push(p);
    }
  }
  return entries;
}

/** True when `relFile` is covered by a node's mapping (a honored-waiver site). */
export function isMappedSource(relFile: string, mappingEntries: string[]): boolean {
  const p = toPosixPath(relFile);
  return mappingEntries.some((entry) => mappingEntryMatchesFile(entry, p));
}

/**
 * Reduce a type-coverage classification's `covered` map (file -> matched typeId,
 * from `computeTypeCoverage`/`TypeCoverageResult`/`TypeCoverageInput`) to the
 * plain file-path set `isTypeCoveredSource` consumes. Every caller that already
 * holds that classification (or has `coverage.type_level` off, in which case
 * `covered` is absent) derives its eligibility input through this one function,
 * so the reduction step itself cannot drift between the four call sites (`yg
 * suppressions`, `yg aspects --health`, `yg advise`, and the portal).
 */
export function collectTypeCoveredFiles(covered: ReadonlyMap<string, string> | undefined): Set<string> {
  return new Set(covered?.keys() ?? []);
}

/**
 * True when `relFile` is a file the type-level classification lattice matched
 * to exactly one non-strict architecture type (`computeTypeCoverage`'s
 * `covered` bucket) — a honored-waiver site exactly like a mapped source, per
 * this module's header. Matching is exact-path membership, not a glob: the
 * lattice already resolved each file to at most one covering type, so there is
 * no pattern left to re-match here.
 */
export function isTypeCoveredSource(relFile: string, typeCoveredFiles: ReadonlySet<string>): boolean {
  return typeCoveredFiles.has(toPosixPath(relFile));
}

/**
 * The scan's complete candidate file list — every path a real `yg-suppress`
 * marker can be LIVE on, full stop. This is the current, checkable definition
 * of "a file that can host a live marker"; extending it belongs here, in one
 * place, not as a special case added to `isNoiseFile` or to an individual
 * caller.
 *
 * A repo walk (`walkRepoFiles`) answers a DIFFERENT question — "what needs
 * coverage" — and is deliberately narrower than this: it prunes the top-level
 * `.yggdrasil/` directory (the graph's own internal state, irrelevant to
 * coverage) and drops any `.gitignore`-matched path. Neither exclusion says
 * anything about whether the reviewer actually reads and honors markers in a
 * given file — a node's `mapping:` entry can name a file in either place, and
 * the deterministic/structure runner reads it regardless (an exact-file
 * mapping entry is reviewed unconditionally, gitignore or not; see the
 * `file-mapping-gitignored` check for why that is intentional). Passing a
 * plain repo walk to the scan is therefore not a smaller inventory, it is a
 * WRONG one: a marker on such a file is honored by the runner and invisible
 * to the audit at the same time.
 *
 * The complete universe is the union of two sets, both already exactly the
 * ones the runner itself draws its own file set from:
 *  - `walkedFiles` — the repo walk, unmodified. Every file the type-coverage
 *    lattice can ever classify into its `covered` bucket is drawn from this
 *    same walk (a file under `.yggdrasil/` can never be type-covered — the
 *    coverage scan skips it outright), so a type-covered waiver site is
 *    always already a member of this set and needs no separate union step.
 *  - every concrete file EVERY node's `mapping:` entries resolve to, computed
 *    here with `expandMappingPathsWithinOwnGraph` — the exact same function
 *    `core/pairs.ts` and the structure runner (`structure/hook-loader.ts`,
 *    `structure/allowed-reads.ts`) use to build a node's own reviewed file
 *    set and review content. This is the piece `walkedFiles` cannot stand in
 *    for, for the two structural reasons above.
 *
 * One guard applies to the second member alone: a directory (or glob) mapping
 * entry can resolve into a SUBTREE that is its own separate project — its own
 * nested `.yggdrasil/` graph, or its own `.git` checkout/submodule/worktree —
 * the same structural case `walkedFiles` already excludes (`walkRepoFiles`
 * prunes it during the walk, against `io/repo-scanner.ts`'s
 * `findNestedProjectRoots`). `expandMappingPathsWithinOwnGraph` filters
 * against that SAME filesystem-derived root set — not a second
 * implementation of the same guard, and not derived from either caller's own
 * candidate list — so this audit and the runner it audits can never disagree
 * about which files belong to a nested checkout, however differently each
 * side's mapping entries expand. Without it, a broad directory mapping that
 * happens to contain an unrelated nested checkout would attribute THAT
 * checkout's own markers to this graph's audit — a foreign-graph leak, not a
 * live waiver on this graph's own code.
 *
 * If a future change gives the runner a THIRD way to read and honor a marker
 * in a file — a new kind of reference resolved through neither a node's
 * mapping nor the type-coverage lattice — this function's union must grow to
 * match, or the audit drifts from enforcement again exactly as it did for the
 * two cases above.
 */
export async function computeSuppressionScanUniverse(
  projectRoot: string,
  walkedFiles: readonly string[],
  mappingEntries: readonly string[],
  coverage: CoverageConfig = NO_COVERAGE_EXCLUDED,
): Promise<string[]> {
  // `walkedFiles` is an ordinary repo walk (walkRepoFiles): it already prunes a
  // nested project's own boundary, but NOT an adopter's `coverage.excluded`
  // config — that root list is unknown to the walk itself. Filter the base list
  // through the same one supreme exclusion authority the mapped-file union
  // below already uses, so a `coverage.excluded` file that would otherwise
  // reach this universe only because it happens to be an ordinary tracked file
  // (never swept in by any mapping) is gone here too — no audit entry for an
  // excluded path, exactly like no coverage complaint and no enforcement pair.
  const exclusion = await resolveGraphExclusionSet(projectRoot, coverage);
  const universe = filterExcludedFromGraph(walkedFiles.map(toPosixPath), exclusion);
  const seen = new Set(universe);
  const rawMappedFiles = await expandMappingPathsWithinOwnGraph(projectRoot, [...mappingEntries], coverage);
  const mappedFiles = rawMappedFiles.map(toPosixPath);
  for (const p of mappedFiles) {
    if (!seen.has(p)) {
      seen.add(p);
      universe.push(p);
    }
  }
  return universe;
}
